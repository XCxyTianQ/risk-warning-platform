/**
 * 外部基准的模型调用层（OpenAI 兼容 /chat/completions）。
 *
 * 只做三件事，且都必须可复现：
 *  1. chat   —— 纯文本问答（CFLUE / FinEval / FinanceBench）
 *  2. vision —— 图片 + 文本（FinEval-MM / OmniDocBench），本地图片转 data URI
 *  3. tools  —— 函数调用（BFCL），返回结构化 tool_calls
 *
 * 记账：每次调用累计 token 用量，报告里给"本次对齐共消耗 X tokens / 估算成本"，
 * 因为验收标准里明确要求"成本算得清"。
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { resolveLlm } = require('../../lib/llm')

const REPO = path.resolve(__dirname, '..', '..', '..')
const REGISTRY = path.join(__dirname, '..', 'models.json')

/**
 * 模型注册表：同代对比要跨供应商，因此"用哪个端点 + 哪个 Key + 什么价目"必须可配置。
 * 注册表里不含密钥，只写环境变量名与 Key 文件候选路径。
 */
function loadRegistry() {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY, 'utf8')).models || []
  } catch {
    return []
  }
}

const expandHome = (p) => p.replace(/^~/, os.homedir()).replace('<repo>', REPO)

/**
 * 解析某个模型 id 的连接信息：环境变量 → Key 文件 → 兜底（仅 deepseek 走原有逻辑）。
 * @returns {{id,label,baseUrl,apiModel,apiKey,keySource,priceUSD,vision,tools,role,ready,reason}}
 */
function resolveProvider(id, { baseUrl, apiKey, model } = {}) {
  const reg = loadRegistry().find((m) => m.id === id || (m.aliases || []).includes(id))
  if (!reg) {
    // 未注册：退回旧的单供应商逻辑（保证已有命令仍可用）
    const llm = resolveLlm(REPO, { model: model || id })
    return {
      id, label: id, vendor: 'unknown', baseUrl: (baseUrl || llm.baseUrl).replace(/\/+$/, ''), apiModel: model || llm.model,
      apiKey: apiKey || llm.apiKey, keySource: apiKey ? '参数传入' : llm.keySource, priceUSD: PRICES_USD[id] || null,
      vision: true, tools: true, ready: !!(apiKey || llm.apiKey), reason: llm.ready ? '' : `未找到 API Key（尝试过：${llm.tried.join(' / ')}）`,
    }
  }
  let key = apiKey || ''
  let keySource = key ? '参数传入' : ''
  if (!key) {
    for (const env of reg.keyEnv || []) {
      if (process.env[env]) { key = process.env[env]; keySource = `env:${env}`; break }
    }
  }
  if (!key) {
    for (const f of reg.keyFiles || []) {
      const p = expandHome(f)
      try {
        if (!fs.existsSync(p)) continue
        const txt = fs.readFileSync(p, 'utf8')
        const m = txt.match(/sk-[A-Za-z0-9_\-]{8,}/) || txt.match(/[A-Za-z0-9_\-.]{20,}/)
        if (m) { key = m[0]; keySource = p; break }
      } catch { /* 读不到就试下一个 */ }
    }
  }
  const resolvedBase = (baseUrl || reg.baseUrl || process.env[`RWP_BASE_${id.replace(/[^a-z0-9]/gi, '_').toUpperCase()}`] || '').replace(/\/+$/, '')
  const ready = !!key && !!resolvedBase
  const reason = !resolvedBase ? `未配置 baseUrl（请在 bench/external/models.json 里填写 ${id} 的端点）` : !key ? `未找到 Key（环境变量 ${(reg.keyEnv || []).join('/')} 或文件 ${(reg.keyFiles || []).join(' / ')}）` : ''
  return {
    id,
    label: reg.label || id,
    vendor: reg.vendor || '',
    baseUrl: resolvedBase,
    apiModel: model || reg.apiModel || id,
    apiPath: reg.apiPath || '/chat/completions',
    apiKey: key,
    keySource,
    priceUSD: reg.priceUSD || PRICES_USD[id] || null,
    priceSource: reg.priceSource || '',
    vision: reg.vision !== false,
    tools: reg.tools !== false,
    role: reg.role || '',
    ready,
    reason,
  }
}

