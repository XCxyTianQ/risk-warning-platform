/**
 * 把 dev 上所有变体的存量答案，用**同一个多数投票裁判**重判并汇总成一张表。
 *
 * 为什么必须重判：诊断发现单次裁判在 n=60 上有 ±2~3 题的噪声，
 * 而各变体之间的差异恰好就是这个量级——不降噪就无法判断谁真的更好。
 * 重判只调用裁判（便宜），不重新让模型作答。
 *
 *   node bench/html/rejudge-all.js --votes 3
 */
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const REPO = path.resolve(__dirname, '..', '..')
const EXP = path.join(REPO, 'bench', 'external', 'out', 'experiments')
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }
const votes = arg('--votes', '3')

// 每个变体只取最新一份 dev 结果（B1 有两份：修正前/修正后，取最新即修正后）
const VARIANTS = ['A0', 'A1', 'A2', 'B1', 'B1b', 'B2']
const picked = {}
for (const v of VARIANTS) {
  const files = fs.readdirSync(EXP).filter((f) => new RegExp(`^exp-${v}-dev-.*\\.json$`).test(f)).sort()
  if (files.length) picked[v] = files[files.length - 1]
}
console.log(`参加重判的变体：${Object.entries(picked).map(([k, f]) => `${k}(${f.slice(4, 17)})`).join('，')}\n`)

const results = []
for (const [v, file] of Object.entries(picked)) {
  const r = spawnSync('node', [path.join(REPO, 'bench', 'external', 'tools', 'exp-financebench.js'), '--rejudge', file, '--judge-votes', votes, '--concurrency', '6'], { encoding: 'utf8', cwd: REPO })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  const m = out.match(/重判后：(\d+)\/(\d+) = ([\d.]+)%/)
  const byType = {}
  for (const mm of out.matchAll(/^\s{6}(\S+): (\d+)\/(\d+)$/gm)) byType[mm[1]] = `${mm[2]}/${mm[3]}`
  if (m) {
    results.push({ variant: v, file, correct: +m[1], n: +m[2], pct: +m[3], byType })
    console.log(`✅ ${v.padEnd(4)} ${m[3]}%  (${m[1]}/${m[2]})   ${Object.entries(byType).map(([k, x]) => `${k.slice(0, 8)}=${x}`).join(' ')}`)
  } else {
    results.push({ variant: v, file, error: out.slice(-300) })
    console.log(`❌ ${v}: 重判失败\n${out.slice(-300)}`)
  }
}

const base = results.find((r) => r.variant === 'A1')
console.log('\n=== 同一裁判（多数投票）下的 dev 对比（n=60）===')
for (const r of results) {
  const d = base && r.pct !== undefined ? `  相对 A1：${r.pct - base.pct >= 0 ? '+' : ''}${(r.pct - base.pct).toFixed(1)}pp` : ''
  console.log(`  ${r.variant.padEnd(4)} ${r.pct === undefined ? '—' : r.pct + '%'}${d}`)
}
fs.writeFileSync(path.join(REPO, 'bench', 'external', 'out', 'variant-comparison.json'), JSON.stringify({ generatedAt: new Date().toISOString(), judgeVotes: +votes, split: 'dev(60)', results }, null, 2))
console.log('\n已写出 bench/external/out/variant-comparison.json')
