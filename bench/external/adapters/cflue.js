/**
 * E1 · CFLUE（ACL 2024 Findings）
 *
 * 两部分：
 *  A. 财务知识单选题 3,864 题（含答案）→ 官方指标就是准确率，可直接与榜单口径对齐
 *  B. 金融文本应用 125 条（25 个子任务 × 5）→ 官方用 BLEU/ROUGE/BERTScore，
 *     我们只对"分类/抽取/问答"这类有确定答案的子任务判对错，生成与翻译类只报 ROUGE-L
 *     并明确标注"不可与官方榜单分数直接比较"。
 */
const F = require('../lib/fetch')
const G = require('../lib/grade')
const K = require('../lib/kit')
const { sample, sampleStratified } = require('../lib/sample')
const { mapLimit } = require('../lib/model')

/** CFLUE 的 choices 字段是 Python dict 字面量，用带转义的配对正则解析，并统计解析失败数 */
function parseChoices(s) {
  const out = []
  if (!s) return out
  const re = /'([A-H])'\s*:\s*'((?:[^'\\]|\\.)*)'/g
  let m
  while ((m = re.exec(s))) out.push({ key: m[1], text: m[2].replace(/\\'/g, "'").replace(/\\\\/g, '\\') })
  if (!out.length) {
    const re2 = /"([A-H])"\s*:\s*"((?:[^"\\]|\\.)*)"/g
    while ((m = re2.exec(s))) out.push({ key: m[1], text: m[2] })
  }
  return out
}

const TASK_HINT = {
  单项选择题: '本题为单项选择题，有且只有一个正确答案。',
  多项选择题: '本题为多项选择题，可能有多个正确答案，请输出全部正确选项的字母（例如 ABD，字母间不要加空格）。',
  判断题: '本题为判断题，A 表示"对"，B 表示"错"。',
}

function loadKnowledge() {
  const rows = JSON.parse(F.rawText('cflue/knowledge.json'))
  const warnings = { choicesParseFail: 0, fewOptions: 0 }
  const items = rows.map((r, i) => {
    const choices = parseChoices(r.choices)
    if (!choices.length) warnings.choicesParseFail++
    else if (choices.length < 2) warnings.fewOptions++
    return {
      id: `knowledge_${i}`,
      kind: 'knowledge',
      group: `${r.task} / ${r['名称']}`,
      taskType: r.task,
      subject: r['名称'],
      question: r.question,
      choices,
      gold: String(r.answer || '').trim(),
      answerCount: String(r.answer || '').trim().length,
    }
  })
  return { items, warnings }
}

function loadApplication() {
  const rows = JSON.parse(F.rawText('cflue/application.json'))
  const items = rows.map((r, i) => ({
    id: `application_${i}`,
    kind: 'application',
    group: `${r.task} / ${r.sub_task}`,
    taskType: r.task,
    subTask: r.sub_task,
    instruction: r.instruction || '',
    input: r.input || '',
    // 有 10 条（金融事件因果关系抽取）参考输出本身就是结构化 JSON，统一成字符串再判分
    gold: typeof r.output === 'string' ? r.output : JSON.stringify(r.output),
    structuredGold: typeof r.output !== 'string',
    hasHistory: Array.isArray(r.history) ? r.history.length > 0 : !!r.history,
  }))
  return { items }
}

/** 各子任务的判分策略（写进报告，避免"挑着判"的质疑） */
function policyOf(taskType) {
  if (taskType === '金融文本分类') return { mode: 'contains', note: '类别标签存在于输出即算对（官方 acc_score 为字符串精确匹配，我们两者都记）' }
  if (taskType === '金融文本抽取') return { mode: 'json', note: '解析输出的 JSON，按键值对集合算 F1；解析失败则退化为包含判定' }
  if (taskType === '金融咨询') return { mode: 'contains', note: '标准答案要点出现在输出中即算对，另报 ROUGE-L' }
  return { mode: 'rouge', note: '生成/翻译类：官方用 BLEU/ROUGE/BERTScore，我们只报 ROUGE-L，不计入准确率' }
}

