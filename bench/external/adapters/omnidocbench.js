/**
 * E5 · OmniDocBench（demo 18 页）
 *
 * 任务：把整页文档图像（研报、杂志、报纸、学术论文、教材、笔记、PPT、试卷）
 * 转写成 Markdown，再与官方标注逐页比对。
 *
 * 口径说明（必须写清，否则容易被当成"跑过 OmniDocBench"）：
 *  - 我们**不实现**官方指标（文本编辑距离 / 公式 CDM / 表格 TEDS / 阅读顺序编辑距离，均为 Python 实现），
 *    只报三个自实现、可解释的保真度指标：片段召回、数字召回、字符编辑距离比，外加 ROUGE-L；
 *  - 只用官方 demo 18 页，不代表全集 981 页；
 *  - 参考 2024 官方 quick-match 结果仅作背景，不与我们自实现指标直接比大小。
 */
const fs = require('node:fs')
const F = require('../lib/fetch')
const G = require('../lib/grade')
const K = require('../lib/kit')
const { sample } = require('../lib/sample')
const { mapLimit } = require('../lib/model')

/**
 * 页面 GT 文本：按官方 order 排序拼接非 ignore 的版面元素。
 *
 * 关键细节（踩过的坑）：表格元素的标注里**没有 text 字段**，内容在 `html`（结构化 HTML）里；
 * 公式在 `latex` 里。若只取 text，表格内容会被整段漏掉——而财报页恰恰以表格为主，
 * 于是"指标看起来还行"其实是把最该考的部分排除在外了。
 * 因此这里把表格 HTML 去标签后并入 GT，把公式 LaTeX 也并入。
 * 仍未实现：表格结构指标 TEDS、公式 CDM、阅读顺序编辑距离（官方为 Python 实现）。
 */
function elementText(d) {
  if (d.text && String(d.text).trim()) return String(d.text)
  if (d.category_type === 'table' && d.html) {
    return String(d.html)
      .replace(/<\/(td|th)>\s*<\1[^>]*>/gi, ' | ')
      .replace(/<\/(tr|thead|tbody)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/[ \t]+/g, ' ')
      .trim()
  }
  if (String(d.category_type).startsWith('equation') && d.latex) return String(d.latex)
  return ''
}

function gtTextOf(page) {
  const dets = (page.layout_dets || []).filter((d) => !d.ignore)
  dets.sort((a, b) => (a.order || 0) - (b.order || 0))
  return dets.map(elementText).filter(Boolean).join('\n')
}

/** 数字型 GT：只统计"文本与表格里的数字"，用于数字召回的分母 */
function gtNumbersOf(page) {
  const dets = (page.layout_dets || []).filter((d) => !d.ignore)
  const txt = dets.filter((d) => d.category_type !== 'table').map(elementText).filter(Boolean).join('\n')
  const tbl = dets.filter((d) => d.category_type === 'table').map(elementText).filter(Boolean).join('\n')
  return { textPart: txt, tablePart: tbl }
}

function loadPages() {
  const demo = JSON.parse(F.rawText('omnidocbench/demo.json'))
  return demo.map((p, i) => {
    const attr = (p.page_info && p.page_info.page_attribute) || {}
    const name = p.page_info.image_path
    const parts = gtNumbersOf(p)
    return {
      id: `page_${i}_${name}`,
      kind: 'page',
      group: `OmniDocBench/${attr.data_source || '未知'}`,
      dataSource: attr.data_source || '未知',
      language: attr.language || '未知',
      layout: attr.layout || '未知',
      image: `omnidocbench_pages/${name}`,
      gt: gtTextOf(p),
      gtTableText: parts.tablePart,
      gtTableChars: parts.tablePart.length,
      gtElements: (p.layout_dets || []).filter((d) => !d.ignore && elementText(d)).length,
      hasTable: (p.layout_dets || []).some((d) => d.category_type === 'table' && elementText(d)),
      hasFormula: (p.layout_dets || []).some((d) => String(d.category_type).startsWith('equation') && elementText(d)),
    }
  })
}

