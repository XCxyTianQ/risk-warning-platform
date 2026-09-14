/**
 * E4 · BFCL v4（Berkeley Function Calling Leaderboard）非实时子集
 *
 * 回答的问题：平台 25 个工具 + MCP 的**底座模型**能不能选对函数、填对参数，
 * 以及在没有合适函数时能不能忍住不调用（irrelevance）。
 *
 * 三类子集（均有本地标准答案或明确判定规则）：
 *   - simple_python：单函数、直接调用
 *   - multiple：给了多个函数，只有一个是正确的
 *   - irrelevance：没有任何合适函数，正确行为是**不调用**
 *
 * 判分：判分逻辑逐行对照官方 ast_checker.py 移植（见 lib/grade.js 的说明），
 * 但**不是官方 checker**，报告中不得声称与官方榜单等分。
 * 未测：parallel / multi-turn / exec / live（需要执行环境与多轮交互，成本与收益不匹配）。
 */
const F = require('../lib/fetch')
const G = require('../lib/grade')
const K = require('../lib/kit')
const { sample } = require('../lib/sample')
const { mapLimit } = require('../lib/model')

const CATEGORIES = [
  { key: 'simple', file: 'bfcl/simple_python.jsonl', ans: 'bfcl/ans_simple_python.jsonl', category: 'simple', label: 'simple（单函数）' },
  { key: 'multiple', file: 'bfcl/multiple.jsonl', ans: 'bfcl/ans_multiple.jsonl', category: 'multiple', label: 'multiple（多函数选一）' },
  { key: 'irrelevance', file: 'bfcl/irrelevance.jsonl', ans: null, category: 'irrelevance', label: 'irrelevance（应拒调）' },
]

function loadCategory(c) {
  const q = F.parseJsonl(F.rawText(c.file)).rows
  const a = c.ans ? new Map(F.parseJsonl(F.rawText(c.ans)).rows.map((x) => [x.id, x.ground_truth])) : null
  return q.map((row) => {
    const turns = row.question || []
    const first = Array.isArray(turns[0]) ? turns[0] : turns
    return {
      id: row.id,
      kind: c.key,
      group: `BFCL/${c.label}`,
      category: c.category,
      user: (first.find((m) => m.role === 'user') || first[0] || {}).content || '',
      functions: row.function || [],
      gold: a ? a.get(row.id) || null : null,
      funcCount: (row.function || []).length,
    }
  })
}

module.exports = {
  id: 'bfcl',
  title: 'BFCL v4（工具调用：simple / multiple / irrelevance）',
  layer: '工具调用层：平台 25 个工具与 MCP 接入的底座能力',
  requiresVision: false,
  source: { repo: 'ShishirPatil/gorilla', ref: 'main', paper: 'https://gorilla.cs.berkeley.edu/leaderboard.html' },

  async plan({ seed = 20260101, sizes = {} } = {}) {
    const all = {}
    const tasks = []
    const sampleInfo = {}
    for (const c of CATEGORIES) {
      const items = loadCategory(c)
      all[c.key] = items
      const n = sizes[c.key] ?? (c.key === 'irrelevance' ? 120 : 200)
      const s = sample(items, n, seed + c.key.length, (x) => x.id)
      tasks.push(...s.items)
      sampleInfo[c.key] = { available: items.length, picked: s.items.length, hash: s.hash, seed: seed + c.key.length, label: c.label }
    }
    return {
      tasks,
      sample: sampleInfo,
      notes: [
        '判分为官方 ast_checker.py 的自实现移植（含错误类型分类），不是官方 checker，不得与官方榜单分数直接等同',
        '函数 schema 由 BFCL 的 Python 口径（type=dict/float）转换为 JSON Schema 后传入，转换器固定并可复查',
        '未测 parallel / multi-turn / exec / live 子集：需要执行环境与多轮交互',
      ],
    }
  },

  async run({ tasks, client, concurrency = 4, log = () => {} }) {
    let done = 0
    const rows = await mapLimit(tasks, concurrency, async (t) => {
      const t0 = Date.now()
      try {
        const r = await client.tools({
          system: 'You are a helpful assistant that answers questions by calling the provided functions when appropriate. If none of the functions can answer the question, answer in plain text without calling any function.',
          user: t.user,
          tools: K.toOpenAITools(t.functions),
          toolChoice: 'auto',
          maxTokens: 3072,
          kind: `bfcl-${t.kind}`,
        })
        let grade
        if (t.kind === 'irrelevance') {
          // 官方口径：irrelevance 没有标准答案文件，正确行为是不产生任何函数调用
          grade = { correct: r.calls.length === 0, called: r.calls.map((c) => c.name), error_type: r.calls.length ? 'irrelevance:called_a_function' : null }
          if (r.calls.length) {
            // 进一步区分"调了个不存在的函数"与"调了个存在的函数"（后者更严重）
            grade.calledExisting = r.calls.filter((c) => t.functions.some((f) => G.normalizeFuncName(f.name) === G.normalizeFuncName(c.name))).length > 0
          }
        } else {
          const res = G.bfclAstCheck(t.functions, r.calls, t.gold || [], t.category)
          grade = { correct: res.valid, error_type: res.error_type || null, errors: (res.error || []).slice(0, 2).map((e) => String(e).slice(0, 160)), callCount: r.calls.length }
        }
        done++
        if (done % 25 === 0) log(`  BFCL ${done}/${tasks.length}`)
        return {
          ...t,
          gold: undefined,
          functions: undefined,
          funcCount: t.funcCount,
          prediction: r.calls.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join(' | ') || r.text.trim().slice(0, 300),
          calls: r.calls,
          grade,
          correct: grade.correct,
          ms: Date.now() - t0,
          usage: r.usage,
          error: null,
        }
      } catch (e) {
        return { ...t, functions: undefined, prediction: '', grade: null, correct: null, ms: Date.now() - t0, error: String(e.message).slice(0, 300) }
      }
    })

    const clean = rows.filter((r) => !r.error)
    const byKind = K.aggregate(clean, { groupKey: 'group' })
    const errorTypes = {}
    for (const r of clean) {
      if (r.grade && r.grade.error_type) errorTypes[r.grade.error_type] = (errorTypes[r.grade.error_type] || 0) + 1
    }
    const metrics = {
      overall: byKind.__ALL__,
      byCategory: byKind,
      errorTypeDistribution: errorTypes,
      wrongFunctionName: clean.filter((r) => r.grade && r.grade.error_type === 'simple_function_checker:wrong_func_name').length,
      overCallRate: clean.filter((r) => r.grade && r.grade.callCount > 1).length,
      errors: rows.filter((r) => r.error).length,
      scoring: '自实现 AST 判定（对照官方 ast_checker.py 移植）',
    }
    return { rows, metrics, groups: byKind }
  },
}