/** 列出注册表里可用于评测的模型（报告里用来写明"对手是谁"） */
function listProviders() {
  return loadRegistry().map((m) => {
    const r = resolveProvider(m.id)
    return { id: m.id, label: m.label, vendor: m.vendor, vision: m.vision !== false, tools: m.tools !== false, ready: r.ready, reason: r.reason, role: m.role || '' }
  })
}

/**
 * 价目表（**必须按官方定价页核对，且区分缓存命中/未命中**）。
 *
 * 教训：最初按"每百万 ¥0.5 输入 / ¥2 输出"的粗估记账，实际官方 Flash 价是
 *   cache-hit 输入 $0.006、cache-miss 输入 $0.30、输出 $1.20（每百万 token，peak 时段；off-peak 减半）
 * 缓存命中与未命中相差 50 倍，而我们的输入侧缓存命中率高达 68%——粗估会把成本算错好几倍。
 *
 * 来源：https://api-docs.deepseek.com/quick_start/pricing （抓取于 2026-09-14）
 * 汇率：1 USD = 7.1 CNY（仅用于展示，报告中同时给出美元价）
 */
const USD_CNY = 7.1
const PRICES_USD = {
  'deepseek-flash': { hit: 0.006, miss: 0.3, out: 1.2, note: 'DeepSeek-V4.1-Flash，peak 价；off-peak 减半' },
  'deepseek-v4-pro': { hit: 0.044, miss: 1.32, out: 3.96, note: 'DeepSeek-V4-Pro-0813，peak 价' },
}
/** 兼容旧的按 (in,out) 计价写法；新代码请用 costOf() */
const PRICES = Object.fromEntries(Object.entries(PRICES_USD).map(([k, v]) => [k, { in: v.miss * USD_CNY, out: v.out * USD_CNY, hit: v.hit * USD_CNY, miss: v.miss * USD_CNY, note: v.note }]))

/**
 * 用真实价目计算一次用量的人民币成本：缓存命中与未命中分开计价。
 * @param {{model:string, promptTokens:number, cacheHitTokens:number, completionTokens:number}} u
 */
function costOf(u) {
  const p = PRICES_USD[u.model]
  if (!p) return null
  const hit = Math.min(u.cacheHitTokens || 0, u.promptTokens || 0)
  const miss = Math.max(0, (u.promptTokens || 0) - hit)
  const usd = (hit / 1e6) * p.hit + (miss / 1e6) * p.miss + ((u.completionTokens || 0) / 1e6) * p.out
  return { usd: Number(usd.toFixed(4)), cny: Number((usd * USD_CNY).toFixed(2)), hitTokens: hit, missTokens: miss, price: p }
}