/** 结构化比对：对象按键值对、数组按元素多重集，均做归一化后比较 */
function structuredF1(gold, got) {
  const norm = (v) => G.normChars(typeof v === 'string' ? v : JSON.stringify(v))
  if (Array.isArray(gold)) {
    if (!Array.isArray(got)) return 0
    const g = gold.map(norm), o = got.map(norm)
    const used = new Array(o.length).fill(false)
    let hit = 0
    for (const x of g) {
      const i = o.findIndex((y, idx) => !used[idx] && y === x)
      if (i >= 0) { used[i] = true; hit++ }
    }
    const precision = o.length ? hit / o.length : 0
    const recall = g.length ? hit / g.length : 0
    return precision + recall ? (2 * precision * recall) / (precision + recall) : 0
  }
  const gk = Object.keys(gold), ok = Object.keys(got)
  const hit = gk.filter((k) => ok.includes(k) && norm(got[k]) === norm(gold[k])).length
  const precision = ok.length ? hit / ok.length : 0
  const recall = gk.length ? hit / gk.length : 0
  return precision + recall ? (2 * precision * recall) / (precision + recall) : 0
}

function gradeApplication(item, pred) {
  const policy = policyOf(item.taskType)
  const p = String(pred || '')
  const rl = G.rougeL(item.gold, p)
  const base = { policy: policy.mode, note: policy.note, rougeL: Number(rl.f1.toFixed(4)), exact: G.normChars(p) === G.normChars(item.gold) }
  if (policy.mode === 'contains') {
    return { ...base, correct: G.normChars(p).includes(G.normChars(item.gold)) && G.normChars(item.gold).length > 0 }
  }
  if (policy.mode === 'json') {
    let gold = null, got = null
    try { gold = JSON.parse(item.gold) } catch { /* 参考输出不是 JSON */ }
    const mo = p.match(/\{[\s\S]*\}/)
    const ma = mo ? null : p.match(/\[[\s\S]*\]/)
    const raw = mo ? mo[0] : ma ? ma[0] : null
    if (raw) { try { got = JSON.parse(raw) } catch { /* 解析失败 */ } }
    if (gold && got) {
      const f1 = structuredF1(gold, got)
      return { ...base, jsonF1: Number(f1.toFixed(4)), correct: f1 >= 1 }
    }
    return { ...base, correct: G.normChars(p).includes(G.normChars(item.gold)) }
  }
  return { ...base, correct: null }
}

