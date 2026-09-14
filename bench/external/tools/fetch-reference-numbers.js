/**
 * 抓取"外部公开数字"作为对照锚点，并记录出处。
 *
 * 原则：**能拿到原始的，就不要引用二手转述**。
 *  - OmniDocBench：仓库自带 result/end2end_quick_match_metric_result.json（官方 quick-match 结果）
 *  - CFLUE：论文正文（ar5iv HTML）里的结果表
 *  - BFCL：仓库内**没有**归档榜单分数（榜单是网页应用），因此只记录"拿不到"，不做二手引用
 *  - FinanceBench：论文各模型逐题结果就在仓库里 → 准确率由我们自己对公开标签统计得出（最可靠）
 */
const fs = require('node:fs')
const path = require('node:path')
const F = require('../lib/fetch')
const S = require('../sources')

const OUT = path.join(__dirname, '..', 'out')
F.ensureDir(OUT)

const stripTags = (h) => String(h).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ')
/** Python 的 json.dump 会写出 NaN/Infinity，标准 JSON.parse 会拒绝——这里做容错 */
const parseLoose = (t) => JSON.parse(String(t).replace(/\bNaN\b/g, 'null').replace(/\b-?Infinity\b/g, 'null'))

/** 把 markdown 表格解析成对象数组（CFLUE 官方 README 里的榜单就是这个格式） */
function parseMdTables(md) {
  const lines = String(md).split(/\r?\n/)
  const tables = []
  let cur = null
  for (const line of lines) {
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
      if (/^[\s\-:|]+$/.test(cells.join(''))) continue // 分隔行
      if (!cur) { cur = { header: cells, rows: [] }; tables.push(cur) } else cur.rows.push(cells)
    } else cur = null
  }
  return tables.filter((t) => t.rows.length)
}

