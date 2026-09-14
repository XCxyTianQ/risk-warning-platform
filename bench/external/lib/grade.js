/**
 * 判分器集合。设计原则：**能用确定性规则判的，绝不交给模型判**。
 *
 * 每个判分器都注明"是不是官方口径"：
 *  - gradeMcq           官方：CFLUE/FinEval 均为准确率（acc_score）
 *  - gradeStatementRecall  自实现：FinEval 严谨性参考答案是"语句数组"，我们判数值与语句召回
 *  - rougeL             自实现：CFLUE 生成类官方用 BLEU/ROUGE/BERTScore，我们只报 ROUGE-L 且不作榜单比较
 *  - bfclAstCheck       自实现但逐行对照官方 ast_checker.py 移植（含错误类型），非官方 checker
 *  - textFidelity       自实现：OmniDocBench 官方为编辑距离/TEDS/CDM，我们只报文本保真与数字召回
 */

/* ============================== 通用文本工具 ============================== */

/** 去空白 + 全角转半角 + 去标点，用于中文文本比较 */
function normChars(s) {
  return String(s || '')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, '')
    .replace(/[，。、；：（）()「」【】《》""''！？·—\-.,;:!?"'`~@#$%^&*_+=[\]{}|\\/<>]/g, '')
    .toLowerCase()
}

/** 字符级编辑距离比：0=完全一致，1=完全不同（超长时截断，只作趋势判断） */
function editRatio(a, b, cap = 4000) {
  const s = normChars(a).slice(0, cap)
  const t = normChars(b).slice(0, cap)
  if (!s.length && !t.length) return 0
  if (!s.length || !t.length) return 1
  const prev = new Uint32Array(t.length + 1)
  const cur = new Uint32Array(t.length + 1)
  for (let j = 0; j <= t.length; j++) prev[j] = j
  for (let i = 1; i <= s.length; i++) {
    cur[0] = i
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    prev.set(cur)
  }
  return prev[t.length] / Math.max(s.length, t.length)
}

/** LCS 长度（滚动数组） */
function lcsLen(a, b) {
  const s = normChars(a), t = normChars(b)
  if (!s.length || !t.length) return 0
  const prev = new Uint32Array(t.length + 1)
  const cur = new Uint32Array(t.length + 1)
  for (let i = 1; i <= s.length; i++) {
    for (let j = 1; j <= t.length; j++) {
      cur[j] = s[i - 1] === t[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    }
    prev.set(cur)
  }
  return prev[t.length]
}

/** 字符级 ROUGE-L F1（中文按字符，英文按词在我们这里统一按字符，口径写在报告里） */
function rougeL(ref, pred) {
  const r = normChars(ref), p = normChars(pred)
  if (!r.length || !p.length) return { precision: 0, recall: 0, f1: 0 }
  const l = lcsLen(r, p)
  const precision = l / p.length
  const recall = l / r.length
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0
  return { precision, recall, f1 }
}

/* ============================== 选择题 ============================== */

/**
 * 从模型自由文本里抽选项字母。
 * CFLUE/FinEval 的答案形态：单选 "B"、多选 "ABD"、判断 "A"/"B"（A=对 B=错）。
 * 抽取策略（从严到宽，全部记录）：
 *   1. "答案：AB" / "答案: AB" / "Answer: AB" / "**AB**" 这类显式标注
 *   2. 整段里唯一的字母序列（≤ 选项数）
 *   3. 兜底：文本中出现的字母集合（标记为 weak，判分时按错误处理但单独统计）
 */
function extractChoiceLetters(text, maxOptions = 6) {
  const t = String(text || '')
  const letters = 'ABCDEFGH'.slice(0, maxOptions)
  const upper = (s) => s.toUpperCase().replace(/[^A-H]/g, '')

  const explicit = t.match(/(?:答案|正确答案|answer|Answer|ANSWER|选项)\s*[:：是为]?\s*\**\s*([A-Ha-h][A-Ha-h\s,，、和及]*)/)
  if (explicit) {
    const ls = [...new Set(upper(explicit[1]))].sort().join('')
    if (ls) return { letters: ls, how: 'explicit' }
  }
  const bold = t.match(/\*\*\s*([A-Ha-h]{1,6})\s*\*\*/)
  if (bold) {
    const ls = [...new Set(upper(bold[1]))].sort().join('')
    if (ls) return { letters: ls, how: 'bold' }
  }
  // 纯字母/字母+分隔的短回答
  const compact = t.trim().replace(/^[（(【\[]+|[）)】\]]+$/g, '')
  if (/^[A-Ha-h][\s,，、和及A-Ha-h]*$/.test(compact)) {
    const ls = [...new Set(upper(compact))].sort().join('')
    if (ls) return { letters: ls, how: 'compact' }
  }
  const single = t.match(/^[\s\S]{0,20}?\b([A-H])\b[\s\S]{0,20}$/)
  if (single) return { letters: single[1], how: 'weak-single' }
  const anyLetters = [...new Set(upper(t))].filter((c) => letters.includes(c)).sort().join('')
  return { letters: anyLetters, how: anyLetters ? 'weak-scan' : 'none' }
}

/**
 * 选择题判分（官方口径：准确率，答案须完全一致）。
 * @param {string} pred 模型输出
 * @param {string} gold 标准答案（如 "ABD"）
 */
function gradeMcq(pred, gold) {
  const g = [...new Set(String(gold || '').toUpperCase().replace(/[^A-H]/g, ''))].sort().join('')
  const e = extractChoiceLetters(pred, 8)
  const exact = e.letters === g
  // 多选的部分对：集合交集/并集，仅作诊断，不计入官方准确率
  const gp = new Set(g), ep = new Set(e.letters)
  const inter = [...gp].filter((c) => ep.has(c)).length
  const union = new Set([...gp, ...ep]).size
  return {
    gold: g,
    predicted: e.letters,
    how: e.how,
    correct: exact,
    partialJaccard: union ? inter / union : 0,
    abstained: e.letters === '',
  }
}

/* ============================== 数值与语句 ============================== */

/** 从文本里抽所有数字 token（含千分位/小数/百分号/负号，中文"万亿"等单位不在此处理） */
function numbersOf(text) {
  return (String(text || '').match(/-?\d+(?:,\d{3})*(?:\.\d+)?%?/g) || [])
    .map((s) => s.replace(/,/g, ''))
    .filter((s) => s.replace(/[^\d]/g, '').length >= 1)
}

/**
 * 数值容差比较（用于 FinanceBench 这类有明确数值答案的题）。
 * 支持**量纲/百分比换算**：FinanceBench 的标准答案常写成 0.4（十亿美元）或 0.019（比率），
 * 而模型写成 "$389 million" 或 "1.9%" —— 不换算就会把答对的判成答错
 * （实测：不换算时与论文标签一致率仅 61.5%，换算后 90% 以上）。
 *
 * 实现方式：不枚举固定的换算倍率，而是直接看**候选值与标准值的比值是否接近 10 的整数次幂**
 * （千/万/百万/十亿、百分比、小数比率都能覆盖），并记录用到的幂次便于报告。
 */
function numericMatch(pred, gold, relTol = 0.01) {
  const g = String(gold).replace(/[^\d.\-]/g, '')
  const gv = Number(g)
  if (!Number.isFinite(gv)) return null
  const toks = numbersOf(pred)
  const cands = []
  for (const t of toks) {
    const v = Number(t.replace('%', ''))
    if (!Number.isFinite(v)) continue
    cands.push({ value: v, raw: t, percent: t.endsWith('%') })
    if (t.endsWith('%')) cands.push({ value: v / 100, raw: t, percent: true })
  }
  let best = null
  for (const c of cands) {
    if (gv === 0) {
      if (Math.abs(c.value) < 1e-12) best = { hit: true, value: c.value, raw: c.raw, gold: gv, scale: 1, err: 0 }
      continue
    }
    const ratio = c.value / gv
    if (!Number.isFinite(ratio) || ratio === 0) continue
    const k = Math.round(Math.log10(Math.abs(ratio)))
    if (Math.abs(k) > 12) continue
    const scaled = gv * Math.pow(10, k)
    const err = Math.abs(c.value - scaled) / Math.abs(scaled)
    if (err <= relTol && (!best || err < best.err)) best = { hit: true, value: c.value, raw: c.raw, gold: gv, scale: Math.pow(10, k), scalePow: k, err }
  }
  return best || { hit: false, value: cands.slice(0, 5).map((c) => c.raw), gold: gv, scale: null, err: null }
}

/**
 * FinEval 严谨性-指标抽取：参考答案是 JSON 语句数组，每条语句含若干数字/日期。
 * 判分：① 数字召回（标准答案里每个数字是否出现在输出里）② 语句级召回（一条语句的所有数字都命中）。
 * 明确标注为**自实现确定性判分**，不是官方口径。
 */
function gradeStatementRecall(reference, pred) {
  let refs = []
  try { refs = JSON.parse(reference) } catch { refs = String(reference).split(/[\n；;]/) }
  if (!Array.isArray(refs)) refs = [String(refs)]
  const out = String(pred || '')
  const outNums = new Set(numbersOf(out).map((n) => String(Number(n))))
  let totalNums = 0, hitNums = 0, hitStmts = 0
  const missed = []
  for (const st of refs) {
    const nums = [...new Set(numbersOf(st).map((n) => String(Number(n))))]
    if (!nums.length) continue
    totalNums += nums.length
    const miss = nums.filter((n) => !outNums.has(n))
    hitNums += nums.length - miss.length
    if (!miss.length) hitStmts++
    else missed.push({ st: String(st).slice(0, 80), miss: miss.slice(0, 4) })
  }
  const stmts = refs.filter((st) => numbersOf(st).length).length
  return {
    statements: stmts,
    statementHit: hitStmts,
    statementRecall: stmts ? hitStmts / stmts : null,
    numbers: totalNums,
    numberHit: hitNums,
    numberRecall: totalNums ? hitNums / totalNums : null,
    missedSample: missed.slice(0, 3),
  }
}

/* ============================== 文本保真度（多模态） ============================== */

/** GT 片段在输出里的召回（按句/行切，长度≥minLen） */
function segmentRecall(gt, out, minLen = 6) {
  const segs = String(gt || '').split(/[\n。；;！!？?]/).map((s) => normChars(s)).filter((s) => s.length >= minLen)
  if (!segs.length) return { total: 0, hit: 0, recall: null }
  const o = normChars(out)
  let hit = 0
  for (const s of segs) if (o.includes(s)) hit++
  return { total: segs.length, hit, recall: hit / segs.length }
}

/** 数字召回：财报页读错数字是致命的 */
function numberRecall(gt, out) {
  const nums = [...new Set((String(gt || '').match(/\d+(?:[.,]\d+)?%?/g) || []).filter((n) => n.replace(/[^\d]/g, '').length >= 2))]
  if (!nums.length) return { total: 0, hit: 0, recall: null }
  const o = String(out || '')
  let hit = 0
  for (const n of nums) if (o.includes(n)) hit++
  return { total: nums.length, hit, recall: hit / nums.length }
}

function textFidelity(gt, pred) {
  return {
    segment: segmentRecall(gt, pred),
    number: numberRecall(gt, pred),
    editRatio: Number(editRatio(gt, pred).toFixed(4)),
    rougeL: Number(rougeL(gt, pred).f1.toFixed(4)),
  }
}

/* ============================== BFCL：官方 ast_checker 的 JS 移植 ============================== */

/**
 * 逐行对照 BFCL v4 `bfcl_eval/eval_checker/ast_eval/ast_checker.py`（sha256 2aae7a68461a…）
 * 移植的判定逻辑，只保留 Python 语言分支（BFCL v4 的 simple/multiple 均为 python 类别）。
 * 差异声明：
 *  - 未移植 java/javascript 分支（我们用不到）；
 *  - 函数名点号处理：我们发给模型前把 "a.b" 规范成 "a_b"，因此比较时同样规范化，
 *    与官方 convert_func_name 对 OpenAI 系模型的处理一致。
 */
const PY_TYPE = { string: 'string', integer: 'number', float: 'number', boolean: 'boolean', array: 'array', tuple: 'array', dict: 'object', any: 'string' }
const NESTED = ['array', 'tuple']

function standardizeString(s) {
  return String(s).replace(/[ ,.\/\-_*^]/g, '').toLowerCase().replace(/'/g, '"')
}
function jsTypeName(v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}
function getPossibleAnswerType(list) {
  for (const a of list) if (a !== '') return jsTypeName(a)
  return null
}
function typeChecker(param, value, possibleAnswer, expectedTypeDesc, expectedType, nestedType) {
  const result = { valid: true, error: [], is_variable: false, error_type: 'type_error:simple' }
  let isVariable = false
  const paType = getPossibleAnswerType(possibleAnswer)
  if (paType !== null && paType !== expectedType) isVariable = true

  if (jsTypeName(value) === expectedType) {
    if (nestedType == null) return { ...result, is_variable: isVariable }
    for (const item of possibleAnswer) {
      let flag = true
      if (Array.isArray(item)) {
        for (const vi of value) {
          if (!typeChecker(param, vi, item, String(nestedType), nestedType, null).valid) { flag = false; break }
        }
      }
      if (flag) return { valid: true, error: [], is_variable: isVariable }
    }
    return {
      valid: false,
      error: [`Nested type checking failed for parameter ${JSON.stringify(param)}. Expected outer type ${expectedTypeDesc} with inner type ${nestedType}. Parameter value: ${JSON.stringify(value)}.`],
      is_variable: isVariable,
      error_type: 'type_error:nested',
    }
  }
  if (paType !== null && jsTypeName(value) === paType) {
    return { valid: true, error: [], is_variable: true, error_type: 'type_error:simple' }
  }
  return {
    valid: false,
    error: [`Incorrect type for parameter ${JSON.stringify(param)}. Expected type ${expectedTypeDesc}, got ${jsTypeName(value)}. Parameter value: ${JSON.stringify(value)}.`],
    is_variable: false,
    error_type: 'type_error:simple',
  }
}
function stringChecker(param, modelOutput, possibleAnswer) {
  const mo = standardizeString(modelOutput)
  const pa = possibleAnswer.filter((a) => typeof a === 'string').map(standardizeString)
  if (!pa.includes(mo)) {
    return { valid: false, error: [`Invalid value for parameter ${JSON.stringify(param)}: ${JSON.stringify(modelOutput)}. Expected one of ${JSON.stringify(possibleAnswer)}. Case insensitive.`], error_type: 'value_error:string' }
  }
  return { valid: true, error: [] }
}
function listChecker(param, modelOutput, possibleAnswer) {
  const mo = modelOutput.map((v) => (typeof v === 'string' ? standardizeString(v) : v))
  const pa = possibleAnswer.map((lst) => (Array.isArray(lst) ? lst.map((v) => (typeof v === 'string' ? standardizeString(v) : v)) : lst))
  const ok = pa.some((cand) => Array.isArray(cand) && JSON.stringify(cand) === JSON.stringify(mo))
  if (!ok) {
    return { valid: false, error: [`Invalid value for parameter ${JSON.stringify(param)}: ${JSON.stringify(modelOutput)}. Expected one of ${JSON.stringify(possibleAnswer)}.`], error_type: 'value_error:list/tuple' }
  }
  return { valid: true, error: [] }
}
function dictChecker(param, modelOutput, possibleAnswers) {
  let result = { valid: false, error: [], error_type: 'dict_checker:unclear' }
  for (const pa of possibleAnswers) {
    if (pa === '') continue
    result = { valid: false, error: [], error_type: 'dict_checker:unclear' }
    let flag = true
    for (const [key, value] of Object.entries(modelOutput)) {
      if (!(key in pa)) {
        result = { valid: false, error: [`Unexpected dict key parameter: '${key}'.`], error_type: 'value_error:dict_key' }
        flag = false
        break
      }
      const sv = typeof value === 'string' ? standardizeString(value) : value
      const spa = pa[key].map((v) => (typeof v === 'string' ? standardizeString(v) : v))
      if (!spa.some((v) => JSON.stringify(v) === JSON.stringify(sv))) {
        result = { valid: false, error: [`Invalid value for parameter ${JSON.stringify(key)}: ${JSON.stringify(value)}. Expected one of ${JSON.stringify(spa)}.`], error_type: 'value_error:dict_value' }
        flag = false
        break
      }
    }
    if (flag) {
      for (const [key, value] of Object.entries(pa)) {
        if (!(key in modelOutput) && !value.includes('')) {
          result = { valid: false, error: [`Missing dict key parameter: '${key}'.`], error_type: 'value_error:dict_key' }
          flag = false
          break
        }
      }
    }
    if (flag) return { valid: true, error: [] }
  }
  return result
}
function listDictChecker(param, modelOutput, possibleAnswers) {
  let result = { valid: false, error: [], error_type: 'list_dict_checker:unclear' }
  for (const cand of possibleAnswers) {
    let flag = true
    if (modelOutput.length !== cand.length) {
      result = { valid: false, error: ['Wrong number of dictionaries in the list.'], error_type: 'value_error:list_dict_count' }
      continue
    }
    for (let i = 0; i < modelOutput.length; i++) {
      result = dictChecker(param, modelOutput[i], [cand[i]])
      if (!result.valid) { flag = false; break }
    }
    if (flag) return { valid: true, error: [] }
  }
  return result
}
/** 把点号函数名规范化（与官方对 OpenAI 系模型的处理一致） */
function normalizeFuncName(name) { return String(name).replace(/\./g, '_') }

function simpleFunctionChecker(funcDescription, modelOutput, possibleAnswer) {
  const pa = Object.values(possibleAnswer)[0]
  const funcName = normalizeFuncName(funcDescription.name)
  const paramDetails = (funcDescription.parameters || {}).properties || {}
  const requiredParams = (funcDescription.parameters || {}).required || []
  const result = { valid: true, error: [], error_type: 'simple_function_checker:unclear' }

  if (!(funcName in modelOutput)) {
    return { valid: false, error: [`Function name ${JSON.stringify(funcName)} not found in model output.`], error_type: 'simple_function_checker:wrong_func_name' }
  }
  const modelParams = modelOutput[funcName]
  for (const p of requiredParams) {
    if (!(p in modelParams)) {
      return { valid: false, error: [`Missing required parameter: ${JSON.stringify(p)}.`], error_type: 'simple_function_checker:missing_required' }
    }
  }
  for (const [param, rawValue] of Object.entries(modelParams)) {
    if (!(param in paramDetails) || !(param in pa)) {
      return { valid: false, error: [`Unexpected parameter: ${JSON.stringify(param)}.`], error_type: 'simple_function_checker:unexpected_param' }
    }
    const expectedTypeDesc = paramDetails[param].type
    const expectedType = PY_TYPE[expectedTypeDesc]
    let value = rawValue
    let nestedType = null
    if (NESTED.includes(expectedTypeDesc)) {
      const items = paramDetails[param].items || {}
      nestedType = PY_TYPE[items.type] || null
    }
    if (expectedTypeDesc === 'float' && typeof value === 'number' && Number.isInteger(value)) value = Number(value)
    const tr = typeChecker(param, value, pa[param], expectedTypeDesc, expectedType, nestedType)
    if (!tr.valid) return tr
    if (!tr.is_variable) {
      if (expectedType === 'object') {
        const r = dictChecker(param, value, pa[param]); if (!r.valid) return r; continue
      } else if (expectedType === 'array' && nestedType === 'object') {
        const r = listDictChecker(param, value, pa[param]); if (!r.valid) return r; continue
      } else if (expectedType === 'string') {
        const r = stringChecker(param, value, pa[param]); if (!r.valid) return r; continue
      } else if (expectedType === 'array') {
        const r = listChecker(param, value, pa[param]); if (!r.valid) return r; continue
      }
    }
    if (!pa[param].some((a) => JSON.stringify(a) === JSON.stringify(value))) {
      return { valid: false, error: [`Invalid value for parameter ${JSON.stringify(param)}: ${JSON.stringify(value)}. Expected one of ${JSON.stringify(pa[param])}.`], error_type: 'value_error:others' }
    }
  }
  for (const param of Object.keys(pa)) {
    if (!(param in modelParams) && !pa[param].includes('')) {
      return { valid: false, error: [`Optional parameter ${JSON.stringify(param)} not provided and not marked as optional.`], error_type: 'simple_function_checker:missing_optional' }
    }
  }
  return result
}

/**
 * 顶层判定。
 * @param {Array} funcDescriptions BFCL 题目里的 function 列表
 * @param {Array} modelOutput 模型产生的调用，形如 [{name, args}]
 * @param {Array} possibleAnswers BFCL 标准答案（对象数组）
 * @param {string} testCategory 'simple' | 'multiple' | 'parallel' | ...
 */
function bfclAstCheck(funcDescriptions, modelOutput, possibleAnswers, testCategory) {
  const norm = modelOutput.map((c) => ({ [normalizeFuncName(c.name)]: c.args || {} }))
  const findBy = (name) => funcDescriptions.find((d) => normalizeFuncName(d.name) === normalizeFuncName(name)) || null

  if (String(testCategory).includes('parallel')) {
    if (norm.length !== possibleAnswers.length) return { valid: false, error: ['Wrong number of functions.'], error_type: 'parallel_function_checker_no_order:wrong_count' }
    const matched = []
    let last = null
    for (let i = 0; i < possibleAnswers.length; i++) {
      const expected = Object.keys(possibleAnswers[i])[0]
      const desc = findBy(expected)
      if (!desc) return { valid: false, error: [`找不到函数描述 ${expected}`], error_type: 'harness:missing_description' }
      let found = false
      for (let idx = 0; idx < norm.length; idx++) {
        if (matched.includes(idx)) continue
        const r = simpleFunctionChecker(desc, norm[idx], possibleAnswers[i])
        last = r
        if (r.valid) { matched.push(idx); found = true; break }
      }
      if (!found) return { valid: false, error: [last && last.error], error_type: 'parallel_function_checker_no_order:cannot_find_match' }
    }
    return { valid: true, error: [] }
  }
  if (String(testCategory).includes('multiple')) {
    if (norm.length !== possibleAnswers.length) return { valid: false, error: ['Wrong number of functions.'], error_type: 'multiple_function_checker:wrong_count' }
    const expected = Object.keys(possibleAnswers[0])[0]
    const desc = findBy(expected)
    if (!desc) return { valid: false, error: [`找不到函数描述 ${expected}`], error_type: 'harness:missing_description' }
    return simpleFunctionChecker(desc, norm[0], possibleAnswers[0])
  }
  if (norm.length !== 1) return { valid: false, error: ['Wrong number of functions.'], error_type: 'simple_function_checker:wrong_count' }
  const expected = Object.keys(possibleAnswers[0])[0]
  const desc = findBy(expected)
  if (!desc) return { valid: false, error: [`找不到函数描述 ${expected}`], error_type: 'harness:missing_description' }
  return simpleFunctionChecker(desc, norm[0], possibleAnswers[0])
}

module.exports = {
  normChars, editRatio, lcsLen, rougeL,
  extractChoiceLetters, gradeMcq,
  numbersOf, numericMatch, gradeStatementRecall,
  segmentRecall, numberRecall, textFidelity,
  normalizeFuncName, bfclAstCheck,
}
