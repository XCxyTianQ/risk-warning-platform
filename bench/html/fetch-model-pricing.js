/**
 * 精确抽取：① DeepSeek 官方定价表（我们的成本模型依赖它）② 各模型的上下文/参数事实。
 * 只做事实记录与出处标注，不采信营销措辞。
 */
const fs = require('node:fs')
const path = require('node:path')
const dns = require('node:dns')
try { dns.setDefaultResultOrder('ipv4first') } catch {}

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; rwp-bench research)' }
const OUT = path.join(__dirname, '..', 'external', 'out', 'same-generation-models.json')

const strip = (h) => String(h).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, '|').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\|+/g, '|').replace(/[ \t]+/g, ' ')
const rows = (h) => strip(h).split('|').map((s) => s.trim()).filter(Boolean)

;(async () => {
  const out = { generatedAt: new Date().toISOString(), note: '公开页面抓取，逐条带出处；厂商自报的基准数字不等于独立评测', facts: [] }

  // 1) DeepSeek 定价页：找出含价格的片段与型号名
  try {
    const res = await fetch('https://api-docs.deepseek.com/quick_start/pricing', { headers: UA })
    const html = await res.text()
    const cells = rows(html)
    const priceIdx = cells.map((c, i) => (/[¥$]\s?[\d.]+|\d+(\.\d+)?\s*元/.test(c) ? i : -1)).filter((i) => i >= 0)
    console.log('=== DeepSeek 定价页：疑似价格单元 ===')
    const seen = new Set()
    for (const i of priceIdx) {
      const ctx = cells.slice(Math.max(0, i - 6), i + 3).join(' | ')
      if (seen.has(ctx)) continue
      seen.add(ctx)
      console.log('  · ' + ctx.slice(0, 220))
    }
    const modelLines = cells.filter((c) => /deepseek-(v[\d.]+-)?(flash|pro|chat|reasoner)/i.test(c))
    console.log('\n  型号相关行:')
    ;[...new Set(modelLines)].slice(0, 12).forEach((c) => console.log('   · ' + c.slice(0, 200)))
    out.facts.push({ topic: 'DeepSeek 定价页', url: 'https://api-docs.deepseek.com/quick_start/pricing', priceCells: priceIdx.slice(0, 40).map((i) => cells.slice(Math.max(0, i - 4), i + 2).join(' | ')), modelLines: [...new Set(modelLines)].slice(0, 20) })
  } catch (e) {
    console.log('定价页抓取失败: ' + e.message)
    out.facts.push({ topic: 'DeepSeek 定价页', error: String(e.message).slice(0, 150) })
  }

  // 2) 各模型一句话事实（来自上一步已抓到的页面，这里固化出处）
  const KNOWN = [
    { model: 'DeepSeek-V4.1-Flash', role: '我们用的模型', facts: ['旧名 deepseek-v4-flash / deepseek-v4-flash-vision-exp 已退役，请求由 DeepSeek-V4.1-Flash 承接并按 Flash 价格计费', '相比上代 V4 Flash 参数量增加 40% 以上、速度更快，基准超过 V4 Pro-0813（1.6T 参数）', '第三方测试（OpenDesignt）：达 GPT-6 Astra 的 98% 水平，成本为其 1.4%；安全测试中强于 Grok 4.6、GLM-5.3、GPT-5.6 Luna'], sources: ['https://api-docs.deepseek.com/quick_start/pricing', 'https://m.mydrivers.com/newsview/1150142.html'] },
    { model: 'GPT-5.6 Luna', role: '同代对标（小尺寸）', facts: ['GPT-5.6 家族三档 Luna < Terra < Sol，2026-07-09 GA', '定价 $1 / $6 每百万输入/输出 token', '1M 上下文、128k 最大输出、知识截止 2026-02-16', '官方称 Luna 与 Terra 在约 1/16 成本下超过 Claude Fable 5；同页也承认 SWE-Bench Pro 上 Fable 5 以 80% 对 64.6%（Sol）领先'], sources: ['https://simonwillison.net/2026/Jul/9/gpt-5-6/'] },
    { model: 'GLM-5.3-Flash', role: '同代对标（开源、原生多模态）', facts: ['320B 总参数 / 18B 激活（320B-A18B），2026-08-26 上线并开源', 'GLM-5 系列首个原生多模态模型；1M 上下文；线性+稀疏混合注意力', 'AA 综合智能指数 57 分，官方称与 Claude Opus 4.8 持平', '定价为 GLM-5.3 的 1/10（限时 1/20），约为 Opus 4.8 的 1/40', '官方明确针对金融/法律专业工作优化，可覆盖"基于来源的金融研究、报告生成、金融建模与分析"'], sources: ['https://www.zhipuai.cn/zh/research/163'] },
    { model: '其他同代参照', role: '出现在同批报道中', facts: ['GPT-6 Astra（当前最强之一，被 V4.1 Flash 以 1.4% 成本达到 98%）', 'Claude Opus 4.8 / Fable 5、Qwen 3.8 Max、Grok 4.6、Kimi K3、GLM-5.3、DeepSeek V4 Pro / V4.1 Pro（未发布）'], sources: ['https://m.mydrivers.com/newsview/1150142.html', 'https://simonwillison.net/2026/Jul/9/gpt-5-6/', 'https://www.zhipuai.cn/zh/research/163'] },
  ]
  out.models = KNOWN

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2))
  console.log(`\n产物 → ${path.relative(path.join(__dirname, '..', '..'), OUT)}`)
})()
