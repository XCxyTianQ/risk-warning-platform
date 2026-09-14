/**
 * 口径 A / B 的真实差距：把三件事分开算清楚
 *  ① 样本是否同一批（此前 A 是 298 题、B 是 60 题，直接相减是错的）
 *  ② 判分器是否读得懂（markdown 加粗等会误判为"无选项"）
 *  ③ 扣掉前两项后，剩下的才是"平台链路本身"的损失
 *
 *   node bench/external/tools/compare-chain-vs-direct.js
 */
const fs = require('node:fs')
const path = require('node:path')

const EXT = path.join(__dirname, '..')
const OUT = path.join(EXT, 'out')

const chainFiles = fs.readdirSync(OUT).filter((f) => /^platform-chain-.*\.json$/.test(f)).sort()
const chain = JSON.parse(fs.readFileSync(path.join(OUT, chainFiles[chainFiles.length - 1]), 'utf8'))
const cRows = (chain.cflue && chain.cflue.rows) || []

const ext = JSON.parse(fs.readFileSync(path.join(EXT, 'reports', 'external-alignment-v1.json'), 'utf8'))
const aRun = ((ext.benchmarks || {}).cflue || {}).runs['deepseek-flash']
const aRows = (aRun && aRun.rows) || []
const aDetail = (() => {
  // 口径 A 的逐题明细在 run-*/cflue.deepseek-flash.json
  const dirs = fs.readdirSync(OUT).filter((d) => d.startsWith('run-')).sort()
  for (const d of dirs.slice().reverse()) {
    const f = path.join(OUT, d, 'cflue.deepseek-flash.json')
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'))
  }
  return null
})()

console.log('=== ① 样本是否同一批 ===')
console.log(`  口径 B（平台链路）：n=${cRows.length}  样本哈希=${(chain.cflue || {}).sampleHash || '未记'}`)
console.log(`  口径 A（官方运行）：n=${(aDetail && aDetail.rows ? aDetail.rows.length : aRows.length)}  样本哈希=${((ext.benchmarks.cflue.sample || {}).knowledge || {}).hash}`)
const aIds = new Set(((aDetail && aDetail.rows) || aRows).map((r) => r.id))
const overlap = cRows.filter((r) => aIds.has(r.id))
console.log(`  两批题号交集：${overlap.length}/${cRows.length} → ${overlap.length === cRows.length ? 'B 是 A 的子集，可在交叠题上直接比' : '存在 B 独有的题，必须在交叠题上比'}`)

