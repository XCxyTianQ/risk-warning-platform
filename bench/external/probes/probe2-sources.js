/**
 * 第二轮探测：不只看"仓库在不在"，而是看"题目文件能不能真的拿到"。
 * 覆盖：GitHub 仓库树、HF 镜像回退、LLM 侧可用模型（横向对比表需要 ≥2 个模型）。
 */
const dns = require('node:dns')
try { dns.setDefaultResultOrder('ipv4first') } catch {}

const UA = { 'User-Agent': 'Mozilla/5.0 (rwp-bench external-benchmark probe)' }

async function get(url, asJson) {
  const t0 = Date.now()
  try {
    const res = await fetch(url, { headers: UA })
    const text = await res.text()
    return { status: res.status, text, ms: Date.now() - t0, json: asJson ? safe(text) : null }
  } catch (e) {
    return { status: 0, text: '', ms: Date.now() - t0, err: String(e.message || e) }
  }
}
function safe(t) { try { return JSON.parse(t) } catch { return null } }

function report(label, r, extra) {
  const ok = r.status === 200
  const size = r.text ? (r.text.length / 1024).toFixed(1) + 'KB' : '-'
  console.log(`${ok ? '✅' : '❌'} ${label.padEnd(44)} ${String(r.status).padStart(4)} ${size.padStart(10)} ${String(r.ms + 'ms').padStart(7)}  ${(extra || r.err || '').slice(0, 110)}`)
  return ok
}

// 只看数据类文件，避免把 README/图片刷屏
const DATA_RE = /\.(json|jsonl|csv|xlsx?|parquet|zip|tsv)$/i

function treeSummary(tree, limit = 8) {
  const data = tree.filter((x) => DATA_RE.test(x.path))
  const bySize = data.slice().sort((a, b) => (b.size || 0) - (a.size || 0))
  const top = bySize.slice(0, limit).map((x) => `${x.path}(${((x.size || 0) / 1024).toFixed(0)}KB)`)
  return `数据文件 ${data.length} 个；最大：${top.join(', ')}`
}

async function probeTree(label, repo, branchHint) {
  for (const br of branchHint ? [branchHint] : ['main', 'master']) {
    const r = await get(`https://api.github.com/repos/${repo}/git/trees/${br}?recursive=1`, true)
    if (r.status === 200 && r.json && r.json.tree) {
      report(`${label} [${repo}@${br}]`, r, treeSummary(r.json.tree))
      return r.json.tree
    }
    if (r.status !== 404) { report(`${label} [${repo}@${br}]`, r, r.json && r.json.message); return null }
  }
  console.log(`❌ ${label.padEnd(44)}  404  (main/master 均无)`)
  return null
}

async function headSize(label, url) {
  const t0 = Date.now()
  try {
    const res = await fetch(url, { headers: UA, method: 'HEAD' })
    const len = res.headers.get('content-length')
    const ok = res.status === 200
    console.log(`${ok ? '✅' : '❌'} ${label.padEnd(44)} ${String(res.status).padStart(4)} ${(len ? (len / 1024).toFixed(1) + 'KB' : '-').padStart(10)} ${String(Date.now() - t0 + 'ms').padStart(7)}`)
    return ok
  } catch (e) {
    console.log(`❌ ${label.padEnd(44)}    -          -        -  ${String(e.message || e).slice(0, 90)}`)
    return false
  }
}

;(async () => {
  console.log('=== 1. GitHub 仓库树：题目文件是否随仓库分发 ===')
  await probeTree('CFLUE', 'aliyun/cflue')
  await probeTree('FinEval', 'SUFE-AIFLM-Lab/FinEval')
  await probeTree('FinanceBench', 'patronus-ai/financebench')
  await probeTree('OmniDocBench', 'opendatalab/OmniDocBench')
  await probeTree('BFCL(gorilla)', 'ShishirPatil/gorilla')

  console.log('\n=== 2. HuggingFace 镜像回退（官方域名不可达时） ===')
  const HF_FILES = [
    ['CFBenchmark', 'TongjiFinLab/CFBenchmark'],
    ['FinBen', 'TheFinAI/FinBen'],
    ['FinEval', 'SUFE-AIFLM-Lab/FinEval'],
    ['OmniDocBench', 'opendatalab/OmniDocBench'],
  ]
  for (const [name, id] of HF_FILES) {
    await headSize(`hf-mirror ${name}`, `https://hf-mirror.com/api/datasets/${id}`)
  }
  await headSize('hf-mirror 连通性(模型API)', 'https://hf-mirror.com/api/models/deepseek-ai/DeepSeek-V3')

  console.log('\n=== 3. LLM 侧：横向对比表需要 ≥ 2 个模型 ===')
  const fs = require('node:fs')
  const keyPath = process.env.RWP_LLM_KEY_FILE || 'C:\\Users\\admin\\Desktop\\KEY.txt'
  let key = ''
  try {
    key = fs.readFileSync(keyPath, 'utf8').match(/sk-[A-Za-z0-9]+/)?.[0] || ''
  } catch (e) { console.log(`   读不到 ${keyPath}: ${e.message}`) }
  if (!key) { console.log('❌ 无 API Key，跳过模型探测'); return }
  const base = process.env.RWP_LLM_BASE || 'https://api.deepseek.com/v1'
  const t0 = Date.now()
  try {
    const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } })
    const j = await res.json()
    const ids = (j.data || []).map((m) => m.id)
    console.log(`✅ ${'可用模型列表'.padEnd(44)} ${String(res.status).padStart(4)} ${String(Date.now() - t0 + 'ms').padStart(7)}  ${ids.join(', ') || JSON.stringify(j).slice(0, 80)}`)
  } catch (e) {
    console.log(`❌ 可用模型列表 ${e.message}`)
  }
})()
