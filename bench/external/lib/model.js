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
const { resolveLlm } = require('../../lib/llm')

const REPO = path.resolve(__dirname, '..', '..', '..')

/** 已知价目（元/百万 token）；未知模型只记 token 不记钱，避免编数 */
const PRICES = {
  'deepseek-flash': { in: 0.5, out: 2 },
  'deepseek-v4-pro': { in: 2, out: 8 },
}

function mimeOf(file) {
  const e = path.extname(file).toLowerCase()
  return { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' }[e] || 'image/jpeg'
}

class ModelClient {
  constructor({ model, apiKey, baseUrl, timeoutMs = 180000, maxRetries = 3, logger } = {}) {
    const llm = resolveLlm(REPO, { model })
    if (!llm.ready) throw new Error(`未找到 API Key（尝试过：${llm.tried.join(' / ')}）`)
    this.model = model || llm.model
    this.apiKey = apiKey || llm.apiKey
    this.baseUrl = (baseUrl || llm.baseUrl).replace(/\/+$/, '')
    this.keySource = llm.keySource
    this.timeoutMs = timeoutMs
    this.maxRetries = maxRetries
    this.log = logger || (() => {})
    this.usage = { calls: 0, failed: 0, promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, reasoningTokens: 0, byKind: {} }
  }

  /** 报告用：不含 Key 的自述 */
  describe() {
    const p = PRICES[this.model]
    const cost = p ? (this.usage.promptTokens / 1e6) * p.in + (this.usage.completionTokens / 1e6) * p.out : null
    return {
      model: this.model,
      baseUrl: this.baseUrl,
      keySource: this.keySource,
      keyMask: this.apiKey ? `${this.apiKey.slice(0, 6)}…${this.apiKey.slice(-4)}` : '',
      calls: this.usage.calls,
      failed: this.usage.failed,
      promptTokens: this.usage.promptTokens,
      completionTokens: this.usage.completionTokens,
      reasoningTokens: this.usage.reasoningTokens,
      cacheHitTokens: this.usage.cacheHitTokens,
      estimatedCostCNY: cost === null ? null : Number(cost.toFixed(4)),
      pricePerMTok: p || null,
    }
  }

  _account(kind, usage) {
    if (!usage) return
    this.usage.promptTokens += usage.prompt_tokens || 0
    this.usage.completionTokens += usage.completion_tokens || 0
    this.usage.cacheHitTokens += usage.prompt_cache_hit_tokens || 0
    const rt = (usage.completion_tokens_details || {}).reasoning_tokens || 0
    this.usage.reasoningTokens = (this.usage.reasoningTokens || 0) + rt
    const b = (this.usage.byKind[kind] = this.usage.byKind[kind] || { calls: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0 })
    b.calls++
    b.promptTokens += usage.prompt_tokens || 0
    b.completionTokens += usage.completion_tokens || 0
    b.reasoningTokens += rt
  }

  async _post(body, kind) {
    let lastErr
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), this.timeoutMs)
      try {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
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
   * 纯文本。
   *
   * 注意（踩过的坑）：DeepSeek 系模型先写 reasoning_content 再写 content。
   * max_tokens 太小会导致"token 花光、content 为空、finish_reason=length"，
   * 这会被误判成模型答错。所以这里对"截断且无正文"的情况自动加倍重试，
   * 并把 finishReason/truncated 暴露给上层，便于把这类样本单列而不是算错。
   */
  async chat(o) {
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

module.exports = { ModelClient, mapLimit, PRICES, REPO }