/** 判分器归一化：去掉 markdown 与解释性文字，只取选项字母 */
function normLetters(s) {
  const t = String(s || '')
    .replace(/\*\*|__|`/g, '')            // markdown 强调
    .replace(/\s+/g, ' ')
    .trim()
  // 优先取开头连续的选项字母（含组合）
  const head = t.match(/^\s*([A-E](?:\s*[、,，]?\s*[A-E])*)/)
  const letters = (x) => [...new Set((x.match(/[A-E]/g) || []))]
  if (head) return letters(head[1]).sort().join('')
  // 退化：全文里出现的选项字母（排除解释性英文单词里的字母）
  const m = t.match(/\b([A-E]{1,6})\b/g)
  if (m) {
    const cand = m.map((x) => letters(x).sort().join('')).filter((x) => x.length >= 1)
    if (cand.length) return cand.sort((a, b) => b.length - a.length)[0]
  }
  return ''
}
const goldLetters = (g) => [...new Set((String(g).toUpperCase().match(/[A-E]/g) || []))].sort().join('')

console.log('\n=== ② 判分器读不读得懂 ===')
let parseFail = 0
let parseFailButCorrect = 0
for (const r of cRows) {
  const got = normLetters(r.prediction)
  if (!got) { parseFail++; continue }
  if (got === goldLetters(r.gold) && !r.correct) parseFailButCorrect++
}
console.log(`  原判分下"无选项"的比例：${cRows.filter((r) => !/\b[A-E]\b/.test(String(r.prediction))).length}/${cRows.length}`)
console.log(`  归一化后仍取不到字母：${parseFail}/${cRows.length}`)
console.log(`  归一化后"其实是答对但原判分判错"：${parseFailButCorrect} 题`)

// 重算：用归一化判分
let fixed = 0
for (const r of cRows) {
  const got = normLetters(r.prediction)
  if (got && got === goldLetters(r.gold)) fixed++
}
const origCorrect = cRows.filter((r) => r.correct).length
console.log(`\n  口径 B 原判：${origCorrect}/${cRows.length} = ${((origCorrect / cRows.length) * 100).toFixed(2)}%`)
console.log(`  口径 B 归一化判分：${fixed}/${cRows.length} = ${((fixed / cRows.length) * 100).toFixed(2)}%  （+${(((fixed - origCorrect) / cRows.length) * 100).toFixed(1)}pp）`)

console.log('\n=== ③ 在交叠题上与口径 A 比 ===')
const ids = overlap.map((r) => r.id)
const aMap = new Map(((aDetail && aDetail.rows) || aRows).map((r) => [r.id, r]))
let aC = 0, bC = 0, bFixC = 0
for (const r of overlap) {
  const a = aMap.get(r.id)
  if (a && a.correct) aC++
  if (r.correct) bC++
  const got = normLetters(r.prediction)
  if (got && got === goldLetters(r.gold)) bFixC++
}
const p = (x) => `${((x / overlap.length) * 100).toFixed(2)}%`
console.log(`  同一批 ${overlap.length} 题上：`)
console.log(`    口径 A（直连模型）      ${aC}/${overlap.length} = ${p(aC)}`)
console.log(`    口径 B（平台链路，原判） ${bC}/${overlap.length} = ${p(bC)}`)
console.log(`    口径 B（归一化判分）     ${bFixC}/${overlap.length} = ${p(bFixC)}`)
console.log(`\n  → 真实差距（A − B归一化）= ${(((aC - bFixC) / overlap.length) * 100).toFixed(1)}pp`)
console.log(`  → 其中"判分口径"贡献 = ${(((bFixC - bC) / overlap.length) * 100).toFixed(1)}pp`)

// 工具使用与耗时的旁证
console.log('\n=== 旁证：工具使用与耗时 ===')
console.log(`  口径 B 用过平台工具的行：${(chain.cflue || {}).usedTools || 0}/${cRows.length}  → 这些题根本不需要工具（选择题）`)
console.log(`  口径 B 平均耗时：${Math.round((chain.cflue || {}).meanMs || 0)} ms/题`)
if (aDetail && aDetail.rows) {
  const ms = aDetail.rows.map((r) => r.ms).filter(Boolean)
  console.log(`  口径 A 平均耗时：${Math.round(ms.reduce((s, x) => s + x, 0) / Math.max(1, ms.length))} ms/题`)
}
const out = {
  generatedAt: new Date().toISOString(),
  chainFile: chainFiles[chainFiles.length - 1],
  sample: { chainN: cRows.length, chainHash: (chain.cflue || {}).sampleHash || null, directN: (aDetail && aDetail.rows ? aDetail.rows.length : aRows.length), overlap: overlap.length },
  parse: { noLetterOriginal: cRows.filter((r) => !/\b[A-E]\b/.test(String(r.prediction))).length, stillUnparsable: parseFail, actuallyCorrect: parseFailButCorrect },
  accuracy: { bOriginalPct: Number(((origCorrect / cRows.length) * 100).toFixed(2)), bNormalizedPct: Number(((fixed / cRows.length) * 100).toFixed(2)), onOverlap: { directPct: Number(((aC / overlap.length) * 100).toFixed(2)), chainRawPct: Number(((bC / overlap.length) * 100).toFixed(2)), chainNormalizedPct: Number(((bFixC / overlap.length) * 100).toFixed(2)) } },
  tools: { usedRows: (chain.cflue || {}).usedTools || 0, meanMsChain: Math.round((chain.cflue || {}).meanMs || 0) },
}
fs.writeFileSync(path.join(OUT, 'chain-vs-direct.json'), JSON.stringify(out, null, 2))
console.log('\n产物 → bench/external/out/chain-vs-direct.json')
