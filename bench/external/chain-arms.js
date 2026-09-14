/**
 * 口径 B 的预设消融实验（**仅用 deepseek-flash**）。
 *
 * 目的：把"平台链路比直连模型低 20pp"这件事拆开——是工具压力、系统提示冲突，还是输出契约缺失。
 * 做法：在同一个后端实例、同一批 60 题（与基线完全同题）上，跑 6 组预设配置。
 *
 * 用法：
 *   node bench/external/chain-arms.js --cflue 60
 *   node bench/external/chain-arms.js --cflue 60 --arms B0,B1,B2,B3,B4,B5
 *
 * 注意（踩过的坑）：平台 `retain_whitelist` 对**空数组视为"不过滤"**，所以"去工具"必须传一个
 * 匹配不到任何工具的白名单（`__none__`）；`list_skills`/`load_skill` 是永远保留的。
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { resolveLlm, llmEnv } = require('../lib/llm')
const G = require('./lib/grade')
const { resolveBackendBin } = require('../lib/backends')

const REPO = path.resolve(__dirname, '..', '..')
const OUT = path.join(__dirname, 'out')
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }
const has = (n) => process.argv.includes(n)

function webDist() {
  const p = path.join(REPO, 'web', 'dist')
  return fs.existsSync(p) ? p : path.join(REPO, 'desktop', 'web-dist')
}

async function startBackend({ dataDir }) {
  const bin = resolveBackendBin(REPO)
  const llm = resolveLlm(REPO)
  const child = spawn(bin.bin, ['--port', '0', '--data-dir', dataDir, '--web-dist', webDist()], {
    // 注意：llmEnv 要传**解析后的 llm 对象**，不是 repo 路径。传错会得到空 env，
    // 后端就回落到本地默认端点（127.0.0.1:9000）并以"LLM 网络错误"失败。
    env: { ...process.env, ...llmEnv(llm) }, cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const port = await new Promise((resolve, reject) => {
    let buf = ''
    const t = setTimeout(() => reject(new Error('后端启动超时')), 60000)
    const onData = (d) => {
      buf += d.toString()
      const m = buf.match(/RWP_PORT=(\d+)/)
      if (m) { clearTimeout(t); resolve(Number(m[1])) }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (c) => reject(new Error(`后端退出，code=${c}`)))
  })
  return { child, port, llm }
}

async function chatStream(port, body, { timeoutMs = 180000 } = {}) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  let text = '', usage = null
  const toolCalls = []
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/chat/stream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    let buf = ''
    for await (const chunk of res.body) {
      buf += Buffer.from(chunk).toString('utf8')
      const parts = buf.split('\n\n')
      buf = parts.pop() || ''
      for (const part of parts) {
        const ev = (part.match(/^event:\s*(.+)$/m) || [])[1]
        const dataLine = (part.match(/^data:\s*(.+)$/m) || [])[1]
        if (!ev) continue
        let data = null
        try { data = dataLine ? JSON.parse(dataLine) : null } catch { data = null }
        if (ev === 'token' && data && data.text) text += data.text
        else if (ev === 'usage' && data) usage = data
        else if (ev === 'tool' && data) toolCalls.push(data.name || data.tool || 'unknown')
        else if (ev === 'error') throw new Error(`平台返回错误：${(data && data.message) || '未知'}`)
      }
    }
    return { text: text.trim(), usage, toolCalls }
  } finally { clearTimeout(timer) }
}

const SKILL_NAME = '客观题作答'
const SKILL_CONTENT = [
  '本技能用于金融类客观题（单选/多选/判断）。',
  '输出契约（必须严格遵守）：',
  '1. 只输出选项字母本身；单选输出一个字母，多选把字母连写（例如 ABDE），判断输出"对"或"错"。',
  '2. 禁止输出任何解释、分析、标点、Markdown 强调符号或前后缀文字。',
  '3. 不要调用任何平台工具：这类题目考查通用金融知识，平台企业数据工具无法作答。',
  '4. 若确实无法确定，输出你认为最可能的字母，不要留空。',
].join('\n')

const PROMPT_FIX = [
  '[作答模式]',
  '- 若问题属于通用金融知识、职业资格考试、概念辨析等**不依赖平台企业数据**的题目：',
  '  直接依据知识作答，**不要调用任何工具**，也不要因为"没有工具结果"而拒答或含糊；',
  '- 客观选择题只输出选项字母（多选连写，如 ABDE），不要输出解释或 Markdown 强调；',
  '- 只有当问题确实需要企业数据（某公司财务、风险、事件、评分）时才调用工具。',
].join('\n')

/** 消融组定义 */
const ARMS = [
  { id: 'B0', label: '基线（现状：平台默认）', preset: null },
  { id: 'B1', label: '去工具（白名单匹配不到任何工具）', preset: { prompt_extra: '', tools: ['__none__'], skills: [] } },
  { id: 'B2', label: '改提示（通用知识题直接作答）', preset: { prompt_extra: PROMPT_FIX, tools: null, skills: [] } },
  { id: 'B3', label: '改提示 + 去工具', preset: { prompt_extra: PROMPT_FIX, tools: ['__none__'], skills: [] } },
  { id: 'B4', label: '改提示 + 载入技能', preset: { prompt_extra: PROMPT_FIX, tools: null, skills: [SKILL_NAME] } },
  { id: 'B5', label: '改提示 + 去工具 + 载入技能', preset: { prompt_extra: PROMPT_FIX, tools: ['__none__'], skills: [SKILL_NAME] } },
]

