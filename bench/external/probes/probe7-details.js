/**
 * 第七轮探测：判分器设计所需的最后一组事实 + 图片通道实测。
 *  1. CFLUE 三种题型（单选/多选/判断）的答案长什么样 → 决定判分器怎么写
 *  2. OmniDocBench 标注字段全貌（有没有阅读顺序、页面尺寸）→ 决定保真度指标
 *  3. BFCL 官方 checker 源码抓下来 → 自实现判定要对着它写，而不是凭印象
 *  4. vision 通道：拿真实研报页图问两个模型
 */
const path = require('node:path')
const F = require('../lib/fetch')
const S = require('../sources')
const { ModelClient } = require('../lib/model')

;(async () => {
  // 1. CFLUE 答案形态
  console.log('=== CFLUE 答案形态 ===')
  const cflue = JSON.parse(F.rawText('cflue/knowledge.json'))
  for (const t of ['单项选择题', '多项选择题', '判断题']) {
    const rows = cflue.filter((q) => q.task === t)
    const ans = {}
    for (const r of rows) ans[r.answer] = (ans[r.answer] || 0) + 1
    console.log(`  ${t}: ${rows.length} 题，答案取值分布 ${JSON.stringify(ans).slice(0, 200)}`)
    console.log(`     样例: Q=${JSON.stringify(rows[0].question.slice(0, 70))} choices=${JSON.stringify(rows[0].choices).slice(0, 120)} answer=${JSON.stringify(rows[0].answer)}`)
  }
  const app = JSON.parse(F.rawText('cflue/application.json'))
  console.log('  CFLUE 应用题 output 形态（按 task 取一条）:')
  for (const t of [...new Set(app.map((a) => a.task))]) {
    const r = app.find((a) => a.task === t)
    console.log(`     [${t}/${r.sub_task}] instruction=${JSON.stringify((r.instruction || '').slice(0, 60))}`)
    console.log(`        output=${JSON.stringify((r.output || '').slice(0, 120))}`)
  }

  // 2. OmniDocBench 标注字段
  console.log('\n=== OmniDocBench 标注字段 ===')
  const demo = JSON.parse(F.rawText('omnidocbench/demo.json'))
  const p0 = demo[0]
  console.log(`  页面级字段: ${Object.keys(p0).join(', ')}`)
  console.log(`  page_info: ${JSON.stringify(p0.page_info).slice(0, 300)}`)
  console.log(`  layout_dets[0] 全字段: ${Object.keys(p0.layout_dets[0]).join(', ')}`)
  console.log(`  样例: ${JSON.stringify(p0.layout_dets[0]).slice(0, 400)}`)
  console.log(`  页码/尺寸: ${JSON.stringify(p0.page_info.page_attribute)}`)
  const hasOrder = 'order' in p0.layout_dets[0]
  console.log(`  是否自带阅读顺序字段 order: ${hasOrder}`)

  // 3. BFCL 官方 checker
  console.log('\n=== BFCL 官方 checker（用于对齐自实现判定）===')
  const checkerPaths = [
    'berkeley-function-call-leaderboard/bfcl_eval/eval_checker/ast_eval/ast_checker.py',
    'berkeley-function-call-leaderboard/bfcl_eval/eval_checker/multi_turn_eval/multi_turn_checker.py',
  ]
  for (const p of checkerPaths) {
    try {
      const r = await S.repoFile('bfcl', p, `bfcl/checker_${path.basename(p)}`)
      console.log(`  ✅ ${path.basename(p)} ${(r.bytes / 1024).toFixed(1)}KB sha=${r.sha256.slice(0, 12)}`)
      if (p.endsWith('ast_checker.py')) {
        const t = F.rawText(`bfcl/checker_${path.basename(p)}`)
        const fns = t.split(/\r?\n/).filter((l) => /^def |^    def /.test(l)).map((l) => l.trim())
        console.log(`     函数: ${fns.join(' | ').slice(0, 400)}`)
      }
    } catch (e) { console.log(`  ❌ ${p}: ${e.message}`) }
  }

  // 4. vision 实测：拿 OmniDocBench 里那页中文研报
  console.log('\n=== vision 通道实测（中文研报页）===')
  const imgs = F.listCache().filter((m) => m.key.startsWith('omnidocbench_pages/'))
  const pick = imgs.find((m) => /research_report/.test(m.key)) || imgs[0]
  const pageFile = F.rawPath(pick.key)
  console.log(`  页面: ${pick.key}  ${(pick.bytes / 1024).toFixed(0)}KB`)
  const gt = demo.find((p) => {
    const src = (p.page_info.page_attribute || {}).data_source
    return pick.key.includes(src) && true
  })
  for (const model of ['deepseek-flash', 'deepseek-v4-pro']) {
    try {
      const c = new ModelClient({ model })
      const t0 = Date.now()
      const r = await c.vision({
        user: '请把这张文档图片的内容转成 Markdown，保留标题层级和表格结构。不要添加任何解释。',
        images: [pageFile],
        maxTokens: 3000,
        kind: 'probe-vision',
      })
      console.log(`  ✅ ${model}: ${((Date.now() - t0) / 1000).toFixed(1)}s, 输出 ${r.text.length} 字, tokens in=${r.usage.prompt_tokens} out=${r.usage.completion_tokens}`)
      console.log(`     前 200 字: ${r.text.replace(/\s+/g, ' ').slice(0, 200)}`)
    } catch (e) {
      console.log(`  ❌ ${model}: ${e.message.slice(0, 200)}`)
    }
  }
})().catch((e) => { console.error(e); process.exit(1) })