function mimeOf(file) {
  const e = path.extname(file).toLowerCase()
  return { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' }[e] || 'image/jpeg'
}

class ModelClient {
  constructor({ model, apiKey, baseUrl, timeoutMs = 180000, maxRetries = 3, logger } = {}) {
    // 优先按注册表解析（支持跨供应商：DeepSeek / OpenAI / 智谱 / 聚合网关）
    // 注意：不要把注册表 id 传成"模型名"，否则 apiModel（真实模型名）会被 id 覆盖
    const p = resolveProvider(model || 'deepseek-flash', { apiKey, baseUrl })
    if (!p.ready && !apiKey) {
      const llm = resolveLlm(REPO, { model })
      if (!llm.ready) throw new Error(p.reason || `未找到 API Key（尝试过：${llm.tried.join(' / ')}）`)
    }
    this.provider = p
    this.model = p.apiModel || model
    this.requestModel = this.model
    this.apiKey = apiKey || p.apiKey
    this.baseUrl = (baseUrl || p.baseUrl).replace(/\/+$/, '')
    this.keySource = p.keySource
    this.timeoutMs = timeoutMs
    this.maxRetries = maxRetries
    this.log = logger || (() => {})
    this.usage = { calls: 0, failed: 0, promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, reasoningTokens: 0, byKind: {} }
  }

  /** 按注册表价目算钱（网关模型的价格不在内置表里）；缺价目时返回 null，绝不编数 */
  _costFromProvider() {
    const p = this.provider && this.provider.priceUSD
    if (!p) return null
    const hit = Math.min(this.usage.cacheHitTokens || 0, this.usage.promptTokens || 0)
    const miss = Math.max(0, (this.usage.promptTokens || 0) - hit)
    const usd = (hit / 1e6) * (p.hit ?? p.miss ?? 0) + (miss / 1e6) * (p.miss ?? 0) + ((this.usage.completionTokens || 0) / 1e6) * (p.out ?? 0)
    return { usd: Number(usd.toFixed(4)), cny: Number((usd * USD_CNY).toFixed(2)), hitTokens: hit, missTokens: miss, price: p }
  }

  /** 报告用：不含 Key 的自述 */
  describe() {
    const c = costOf({ model: this.model, promptTokens: this.usage.promptTokens, cacheHitTokens: this.usage.cacheHitTokens, completionTokens: this.usage.completionTokens }) || this._costFromProvider()
    return {
      model: this.model,
      provider: this.provider ? this.provider.id : null,
      vendor: this.provider ? this.provider.vendor : null,
      baseUrl: this.baseUrl,
      keySource: this.keySource,
      keyMask: this.apiKey ? `${this.apiKey.slice(0, 6)}…${this.apiKey.slice(-4)}` : '',
      calls: this.usage.calls,
      failed: this.usage.failed,
      promptTokens: this.usage.promptTokens,
      completionTokens: this.usage.completionTokens,
      reasoningTokens: this.usage.reasoningTokens,
      cacheHitTokens: this.usage.cacheHitTokens,
      cacheMissTokens: c ? c.missTokens : null,
      estimatedCostCNY: c ? c.cny : null,
      estimatedCostUSD: c ? c.usd : null,
      pricePerMTokUSD: c ? c.price : null,
      priceSource: 'https://api-docs.deepseek.com/quick_start/pricing（2026-09-14 抓取，peak 价）',
      usdCnyRate: USD_CNY,
    }
  }

  /**
   * 记账。**必须兼容三种协议的用量字段名**，否则跨供应商时 token 会静默记成 0：
   *   OpenAI chat/completions → prompt_tokens / completion_tokens
   *   OpenAI Responses API    → input_tokens / output_tokens
   *   Anthropic Messages API  → input_tokens / output_tokens（外加 cache_read_input_tokens）
   * 这个 bug 曾让整轮网关运行显示"820 次调用、0 token"。
   */
  _account(kind, usage) {
    if (!usage) return
    const pin = usage.prompt_tokens ?? usage.input_tokens ?? 0
    const pout = usage.completion_tokens ?? usage.output_tokens ?? 0
    const hit = usage.prompt_cache_hit_tokens ?? usage.cache_read_input_tokens ?? usage.cached_tokens ?? 0
    const rt = (usage.completion_tokens_details || {}).reasoning_tokens || (usage.output_tokens_details || {}).reasoning_tokens || 0
    this.usage.promptTokens += pin
    this.usage.completionTokens += pout
    this.usage.cacheHitTokens += hit
    this.usage.reasoningTokens = (this.usage.reasoningTokens || 0) + rt
    const b = (this.usage.byKind[kind] = this.usage.byKind[kind] || { calls: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0 })
    b.calls++
    b.promptTokens += pin
    b.completionTokens += pout
    b.reasoningTokens += rt
  }

  async _post(body, kind) {
    let lastErr
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), this.timeoutMs)
      try {
        // 端点形态因模型族而异：DeepSeek/GLM/Kimi 走 /chat/completions，
        // GPT-5.x 在 OpenCode Zen 只提供 /responses，Claude 只提供 /messages。
        const apiPath = this.provider && this.provider.apiPath ? this.provider.apiPath : '/chat/completions'
        const url = apiPath === '/chat/completions' ? `${this.baseUrl}/chat/completions` : `${this.baseUrl}${apiPath}`
        const res = await fetch(url, {
          method: 'POST',
          headers:
            this.provider && this.provider.apiPath === '/messages'
              ? { 'Content-Type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' }
              : { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify(body),
          signal: ac.signal,
        })
        clearTimeout(timer)
        const text = await res.text()
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`)
        const json = JSON.parse(text)
        this.usage.calls++
        this._account(kind, json.usage)
        return json
      } catch (e) {
        clearTimeout(timer)
        lastErr = e
        // 4xx 参数类错误重试无意义，直接抛（但要记账，避免"看起来没跑"）
        if (/HTTP 4\d\d/.test(String(e.message))) break
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)))
      }
    }
    this.usage.failed++
    throw new Error(`模型调用失败(${this.model}): ${lastErr && lastErr.message}`)
  }

  /**
   * OpenAI Responses API（/responses）：GPT-5.x 在部分网关只提供这一种形态。
   * 与 chat/completions 的差异：system 走 instructions、输入叫 input、输出在 output[] 里、
   * 用量字段是 input_tokens/output_tokens（而非 prompt_tokens/completion_tokens）。
   * @param {{system?:string,user:string,images?:string[],tools?:any[],maxTokens?:number,kind?:string}} o
   */
  async _responses(o) {
    const content = [{ type: 'input_text', text: o.user }]
    for (const img of o.images || []) {
      const abs = path.isAbsolute(img) ? img : path.join(REPO, img)
      const b64 = fs.readFileSync(abs).toString('base64')
      const ext = path.extname(abs).slice(1).toLowerCase()
      const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
      content.push({ type: 'input_image', image_url: `data:${mime};base64,${b64}` })
    }
    const body = { model: this.model, input: [{ role: 'user', content }], max_output_tokens: o.maxTokens ?? 2048 }
    if (o.system) body.instructions = o.system
    if (o.tools) {
      body.tools = o.tools.map((t) => ({ type: 'function', name: t.function.name, description: t.function.description, parameters: t.function.parameters }))
      body.tool_choice = o.toolChoice || 'auto'
    }
    const j = await this._post(body, o.kind || 'responses')
    // 归一化成与 chat() 相同的形状，上层无需分支
    let text = ''
    const calls = []
    for (const item of j.output || []) {
      if (item.type === 'message') for (const c of item.content || []) if (c.type === 'output_text') text += c.text
      if (item.type === 'function_call') calls.push({ id: item.call_id || item.id, name: item.name, args: (() => { try { return JSON.parse(item.arguments || '{}') } catch { return item.arguments } })() })
    }
    if (!text && typeof j.output_text === 'string') text = j.output_text
    const u = j.usage || {}
    return {
      text,
      reasoning: '',
      finishReason: j.status || '',
      truncated: j.status === 'incomplete',
      calls,
      usage: { prompt_tokens: u.input_tokens, completion_tokens: u.output_tokens, total_tokens: (u.input_tokens || 0) + (u.output_tokens || 0) },
      raw: j,
    }
  }

  /**
   * Anthropic Messages API（/messages）：Claude 系列在网关只提供这一种形态。
   * 与 OpenAI 的差异：认证走 x-api-key（不是 Bearer）、system 是顶层字段、
   * 输出在 content[] 里、用量字段是 input_tokens/output_tokens。
   */
  async _messages(o) {
    const content = [{ type: 'text', text: o.user }]
    for (const img of o.images || []) {
      const abs = path.isAbsolute(img) ? img : path.join(REPO, img)
      const b64 = fs.readFileSync(abs).toString('base64')
      const ext = path.extname(abs).slice(1).toLowerCase()
      const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
      content.push({ type: 'image', source: { type: 'base64', media_type: mime, data: b64 } })
    }
    const body = { model: this.model, max_tokens: o.maxTokens ?? 2048, messages: [{ role: 'user', content }] }
    if (o.system) body.system = o.system
    if (o.tools) {
      body.tools = o.tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }))
      if (o.toolChoice !== undefined) body.tool_choice = { type: 'auto' }
    }
    const j = await this._post(body, o.kind || 'messages')
    let text = ''
    const calls = []
    for (const c of j.content || []) {
      if (c.type === 'text') text += c.text
      if (c.type === 'tool_use') calls.push({ id: c.id, name: c.name, args: c.input })
    }
    const u = j.usage || {}
    return {
      text,
      reasoning: '',
      finishReason: j.stop_reason || '',
      truncated: j.stop_reason === 'max_tokens',
      calls,
      usage: { prompt_tokens: u.input_tokens, completion_tokens: u.output_tokens, total_tokens: (u.input_tokens || 0) + (u.output_tokens || 0) },
      raw: j,
    }
  }

  /**
   * 纯文本。
   *
   * 注意（踩过的坑）：DeepSeek 系模型先写 reasoning_content 再写 content。
   * max_tokens 太小会导致"token 花光、content 为空、finish_reason=length"，
   * 这会被误判成模型答错。所以这里对"截断且无正文"的情况自动加倍重试，
   * 并把 finishReason/truncated 暴露给上层，便于把这类样本单列而不是算错。
   */
  async chat(o) {
    // Responses-only 模型（如网关上的 GPT-5.x）直接走 /responses
    if (this.provider && this.provider.apiPath === '/responses') return this._responses(o)
    if (this.provider && this.provider.apiPath === '/messages') return this._messages(o)
    let budget = o.maxTokens ?? 1024
    let last = null
    for (let round = 0; round < 3; round++) {
      const messages = []
      if (o.system) messages.push({ role: 'system', content: o.system })
      messages.push({ role: 'user', content: o.user })
      const body = { model: this.model, messages, temperature: o.temperature ?? 0, max_tokens: budget }
      if (o.json) body.response_format = { type: 'json_object' }
      const j = await this._post(body, o.kind || 'chat')
      const ch = (j.choices && j.choices[0]) || {}
      const msg = ch.message || {}
      last = {
        text: msg.content || '',
        reasoning: msg.reasoning_content || '',
        finishReason: ch.finish_reason || '',
        truncated: ch.finish_reason === 'length',
        usage: j.usage || null,
        raw: j,
        maxTokensUsed: budget,
      }
      if (last.text || !last.truncated) return last
      budget = Math.min(budget * 4, 8192) // 全是推理没有正文 → 加预算再来
      this.log(`    截断无正文，提升 max_tokens 至 ${budget} 重试`)
    }
    return last
  }

  /**
   * 图片 + 文本（本地文件路径 → data URI）
   * @param {{system?:string,user:string,images:string[],temperature?:number,maxTokens?:number,kind?:string}} o
   */
  async vision(o) {
    if (this.provider && this.provider.apiPath === '/responses') return this._responses({ ...o, maxTokens: o.maxTokens ?? 2048 })
    if (this.provider && this.provider.apiPath === '/messages') return this._messages({ ...o, maxTokens: o.maxTokens ?? 2048 })
    const parts = [{ type: 'text', text: o.user }]
    for (const img of o.images) {
      const abs = path.isAbsolute(img) ? img : path.join(REPO, img)
      const b64 = fs.readFileSync(abs).toString('base64')
      parts.push({ type: 'image_url', image_url: { url: `data:${mimeOf(abs)};base64,${b64}` } })
    }
    const messages = []
    if (o.system) messages.push({ role: 'system', content: o.system })
    messages.push({ role: 'user', content: parts })
    const body = { model: this.model, messages, temperature: o.temperature ?? 0, max_tokens: o.maxTokens ?? 2048 }
    const j = await this._post(body, o.kind || 'vision')
    const ch = (j.choices && j.choices[0]) || {}
    const msg = ch.message || {}
    return { text: msg.content || '', reasoning: msg.reasoning_content || '', finishReason: ch.finish_reason || '', truncated: ch.finish_reason === 'length', usage: j.usage || null, raw: j }
  }

  /**
   * 函数调用
   * @param {{system?:string,user:string,tools:Array,toolChoice?:any,temperature?:number,maxTokens?:number,kind?:string}} o
   */
  async tools(o) {
    if (this.provider && this.provider.apiPath === '/responses') return this._responses({ ...o, maxTokens: o.maxTokens ?? 2048 })
    if (this.provider && this.provider.apiPath === '/messages') return this._messages({ ...o, maxTokens: o.maxTokens ?? 2048 })
    const messages = []
    if (o.system) messages.push({ role: 'system', content: o.system })
    messages.push({ role: 'user', content: o.user })
    const body = {
      model: this.model,
      messages,
      tools: o.tools,
      temperature: o.temperature ?? 0,
      max_tokens: o.maxTokens ?? 2048,
    }
    if (o.toolChoice !== undefined) body.tool_choice = o.toolChoice
    const j = await this._post(body, o.kind || 'tools')
    const ch = (j.choices && j.choices[0]) || {}
    const msg = ch.message || {}
    const calls = (msg.tool_calls || []).map((tc) => {
      let args = {}
      try { args = JSON.parse((tc.function || {}).arguments || '{}') } catch { args = null }
      return { name: (tc.function || {}).name || '', args, rawArguments: (tc.function || {}).arguments || '' }
    })
    return { text: msg.content || '', reasoning: msg.reasoning_content || '', calls, finishReason: ch.finish_reason || '', truncated: ch.finish_reason === 'length', usage: j.usage || null, raw: j }
  }
}

/** 并发闸门：固定并发数跑一批任务，保持结果顺序 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

module.exports = { ModelClient, mapLimit, PRICES, PRICES_USD, costOf, USD_CNY, REPO, REGISTRY, loadRegistry, resolveProvider, listProviders }