;(async () => {
  const nCflue = Number(arg('--cflue', 60))
  const seed = Number(arg('--seed', 20260101))
  const want = (arg('--arms', '') || ARMS.map((a) => a.id).join(',')).split(',').map((s) => s.trim())
  const useArms = ARMS.filter((a) => want.includes(a.id))
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dataDir = path.join(OUT, `chain-arms-${stamp}`)
  fs.mkdirSync(dataDir, { recursive: true })

  console.log('=== 口径 B 预设消融（仅 deepseek-flash）===')
  const { child, port, llm } = await startBackend({ dataDir })
  console.log(`后端 http://127.0.0.1:${port}（模型 ${llm.model}）`)
  const out = { generatedAt: new Date().toISOString(), mode: 'chain-arms', model: llm.model, seed, nCflue, dataDir: path.relative(REPO, dataDir), arms: [] }

  try {
    // 1) 建技能
    let skillId = null
    if (useArms.some((a) => a.preset && a.preset.skills && a.preset.skills.length)) {
      const r = await fetch(`http://127.0.0.1:${port}/api/skills`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: SKILL_NAME, description: '金融客观题作答：严格输出契约，禁止调工具', content: SKILL_CONTENT }),
      })
      const j = await r.json()
      if (j.error) throw new Error(`建技能失败：${j.error}`)
      skillId = j.skill_id ?? j.id ?? null
      console.log(`技能已建：${SKILL_NAME} → id=${skillId}`)
    }

    // 2) 建预设
    for (const a of useArms) {
      if (!a.preset) continue
      const body = { name: `bench-${a.id}`, description: a.label, prompt_extra: a.preset.prompt_extra, enabled: true }
      if (a.preset.tools) body.tools = a.preset.tools
      if (a.preset.skills && a.preset.skills.length) body.skills = a.preset.skills
      const r = await fetch(`http://127.0.0.1:${port}/api/plugins/presets`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const j = await r.json()
      if (j.error) throw new Error(`建预设失败：${j.error}`)
      // 接口返回的是 preset_id（不是 id）——早期按 id 取会静默拿到 null，
      // 结果 B1–B5 全部没挂上预设、变成基线的重复运行（踩过一次，浪费一轮）
      a.presetId = j.preset_id ?? j.id ?? null
      if (!a.presetId) throw new Error(`建预设未返回 id：${JSON.stringify(j).slice(0, 200)}`)
      console.log(`预设已建：bench-${a.id} → id=${a.presetId}（tools=${JSON.stringify(a.preset.tools)} skills=${JSON.stringify(a.preset.skills)}）`)
    }

    // 3) 同一批题
    const cflue = require('./adapters/cflue')
    const plan = await cflue.plan({ seed, sizes: { knowledge: nCflue, application: 0 } })
    const kn = plan.tasks.filter((t) => t.kind === 'knowledge')
    console.log(`\nCFLUE 知识题 ${kn.length} 题（样本哈希 ${plan.sample.knowledge.hash.slice(0, 12)}）`)

    // 4) 逐组跑
    for (const a of useArms) {
      console.log(`\n--- ${a.id} ${a.label} ---`)
      const rows = []
      for (const t of kn) {
        const opts = t.choices.map((c) => `${c.key}. ${c.text}`).join('\n')
        const msg = `请回答下面的单项选择题，并直接给出正确选项的字母（不要解释）：\n\n${t.question}\n${opts}`
        const t0 = Date.now()
        const body = { message: msg }
        if (a.presetId) body.preset_id = a.presetId
        try {
          const r = await chatStream(port, body)
          const g = G.gradeMcq(r.text, t.gold)
          rows.push({ id: t.id, gold: t.gold, prediction: r.text.slice(0, 400), correct: g.correct, how: g.how, ms: Date.now() - t0, toolCalls: r.toolCalls })
        } catch (e) {
          rows.push({ id: t.id, gold: t.gold, prediction: '', correct: null, error: String(e.message).slice(0, 200) })
        }
        process.stdout.write(`\r  ${a.id} ${rows.length}/${kn.length}`)
      }
      process.stdout.write('\n')
      const clean = rows.filter((r) => r.correct !== null)
      const correct = clean.filter((r) => r.correct).length
      const usedTools = clean.filter((r) => r.toolCalls && r.toolCalls.length).length
      const empty = clean.filter((r) => !r.prediction).length
      const meanMs = Math.round(clean.reduce((s, r) => s + (r.ms || 0), 0) / Math.max(1, clean.length))
      const acc = Number(((correct / Math.max(1, clean.length)) * 100).toFixed(2))
      out.arms.push({ id: a.id, label: a.label, presetId: a.presetId || null, n: clean.length, correct, accuracyPct: acc, usedTools, emptyAnswers: empty, meanMs, rows })
      console.log(`  → ${a.id}：${correct}/${clean.length} = ${acc}%｜用过工具 ${usedTools}｜空回答 ${empty}｜${meanMs} ms/题`)
    }

    // 5) 对比表
    console.log('\n=== 消融对比（同一批题）===')
    const base = out.arms.find((a) => a.id === 'B0')
    console.log('组   说明                              准确率    相对基线   用工具  空回答  耗时')
    for (const a of out.arms) {
      const d = base && a.id !== 'B0' ? `${a.accuracyPct - base.accuracyPct >= 0 ? '+' : ''}${(a.accuracyPct - base.accuracyPct).toFixed(1)}pp` : '—'
      console.log(`${a.id}   ${a.label.padEnd(32)} ${String(a.accuracyPct).padStart(6)}%  ${d.padStart(8)}  ${String(a.usedTools).padStart(5)}  ${String(a.emptyAnswers).padStart(5)}  ${a.meanMs}ms`)
    }
    const best = [...out.arms].sort((x, y) => y.accuracyPct - x.accuracyPct)[0]
    out.best = { id: best.id, label: best.label, accuracyPct: best.accuracyPct, presetId: best.presetId }
    console.log(`\n最佳：${best.id} ${best.label} = ${best.accuracyPct}%（预设 id=${best.presetId || '无'}）`)
    out.directReference = 88.33
    console.log(`参照：口径 A（直连模型，同题）88.33%；基线口径 B = ${base ? base.accuracyPct : 68.33}%`)

    const f = path.join(OUT, `chain-arms-${stamp}.json`)
    fs.writeFileSync(f, JSON.stringify(out, null, 2))
    console.log(`\n产物 → ${path.relative(REPO, f)}`)
    if (has('--keep')) console.log(`后端保留在 ${port}（--keep）`)
  } finally {
    if (!has('--keep')) child.kill()
  }
})().catch((e) => { console.error(e); process.exit(1) })