;(async () => {
  const out = { generatedAt: new Date().toISOString(), note: '外部公开对照数字及其出处；每条都记录了来源 URL 与抓取哈希', items: [] }

  // ---------- OmniDocBench 官方 quick-match 结果 ----------
  console.log('=== OmniDocBench 官方 quick-match 结果 ===')
  try {
    const r = await S.repoFile('omnidocbench', 'result/end2end_quick_match_metric_result.json', 'omnidocbench/official_metric_result.json')
    const j = parseLoose(F.rawText('omnidocbench/official_metric_result.json'))
    console.log('  顶层字段:', Object.keys(j).slice(0, 12).join(', '))
    console.log('  内容预览:', JSON.stringify(j).slice(0, 700))
    out.items.push({ source: 'OmniDocBench', kind: 'official_quick_match_metric', url: r.sourceUrl, sha256: r.sha256, bytes: r.bytes, note: '官方 quick-match 结果（原文件含 Python NaN，已容错解析）', raw: j })
  } catch (e) {
    console.log('  ❌ ' + e.message)
    out.items.push({ source: 'OmniDocBench', kind: 'official_quick_match_metric', error: String(e.message).slice(0, 200) })
  }

  // ---------- CFLUE 官方 README 的榜单表 ----------
  console.log('\n=== CFLUE 官方 README 榜单（markdown 表格）===')
  try {
    const r = await F.fetchToCache('cflue/README_zh.md', F.ghRaw('aliyun/cflue', 'master', 'README_zh.md'))
    const md = F.rawText('cflue/README_zh.md')
    const tables = parseMdTables(md)
    console.log(`  解析到 ${tables.length} 张表`)
    const scoreTables = []
    for (const t of tables) {
      const head = t.header.join(' ').toLowerCase()
      if (/acc|bleu|rouge|score/.test(head)) {
        scoreTables.push(t)
        console.log(`  表头: ${t.header.join(' | ')}`)
        t.rows.slice(0, 8).forEach((row) => console.log('     ' + row.join(' | ')))
      }
    }
    out.items.push({ source: 'CFLUE', kind: 'official_leaderboard_table', url: r.url || F.ghBlob('aliyun/cflue', 'master', 'README_zh.md'), sha256: r.sha256, tables: scoreTables })
  } catch (e) {
    console.log('  ❌ ' + e.message)
    out.items.push({ source: 'CFLUE', kind: 'official_leaderboard_table', error: String(e.message).slice(0, 200) })
  }

  // ---------- CFLUE 论文正文（ar5iv 可能不可达，失败即如实记录）----------
  console.log('\n=== CFLUE 论文正文 ===')
  try {
    const r = await F.fetchToCache('refs/cflue_paper.html', 'https://ar5iv.labs.arxiv.org/html/2405.10542')
    const text = stripTags(F.rawText('refs/cflue_paper.html'))
    const sents = text.split(/(?<=[.。])\s+/).filter((s) => /(GPT-?4|ChatGPT|accuracy|准确率)/i.test(s) && /\d+(\.\d+)?\s*%/.test(s))
    console.log(`  命中 ${sents.length} 句`)
    sents.slice(0, 8).forEach((s) => console.log('     ' + s.trim().slice(0, 180)))
    out.items.push({ source: 'CFLUE', kind: 'paper_text', url: 'https://ar5iv.labs.arxiv.org/html/2405.10542', sha256: r.sha256, sampleSentences: sents.slice(0, 20).map((s) => s.trim().slice(0, 400)) })
  } catch (e) {
    console.log(`  ❌ 论文正文不可达（如实记录，不引用二手转述）: ${String(e.message).slice(0, 120)}`)
    out.items.push({ source: 'CFLUE', kind: 'paper_text', url: 'https://ar5iv.labs.arxiv.org/html/2405.10542', error: String(e.message).slice(0, 200), note: '不可达，未引用' })
  }

  // ---------- BFCL：有没有归档分数 ----------
  console.log('\n=== BFCL 归档分数可得性 ===')
  try {
    const r = await S.repoFile('bfcl', 'berkeley-function-call-leaderboard/README.md', 'bfcl/README.md')
    const text = F.rawText('bfcl/README.md')
    const scoreHits = text.split(/\r?\n/).filter((l) => /\d{1,3}(\.\d+)?\s*%/.test(l))
    console.log(`  README 中含百分比的行: ${scoreHits.length}`)
    scoreHits.slice(0, 5).forEach((l) => console.log('     ' + l.trim().slice(0, 160)))
    out.items.push({
      source: 'BFCL', kind: 'leaderboard_availability', url: r.sourceUrl, sha256: r.sha256,
      conclusion: '仓库未归档榜单分数（榜单为网页应用，README 仅含使用说明与示例百分比），因此本报告不引用二手榜单数字，仅做同题同口径的模型间对比',
      percentLinesInReadme: scoreHits.length,
    })
  } catch (e) {
    console.log('  ❌ ' + e.message)
  }

  // ---------- FinanceBench：由公开标签自行统计 ----------
  console.log('\n=== FinanceBench 论文各模型准确率（由仓库公开标签统计）===')
  const PUB = [
    ['gpt-4 (oracle)', 'financebench/results_gpt4_oracle.jsonl'],
    ['gpt-4 (closed book)', 'financebench/results_gpt4_closedbook.jsonl'],
    ['gpt-4-1106-preview (oracle)', 'financebench/results_gpt4_1106_oracle.jsonl'],
    ['claude-2 (in-context)', 'financebench/results_claude2_incontext.jsonl'],
    ['llama2-70b (single store)', 'financebench/results_llama2_singlestore.jsonl'],
  ]
  const fb = []
  for (const [label, key] of PUB) {
    try {
      const rows = F.parseJsonl(F.rawText(key)).rows
      const correct = rows.filter((r) => r.label === 'Correct Answer').length
      const refusal = rows.filter((r) => r.label === 'Refusal').length
      const pct = Number(((correct / rows.length) * 100).toFixed(2))
      console.log(`  ${label.padEnd(30)} n=${rows.length}  正确 ${correct}  拒答 ${refusal}  准确率 ${pct}%`)
      fb.push({ label, n: rows.length, correct, refusal, accuracyPct: pct })
    } catch (e) { console.log(`  ❌ ${label}: ${e.message}`) }
  }
  out.items.push({ source: 'FinanceBench', kind: 'published_model_accuracy', note: '由仓库 results/*.jsonl 的逐题 label 直接统计（n=150 开源子集）', models: fb })

  fs.writeFileSync(path.join(OUT, 'external-reference-numbers.json'), JSON.stringify(out, null, 2))
  console.log('\n已写入 bench/external/out/external-reference-numbers.json')
})()
