/**
 * 重排（rerank）离线评估：先召回 recallK，再按精确性信号筛到 k。
 * 评价不止看"命中率"，还看**命中且集中**（覆盖率），因为精度问题的根源是上下文噪声。
 *
 *   node bench/external/d1/tune-rerank.js
 */
const fs = require('node:fs')
const path = require('node:path')
const F = require('../lib/fetch')
const { buildRetriever, retrievalHit } = require('./retrieval')

const EXT = path.join(__dirname, '..')
const TXT_DIR = path.join(EXT, 'cache', 'raw', 'financebench_text')

const CONFIGS = [
  { id: 'A', desc: '加权 top-8（= D1 v2 的 k=8 版本）', k: 8, rerank: false },
  { id: 'B', desc: '召回 24 → 重排取 8', k: 8, rerank: true, recallK: 24 },
  { id: 'C', desc: '召回 24 → 重排取 12', k: 12, rerank: true, recallK: 24 },
  { id: 'D', desc: '召回 40 → 重排取 8', k: 8, rerank: true, recallK: 40 },
  { id: 'E', desc: '召回 24 → 重排取 16', k: 16, rerank: true, recallK: 24 },
  { id: 'F', desc: '加权 top-16（= D1 v2 实跑配置）', k: 16, rerank: false },
  { id: 'G', desc: '加权 top-24', k: 24, rerank: false },
]

;(async () => {
  const questions = F.parseJsonl(F.rawText('financebench/open_source.jsonl')).rows.map((r) => ({
    id: r.financebench_id, doc: r.doc_name, type: r.question_type, question: r.question,
    evidence: (r.evidence || []).map((e) => e.evidence_text || '').join('\n\n'),
  }))
  const byDoc = new Map()
  for (const q of questions) {
    if (!byDoc.has(q.doc)) byDoc.set(q.doc, [])
    byDoc.get(q.doc).push(q)
  }
  const res = Object.fromEntries(CONFIGS.map((c) => [c.id, { ...c, n: 0, hit: 0, cov: 0, chars: 0, perType: {} }]))
  let docsDone = 0
  for (const [doc, qs] of byDoc) {
    const f = path.join(TXT_DIR, `${doc}.txt`)
    if (!fs.existsSync(f)) continue
    const text = fs.readFileSync(f, 'utf8')
    for (const c of CONFIGS) {
      const r = buildRetriever(text, { rerank: !!c.rerank })
      for (const q of qs) {
        const picked = r.topK(q.question, c.k, { recallK: c.recallK || 0 })
        const ev = picked.map((p) => p.text).join('\n\n')
        const h = retrievalHit(ev, q.evidence)
        const slot = res[c.id]
        slot.n++
        slot.cov += h.coverage
        slot.chars += ev.length
        if (h.hit) slot.hit++
        slot.perType[q.type] = slot.perType[q.type] || { n: 0, hit: 0 }
        slot.perType[q.type].n++
        if (h.hit) slot.perType[q.type].hit++
      }
    }
    docsDone++
    if (docsDone % 15 === 0) process.stdout.write(`\r  ${docsDone}/${byDoc.size} 份文档`)
  }
  process.stdout.write('\n\n')
  console.log('=== 重排策略对比（n=150，以论文标注证据为真值）===')
  console.log('编号  说明                          命中率   平均覆盖率  平均证据字数  指标类    领域推理  新颖生成')
  for (const c of CONFIGS) {
    const r = res[c.id]
    const p = (t) => (r.perType[t] ? `${r.perType[t].hit}/${r.perType[t].n}` : '—')
    console.log(`${c.id}     ${c.desc.padEnd(28)} ${((r.hit / r.n) * 100).toFixed(1).padStart(5)}%  ${((r.cov / r.n) * 100).toFixed(1).padStart(6)}%   ${Math.round(r.chars / r.n).toString().padStart(8)}    ${p('metrics-generated').padEnd(9)} ${p('domain-relevant').padEnd(9)} ${p('novel-generated')}`)
  }
  const out = path.join(EXT, 'out', 'd1-rerank-tuning.json')
  fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), n: questions.length, configs: CONFIGS.map((c) => ({ ...c, hitPct: Number(((res[c.id].hit / res[c.id].n) * 100).toFixed(2)), coveragePct: Number(((res[c.id].cov / res[c.id].n) * 100).toFixed(2)), meanChars: Math.round(res[c.id].chars / res[c.id].n), perType: res[c.id].perType })) }, null, 2))
  console.log(`\n产物 → ${path.relative(path.join(EXT, '..', '..'), out)}`)
})()
