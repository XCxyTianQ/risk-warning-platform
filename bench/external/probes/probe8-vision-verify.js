/**
 * 第八轮探测：**图片到底有没有被读到**——用 OmniDocBench 的标注做客观核对。
 *
 * 为什么要这一步：模型"输出了一段看起来很像中文财经的文字"不等于它读了图。
 * 唯一可信的判据是：把标注文本（GT）与模型转写结果做重叠度比较。
 *   - 重叠高 → 通道可用；
 *   - 重叠低 → 说明图没进去（或模型在编），多模态评测必须换通道（走平台附件读取），
 *     或者如实报告"该模型不支持图像输入"。
 */
const F = require('../lib/fetch')
const { ModelClient } = require('../lib/model')

/** 归一化：去空白、全角转半角、去标点，只留可比较的字符序列 */
function norm(s) {
  return String(s || '')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, '')
    .replace(/[，。、；：（）()「」【】《》""''！？·—\-.,;:!?"'`~@#$%^&*_+=\[\]{}|\\/<>]/g, '')
    .toLowerCase()
}

/** GT 片段（按句/行切）在模型输出里的召回：衡量"读全了没有" */
function segmentRecall(gt, out, minLen = 6) {
  const segs = String(gt || '')
    .split(/[\n。；;！!？?]/)
    .map((s) => norm(s))
    .filter((s) => s.length >= minLen)
  if (!segs.length) return { total: 0, hit: 0, recall: null }
  const o = norm(out)
  let hit = 0
  for (const s of segs) if (o.includes(s)) hit++
  return { total: segs.length, hit, recall: hit / segs.length }
}

/** 字符级编辑距离比（0 = 完全一致，1 = 完全不同），用于整体保真度 */
function editRatio(a, b) {
  const s = norm(a), t = norm(b)
  if (!s.length && !t.length) return 0
  if (!s.length || !t.length) return 1
  // 太长时截断，避免 O(n*m) 爆内存（这里只做趋势判断）
  const A = s.slice(0, 4000), B = t.slice(0, 4000)
  const prev = new Uint32Array(B.length + 1)
  const cur = new Uint32Array(B.length + 1)
  for (let j = 0; j <= B.length; j++) prev[j] = j
  for (let i = 1; i <= A.length; i++) {
    cur[0] = i
    for (let j = 1; j <= B.length; j++) {
      const cost = A[i - 1] === B[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    prev.set(cur)
  }
  return prev[B.length] / Math.max(A.length, B.length)
}

/** 数字召回：财报页面里数字读错是致命的 */
function numberRecall(gt, out) {
  const nums = (String(gt || '').match(/\d+(?:[.,]\d+)?%?/g) || []).filter((n) => n.length >= 2)
  if (!nums.length) return { total: 0, hit: 0, recall: null }
  const o = String(out || '')
  let hit = 0
  for (const n of nums) if (o.includes(n)) hit++
  return { total: nums.length, hit, recall: hit / nums.length }
}

function gtOfPage(page) {
  const dets = (page.layout_dets || []).filter((d) => !d.ignore && d.text)
  dets.sort((a, b) => (a.order || 0) - (b.order || 0))
  return dets.map((d) => d.text).join('\n')
}

;(async () => {
  const demo = JSON.parse(F.rawText('omnidocbench/demo.json'))
  const pages = demo.map((p) => ({ ...p, file: F.rawPath('omnidocbench_pages/' + p.page_info.image_path), gt: gtOfPage(p) }))
  // 挑中文研报页 + 中文表格较多的页，二者最能代表我们的场景
  const zh = pages.filter((p) => /simplified_chinese/.test((p.page_info.page_attribute || {}).language || ''))
  const report = zh.find((p) => (p.page_info.page_attribute || {}).data_source === 'research_report') || zh[0]
  const withTable = pages.filter((p) => (p.layout_dets || []).some((d) => d.category_type === 'table' && d.text)).sort((a, b) => (b.gt || '').length - (a.gt || '').length)[0]
  const picks = [report, withTable].filter(Boolean)
  console.log(`选中 ${picks.length} 页：${picks.map((p) => p.page_info.image_path).join(', ')}`)

  for (const model of ['deepseek-flash', 'deepseek-v4-pro']) {
    console.log(`\n########## ${model} ##########`)
    let c
    try { c = new ModelClient({ model }) } catch (e) { console.log('  初始化失败 ' + e.message); continue }
    for (const p of picks) {
      const attr = p.page_info.page_attribute || {}
      console.log(`  --- ${p.page_info.image_path} [${attr.data_source}/${attr.language}] GT ${p.gt.length} 字 ---`)
      try {
        const t0 = Date.now()
        const r = await c.vision({
          user: '请逐字转写这张文档图片的全部内容，输出 Markdown。表格请用 Markdown 表格表示。不要总结、不要解释、不要补充图中没有的内容。',
          images: [p.file],
          maxTokens: 4000,
          kind: 'vision-verify',
        })
        const sr = segmentRecall(p.gt, r.text)
        const nr = numberRecall(p.gt, r.text)
        const er = editRatio(p.gt, r.text)
        console.log(`      ${((Date.now() - t0) / 1000).toFixed(1)}s  输出 ${r.text.length} 字  in=${r.usage.prompt_tokens} out=${r.usage.completion_tokens}`)
        console.log(`      片段召回 ${sr.hit}/${sr.total} = ${sr.recall === null ? 'n/a' : (sr.recall * 100).toFixed(1)}%   数字召回 ${nr.hit}/${nr.total} = ${nr.recall === null ? 'n/a' : (nr.recall * 100).toFixed(1)}%   编辑距离比 ${er.toFixed(3)}`)
        console.log(`      输出前 150 字: ${r.text.replace(/\s+/g, ' ').slice(0, 150)}`)
        console.log(`      GT  前 150 字: ${p.gt.replace(/\s+/g, ' ').slice(0, 150)}`)
      } catch (e) {
        console.log(`      ❌ ${e.message.slice(0, 200)}`)
      }
    }
    console.log(`  记账: ${JSON.stringify(c.describe())}`)
  }
})().catch((e) => { console.error(e); process.exit(1) })
