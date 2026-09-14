/**
 * 抓取"同代模型"的公开资料并抽取关键事实（参数/上下文/价格/基准）。
 * 用途：为今晚的同代测试准备一张"对手是谁、官方宣称什么"的事实表。
 *
 *   node bench/html/fetch-model-facts.js
 */
const fs = require('node:fs')
const path = require('node:path')
const dns = require('node:dns')
try { dns.setDefaultResultOrder('ipv4first') } catch {}

const OUT = path.join(__dirname, '..', 'external', 'out', 'same-generation-models.json')
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; rwp-bench research)' }

const PAGES = [
  ['DeepSeek 官方定价页', 'https://api-docs.deepseek.com/quick_start/pricing'],
  ['DeepSeek V4.1 Flash（OrcaRouter 价格与基准）', 'https://www.orcarouter.ai/models/deepseek/deepseek-v4.1-flash'],
  ['GLM-5.3-Flash 官方技术博客（z.ai）', 'https://z.ai/blog/glm-5.3-flash'],
  ['GLM-5.3-Flash（智谱官方研究页）', 'https://www.zhipuai.cn/zh/research/163'],
  ['GPT-5.6 家族：Luna / Terra / Sol（Simon Willison）', 'https://simonwillison.net/2026/Jul/9/gpt-5-6/'],
  ['DeepSeek V4.1 Flash 报道（快科技）', 'https://m.mydrivers.com/newsview/1150142.html'],
  ['Artificial Analysis 智能指数榜', 'https://artificialanalysis.ai/leaderboards/models'],
  ['OpenAI GPT-5.6 发布页', 'https://openai.com/index/gpt-5-6/'],
]

const strip = (h) =>
  String(h)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const KEY = /(上下文|context|token|参数|param|benchmark|基准|评测|得分|score|价格|pricing|\$|每百万|MMLU|GPQA|SWE|AIME|Humanity|推理|多模态|multimodal|视觉|vision|开源|open.?source|Flash|Luna|Terra|Sol|发布日期|released|V4\.1|5\.6|5\.3)/i

;(async () => {
  const results = []
  for (const [label, url] of PAGES) {
    try {
      const t0 = Date.now()
      const res = await fetch(url, { headers: UA, redirect: 'follow' })
      const html = await res.text()
      const text = strip(html)
      // 抽取含关键词的句子
      const sentences = text.split(/(?<=[.。!！?？])\s+|\n/).map((s) => s.trim()).filter(Boolean)
      const key = sentences.filter((s) => KEY.test(s) && s.length > 12 && s.length < 400)
      console.log(`\n=== ${label} ===`)
      console.log(`  HTTP ${res.status}  ${(html.length / 1024).toFixed(0)}KB  ${Date.now() - t0}ms  正文 ${text.length} 字`)
      key.slice(0, 22).forEach((s) => console.log('   · ' + s.slice(0, 240)))
      results.push({ label, url, status: res.status, chars: text.length, keySentences: key.slice(0, 60) })
    } catch (e) {
      console.log(`\n=== ${label} ===\n  ❌ ${String(e.message).slice(0, 120)}`)
      results.push({ label, url, error: String(e.message).slice(0, 200) })
    }
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), note: '厂商/第三方公开页面抓取，仅作事实记录，未经验证；基准数字属厂商自报', pages: results }, null, 2))
  console.log(`\n产物 → ${path.relative(path.join(__dirname, '..', '..'), OUT)}`)
})()
