/**
 * 外部基准数据获取层：带磁盘缓存 + sha256 版本锁。
 *
 * 设计约束（与本项目 bench/dataset 一致）：
 *  - 原始数据不进仓库（体积/许可），只把"清单 + 哈希"入库；
 *  - 同一 URL 命中缓存后不再联网，保证"同一次评测可复现"；
 *  - 所有断言都基于真实字节，不允许任何"凭印象填数"。
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const dns = require('node:dns')
try { dns.setDefaultResultOrder('ipv4first') } catch {}

const CACHE_DIR = path.join(__dirname, '..', 'cache')
const RAW_DIR = path.join(CACHE_DIR, 'raw')

const UA = { 'User-Agent': 'Mozilla/5.0 (rwp-bench external-benchmark)' }

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); return d }

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex') }

/** GitHub 仓库内文件的直链（走 CDN，不消耗 API 限额） */
function ghRaw(repo, ref, filePath) {
  return `https://raw.githubusercontent.com/${repo}/${ref}/${filePath.split('/').map(encodeURIComponent).join('/')}`
}
/** 仓库内文件的 HTML 页面（写进报告供人复查） */
function ghBlob(repo, ref, filePath) {
  return `https://github.com/${repo}/blob/${ref}/${filePath}`
}

/** 缓存文件名：把 repo 路径摊平成一层，保留目录语义便于人工排查。
 *  扩展名以 key 自带的为准（key 是我们定的逻辑名），key 没有才用 URL 的——
 *  否则会遇到 "xxx.jsonl" + URL 结尾 ".json" 拼成 "xxx.jsonl.json" 的缓存错位。 */
function cacheName(key, url) {
  const safeKey = key.replace(/[^\w.\-]+/g, '_').slice(0, 120)
  if (/\.[a-z0-9]{1,8}$/i.test(safeKey)) return safeKey
  const ext = (String(url).split('?')[0].match(/\.[a-z0-9]{1,8}$/i) || [''])[0]
  return safeKey + ext
}

/**
 * 取一个文件（文本或二进制），命中缓存则零网络。
 * @returns {{key,url,path,bytes,sha256,fromCache,fetchedAt}}
 */
async function fetchToCache(key, url, opts = {}) {
  const { force = false, binary = false, retries = 3, timeoutMs = 120000 } = opts
  const file = path.join(RAW_DIR, cacheName(key, url))
  const metaFile = file + '.meta.json'

  if (!force && fs.existsSync(file) && fs.existsSync(metaFile)) {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
    const buf = fs.readFileSync(file)
    if (buf.length === meta.bytes) return { ...meta, fromCache: true }
  }

  ensureDir(RAW_DIR)
  let lastErr
  for (let i = 0; i < retries; i++) {
    try {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), timeoutMs)
      const res = await fetch(url, { headers: UA, signal: ac.signal })
      clearTimeout(timer)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      fs.writeFileSync(file, buf)
      const meta = {
        key,
        url,
        path: path.relative(path.join(__dirname, '..', '..', '..'), file).replace(/\\/g, '/'),
        bytes: buf.length,
        sha256: sha256(buf),
        binary,
        fetchedAt: new Date().toISOString(),
      }
      fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2))
      return { ...meta, fromCache: false }
    } catch (e) {
      lastErr = e
      await new Promise((r) => setTimeout(r, 500 * (i + 1)))
    }
  }
  throw new Error(`下载失败 ${key} <- ${url}: ${lastErr && lastErr.message}`)
}

async function fetchText(key, url, opts) {
  const meta = await fetchToCache(key, url, opts)
  return { ...meta, text: fs.readFileSync(path.join(process.cwd(), meta.path), 'utf8') }
}
async function fetchJson(key, url, opts) {
  const r = await fetchText(key, url, opts)
  return { ...r, json: JSON.parse(r.text) }
}
/** jsonl：逐行解析，空行忽略；返回 {rows, badLines} */
function parseJsonl(text) {
  const rows = []
  let bad = 0
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line)) } catch { bad++ }
  }
  return { rows, badLines: bad }
}

/** 极简 TSV/CSV 解析（带引号与双引号转义），够用于这些基准的题目文件 */
function parseDelimited(text, delim) {
  const rows = []
  let row = []
  let field = ''
  let inQ = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else inQ = false
      } else field += c
    } else if (c === '"') inQ = true
    else if (c === delim) { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (c !== '\r') field += c
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  return rows
}

/** 成对读取：首行表头 + 对象数组 */
function parseTable(text, delim) {
  const raw = parseDelimited(text, delim).filter((r) => r.length > 1 || (r[0] || '').trim() !== '')
  if (!raw.length) return { header: [], rows: [] }
  const header = raw[0].map((h) => h.trim())
  const rows = raw.slice(1).map((r) => {
    const o = {}
    header.forEach((h, i) => { o[h] = r[i] === undefined ? '' : r[i] })
    return o
  })
  return { header, rows }
}

function listCache() {
  if (!fs.existsSync(RAW_DIR)) return []
  return fs.readdirSync(RAW_DIR).filter((f) => f.endsWith('.meta.json')).map((f) => JSON.parse(fs.readFileSync(path.join(RAW_DIR, f), 'utf8')))
}

/** 已缓存文件的本地绝对路径（不存在则抛错，避免静默读到空数据） */
function rawPath(key, url = '') {
  const file = path.join(RAW_DIR, cacheName(key, url))
  if (!fs.existsSync(file)) throw new Error(`缓存缺失：${key}（先跑 node bench/external/prepare.js）`)
  return file
}
/** 已缓存文件的文本内容 */
function rawText(key, url = '') { return fs.readFileSync(rawPath(key, url), 'utf8') }
function rawMeta(key, url = '') {
  const f = rawPath(key, url) + '.meta.json'
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null
}

module.exports = { CACHE_DIR, RAW_DIR, UA, ensureDir, sha256, ghRaw, ghBlob, fetchToCache, fetchText, fetchJson, parseJsonl, parseDelimited, parseTable, listCache, cacheName, rawPath, rawText, rawMeta }