module.exports = {
  id: 'cflue',
  title: 'CFLUE',
  layer: '模型层：中文金融知识与指令遵循',
  source: { repo: 'aliyun/cflue', ref: 'master', paper: 'https://aclanthology.org/2024.findings-acl.337/' },

  plan({ seed = 20260101, sizes = {} } = {}) {
    const kn = loadKnowledge()
    const ap = loadApplication()
    const knSample = sample(kn.items, sizes.knowledge ?? 300, seed, (x) => x.id)
    const apSample = sampleStratified(ap.items, sizes.application ?? 999, seed + 1, (x) => x.subTask, (x) => x.id, 5)
    const notes = []
    if (kn.warnings.choicesParseFail) notes.push(`选项解析失败 ${kn.warnings.choicesParseFail} 题（已排除在样本外）`)
    const usable = knSample.items.filter((x) => x.choices.length >= 2)
    const dropped = knSample.items.length - usable.length
    if (dropped) notes.push(`抽样后因选项不足剔除 ${dropped} 题`)
    notes.push(`知识题 ${kn.items.length} → 抽 ${usable.length}；应用题 ${ap.items.length} → 抽 ${apSample.items.length}（25 子任务各 5 条，全量）`)
    return {
      tasks: [...usable, ...apSample.items],
      sample: {
        knowledge: { available: kn.items.length, picked: usable.length, ids: usable.map((x) => x.id), hash: require('../lib/sample').hashOf(usable.map((x) => x.id).join('\n')), seed },
        application: { available: ap.items.length, picked: apSample.items.length, hash: apSample.hash, seed: seed + 1, perSubTask: apSample.perStratum },
      },
      notes,
    }
  },

  async run({ tasks, client, concurrency = 6, log = () => {} }) {
    const kn = tasks.filter((t) => t.kind === 'knowledge')
    const ap = tasks.filter((t) => t.kind === 'application')
    const rows = []
    let done = 0

    const knRows = await mapLimit(kn, concurrency, async (t) => {
      const opts = t.choices.map((c) => `${c.key}. ${c.text}`).join('\n')
      const user = `${TASK_HINT[t.taskType] || ''}\n\n题目：${t.question}\n选项：\n${opts}`
      const t0 = Date.now()
      try {
        const r = await client.chat({
          system: '你是金融领域知识评测的答题者。只输出答案字母，不要任何解释、不要复述题目。',
          user,
          maxTokens: 2048,
          kind: 'cflue-knowledge',
        })
        const g = G.gradeMcq(r.text, t.gold)
        done++
        if (done % 25 === 0) log(`  CFLUE 知识题 ${done}/${kn.length}`)
        return {
          ...t,
          prediction: r.text.trim(),
          grade: g,
          correct: r.truncated && !r.text ? null : g.correct,
          truncated: !!r.truncated,
          error: r.truncated && !r.text ? 'truncated（推理吃满预算且无正文）' : null,
          ms: Date.now() - t0,
          usage: r.usage,
        }
      } catch (e) {
        return { ...t, prediction: '', grade: null, correct: null, ms: Date.now() - t0, error: String(e.message).slice(0, 300) }
      }
    })

    const apRows = await mapLimit(ap, concurrency, async (t) => {
      const user = t.input && !t.instruction.includes(t.input) ? `${t.instruction}\n\n${t.input}` : t.instruction
      const t0 = Date.now()
      try {
        const r = await client.chat({
          system: '你是金融行业的专业助手。严格按题目要求作答，不要输出与题目要求无关的内容。',
          user,
          maxTokens: 3072,
          kind: 'cflue-application',
        })
        const g = gradeApplication(t, r.text)
        done++
        if (done % 25 === 0) log(`  CFLUE 应用题 ${done - kn.length}/${ap.length}`)
        return { ...t, prediction: r.text.trim(), grade: g, correct: g.correct, ms: Date.now() - t0, usage: r.usage, error: null }
      } catch (e) {
        return { ...t, prediction: '', grade: null, correct: null, ms: Date.now() - t0, error: String(e.message).slice(0, 300) }
      }
    })

    rows.push(...knRows, ...apRows)

    // 指标：知识题按官方口径（准确率），应用题按判分策略分组
    const knGroups = K.aggregate(knRows.filter((r) => !r.error), { groupKey: 'group' })
    const knByTask = K.aggregate(knRows.filter((r) => !r.error), { groupKey: 'taskType' })
    const graded = apRows.filter((r) => !r.error && r.correct !== null)
    const apGroups = K.aggregate(graded, { groupKey: 'group' })
    const apByTask = K.aggregate(graded, { groupKey: 'taskType' })
    const rougeRows = apRows.filter((r) => !r.error && r.grade)
    const rouge = rougeRows.length ? rougeRows.reduce((s, r) => s + r.grade.rougeL, 0) / rougeRows.length : null

    const metrics = {
      knowledge: {
        metric: 'accuracy（官方口径）',
        overall: knGroups.__ALL__,
        byTaskType: knByTask,
        bySubject: knGroups,
        abstainRate: pctOf(knRows.filter((r) => r.grade && r.grade.abstained).length, knRows.length),
        extractMode: countBy(knRows, (r) => r.grade && r.grade.how),
        errors: knRows.filter((r) => r.error).length,
        multiSelectAccuracy: accuracyOf(knRows.filter((r) => r.taskType === '多项选择题')),
        singleSelectAccuracy: accuracyOf(knRows.filter((r) => r.taskType === '单项选择题')),
      },
      application: {
        metric: '分类/抽取/问答=判对率；生成/翻译=ROUGE-L（自实现，非官方分数）',
        overallGraded: apGroups.__ALL__ || null,
        byTaskType: apByTask,
        bySubTask: apGroups,
        meanRougeL: rouge === null ? null : Number(rouge.toFixed(4)),
        rougeLByTask: meanBy(rougeRows, (r) => r.taskType, (r) => r.grade.rougeL),
        errors: apRows.filter((r) => r.error).length,
      },
    }
    return { rows, metrics, groups: { knByTask, apByTask } }
  },
}

function accuracyOf(rows) {
  const ok = rows.filter((r) => !r.error)
  if (!ok.length) return null
  const k = ok.filter((r) => r.correct).length
  return { ...K.wilson(k, ok.length), accuracyPct: K.pct(k / ok.length) }
}
function pctOf(k, n) { return n ? K.pct(k / n) : null }
function countBy(rows, f) {
  const o = {}
  for (const r of rows) { const k = f(r) || 'n/a'; o[k] = (o[k] || 0) + 1 }
  return o
}
function meanBy(rows, keyF, valF) {
  const acc = {}
  for (const r of rows) {
    const k = keyF(r)
    if (!acc[k]) acc[k] = { n: 0, sum: 0 }
    acc[k].n++
    acc[k].sum += valF(r) || 0
  }
  const out = {}
  for (const [k, v] of Object.entries(acc)) out[k] = { n: v.n, mean: Number((v.sum / v.n).toFixed(4)) }
  return out
}
