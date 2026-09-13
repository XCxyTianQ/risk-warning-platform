/**
 * bench/lib/llm.js —— 真实模型配置解析（**绝不把 Key 写进仓库或报告**）。
 *
 * 解析顺序：
 *   1. 环境变量 RWP_LLM_API_KEY / RWP_LLM_BASE_URL / RWP_LLM_MODEL（CI 用 secret）
 *   2. Key 文件：RWP_BENCH_KEY_FILE → ~/Desktop/KEY.txt → ~/Desktop/KEY-Linux.txt → <repo>/KEY.txt
 *      （文件里可以有说明文字，只取第一个 sk- 开头的串）
 *   3. 兜底默认：baseUrl=https://api.deepseek.com/v1，model=deepseek-flash
 *
 * 报告里只记录 baseUrl / model / key 来源与前 4 位掩码，便于复核"用的是哪个模型"。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1'
const DEFAULT_MODEL = 'deepseek-flash'

/** 从任意文本里挑出 API Key：优先 sk- 开头的串，其次第一行非空内容 */
function pickKey(text) {
  const cleaned = String(text || '').replace(/\uFEFF/g, '')
  const sk = cleaned.match(/sk-[A-Za-z0-9_\-]{8,}/)
  if (sk) return sk[0]
  const line = cleaned
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s && !s.startsWith('#') && !s.includes('='))
  return line || ''
}

function keyFileCandidates(repo) {
  const list = []
  if (process.env.RWP_BENCH_KEY_FILE) list.push(process.env.RWP_BENCH_KEY_FILE)
  const home = os.homedir()
  list.push(path.join(home, 'Desktop', 'KEY.txt'))
  list.push(path.join(home, 'Desktop', 'KEY-Linux.txt'))
  list.push(path.join(home, 'KEY.txt'))
  list.push(path.join(repo, 'KEY.txt'))
  return list
}

/**
 * @returns {{ready:boolean, apiKey:string, baseUrl:string, model:string, keySource:string, mask:string, tried:string[]}}
 */
function resolveLlm(repo, { model } = {}) {
  let apiKey = (process.env.RWP_LLM_API_KEY || process.env.DEEPSEEK_API_KEY || '').trim()
  let keySource = apiKey ? 'env:RWP_LLM_API_KEY' : ''
  const tried = []

  if (!apiKey) {
    for (const file of keyFileCandidates(repo)) {
      tried.push(file)
      try {
        if (!fs.existsSync(file)) continue
        const key = pickKey(fs.readFileSync(file, 'utf8'))
        if (key) {
          apiKey = key
          keySource = file
          break
        }
      } catch {
        /* 读不到就继续找下一个 */
      }
    }
  }

  const baseUrl = (process.env.RWP_LLM_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const resolvedModel = (model || process.env.RWP_LLM_MODEL || DEFAULT_MODEL).trim()
  return {
    ready: !!apiKey,
    apiKey,
    baseUrl,
    model: resolvedModel,
    keySource,
    mask: apiKey ? `${apiKey.slice(0, 6)}…${apiKey.slice(-4)}` : '',
    tried,
  }
}

/** 传给后端/参考实现的环境变量（只在这一层出现完整 Key） */
function llmEnv(llm) {
  return {
    RWP_LLM_BASE_URL: llm.baseUrl,
    RWP_LLM_API_KEY: llm.apiKey,
    RWP_LLM_MODEL: llm.model,
  }
}

/** 报告用的脱敏描述 */
function describeLlm(llm) {
  return { baseUrl: llm.baseUrl, model: llm.model, keySource: llm.keySource, keyMask: llm.mask }
}

module.exports = { DEFAULT_BASE_URL, DEFAULT_MODEL, describeLlm, llmEnv, pickKey, resolveLlm }