module.exports = {
  id: 'omnidocbench',
  title: 'OmniDocBench（demo 18 页整页转写）',
  layer: '文档读取层：页面图像 → 结构化文本（中文研报/杂志/报纸等）',
  requiresVision: true,
  source: { repo: 'opendatalab/OmniDocBench', ref: 'main', paper: 'https://arxiv.org/abs/2412.07626' },

  async plan({ seed = 20260101, sizes = {} } = {}) {
    const pages = loadPages()
    const s = sample(pages, sizes.pages ?? 18, seed, (x) => x.id)
    const byLang = {}
    for (const p of pages) byLang[p.language] = (byLang[p.language] || 0) + 1
    return {
      tasks: s.items,
      sample: { pages: { available: pages.length, picked: s.items.length, hash: s.hash, seed }, byLanguage: byLang },
      notes: [
        `官方 demo 共 ${pages.length} 页（全集 981 页），本轮全量跑 demo`,
        `其中含表格的页面 ${pages.filter((p) => p.hasTable).length} 页、含公式的 ${pages.filter((p) => p.hasFormula).length} 页`,
        'GT 文本 = 标注 text 字段 + 表格 html 去标签 + 公式 latex（表格在标注里没有 text 字段，只取 text 会漏掉表格内容）',
        '指标为自实现的片段召回/数字召回/编辑距离比/ROUGE-L，**不是**官方 TEDS/CDM/编辑距离口径',
        '中文页面占比见 byLanguage；研报类页面与平台场景最接近',
      ],
    }
  },

  async run({ tasks, client, concurrency = 3, log = () => {} }) {
    let done = 0
    const rows = await mapLimit(tasks, Math.min(concurrency, 3), async (t) => {
      const t0 = Date.now()
      try {
        const imgPath = F.rawPath(t.image)
        const bytes = fs.statSync(imgPath).size
        const r = await client.vision({
          system: '你是专业的文档数字化助手。逐字转写整页内容，输出 Markdown；表格用 Markdown 表格，公式用 LaTeX。不要总结、不要解释、不要补充图中没有的内容。',
          user: '请转写这一页的全部内容，保留阅读顺序与层级结构。',
          images: [imgPath],
          maxTokens: 8000,
          kind: 'omnidocbench',
        })
        const fid = G.textFidelity(t.gt, r.text)
        done++
        if (done % 5 === 0) log(`  OmniDocBench ${done}/${tasks.length}`)
        return {
          ...t,
          gt: undefined,
          gtChars: t.gt.length,
          imageKB: Number((bytes / 1024).toFixed(1)),
          prediction: r.text,
          grade: fid,
          // 页面级"可用"判据：片段召回 ≥ 80% 且数字召回 ≥ 90%（阈值是自定的，报告中写明）
          correct: r.truncated && !r.text ? null : fid.segment.recall !== null && fid.segment.recall >= 0.8 && (fid.number.recall === null || fid.number.recall >= 0.9),
          truncated: !!r.truncated,
          ms: Date.now() - t0,
          usage: r.usage,
          error: null,
        }
      } catch (e) {
        return { ...t, gt: undefined, prediction: '', grade: null, correct: null, ms: Date.now() - t0, error: String(e.message).slice(0, 300) }
      }
    })

    const clean = rows.filter((r) => !r.error && r.grade)
    const mean = (arr, f) => (arr.length ? Number((arr.reduce((s, x) => s + (f(x) || 0), 0) / arr.length).toFixed(4)) : null)
    const pagePass = clean.filter((r) => r.correct).length
    const withTable = clean.filter((r) => r.hasTable)
    const noTable = clean.filter((r) => !r.hasTable)
    const metrics = {
      metric: '自实现保真度：片段召回 / 数字召回 / 字符编辑距离比 / ROUGE-L（非官方 TEDS/CDM 口径）',
      pages: { n: clean.length, pass: pagePass, passRatePct: clean.length ? K.pct(pagePass / clean.length) : null, threshold: '片段召回≥80% 且 数字召回≥90%' },
      meanSegmentRecall: mean(clean, (r) => r.grade.segment.recall),
      meanNumberRecall: mean(clean, (r) => r.grade.number.recall),
      meanEditRatio: mean(clean, (r) => r.grade.editRatio),
      meanRougeL: mean(clean, (r) => r.grade.rougeL),
      tablePages: {
        n: withTable.length,
        meanSegmentRecall: mean(withTable, (r) => r.grade.segment.recall),
        meanNumberRecall: mean(withTable, (r) => r.grade.number.recall),
        meanEditRatio: mean(withTable, (r) => r.grade.editRatio),
        note: '含表格页面：财报/研报里最要紧的一类，单独列出',
      },
      nonTablePages: {
        n: noTable.length,
        meanSegmentRecall: mean(noTable, (r) => r.grade.segment.recall),
        meanNumberRecall: mean(noTable, (r) => r.grade.number.recall),
        meanEditRatio: mean(noTable, (r) => r.grade.editRatio),
      },
      bySource: {},
      byLanguage: {},
      errors: rows.filter((r) => r.error).length,
      truncated: rows.filter((r) => r.truncated).length,
      gtComposition: 'text + table-html(去标签) + equation-latex',
      notCovered: '表格结构（TEDS）、公式（CDM）、阅读顺序指标未实现',
    }
    for (const key of ['bySource', 'byLanguage']) {
      const field = key === 'bySource' ? 'dataSource' : 'language'
      const groups = {}
      for (const r of clean) {
        const k = r[field]
        groups[k] = groups[k] || { n: 0, seg: 0, num: 0, numN: 0, edit: 0 }
        groups[k].n++
        groups[k].seg += r.grade.segment.recall || 0
        if (r.grade.number.recall !== null) { groups[k].num += r.grade.number.recall; groups[k].numN++ }
        groups[k].edit += r.grade.editRatio || 0
      }
      metrics[key] = Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, {
        n: v.n,
        meanSegmentRecall: Number((v.seg / v.n).toFixed(4)),
        meanNumberRecall: v.numN ? Number((v.num / v.numN).toFixed(4)) : null,
        meanEditRatio: Number((v.edit / v.n).toFixed(4)),
      }]))
    }
    return { rows, metrics, groups: metrics.bySource }
  },
}
