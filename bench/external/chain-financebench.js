/**
 * FinanceBench oracle 接入平台链路 + 条件化 A1 实验（**仅 deepseek-flash**）。
 *
 * 实验设计（关键）：
 *   消息里**只给"问题 + 材料"**，不写"材料必含答案、请推导"——那条规则由**平台预设层**提供，
 *   这样测的才是"平台级规则能否复现 A1 的效果"，而不是把 A1 又抄进用户消息里。
 *
 * 三组对照：
 *   B0  基线（平台现状，无预设）
 *   B6  条件化 A1（材料完整给出时放开推导；工具报数据不足时仍须如实说明）
 *   B7  无条件 A1（照搬 FinanceBench 版"材料一定包含答案，请推导而不是拒答"，作对照）
 *
 * 判分：用 **deepseek-flash 自判**（与官方口径 A 的裁判同模型；官方用的是 judge@3，这里默认 @1，差异会标注）。
 *
 *   node bench/external/chain-financebench.js --limit 150 --arms B0,B6,B7
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { resolveLlm, llmEnv } = require('../lib/llm')
const { resolveBackendBin } = require('../lib/backends')
const { ModelClient, mapLimit } = require('./lib/model')
const K = require('./lib/kit')
const F = require('./lib/fetch')
const P = require('./lib/chain-presets')

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
    child.stdout.on('data', onData); child.stderr.on('data', onData)
    child.on('exit', (c) => reject(new Error(`后端退出 code=${c}`)))
  })
  return { child, port, llm }
}

async function chatStream(port, body, { timeoutMs = 300000 } = {}) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  let text = ''
  const toolCalls = []
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/chat/stream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    let buf = ''
    for await (const chunk of res.body) {
      buf += Buffer.from(chunk).toString('utf8')
      const parts = buf.split('\n\n'); buf = parts.pop() || ''
      for (const part of parts) {
        const ev = (part.match(/^event:\s*(.+)$/m) || [])[1]
        const dl = (part.match(/^data:\s*(.+)$/m) || [])[1]
        if (!ev) continue
        let data = null
        try { data = dl ? JSON.parse(dl) : null } catch { data = null }
        if (ev === 'token' && data && data.text) text += data.text
        else if (ev === 'tool' && data) toolCalls.push(data.name || data.tool || 'unknown')
        else if (ev === 'error') throw new Error(`平台返回错误：${(data && data.message) || '未知'}`)
      }
    }
    return { text: text.trim(), toolCalls }
  } finally { clearTimeout(timer) }
}

;(async () => {
  const limit = Number(arg('--limit', 150))
  const votes = Number(arg('--judge-votes', 1))
  const want = (arg('--arms', 'B0,B6,B7')).split(',').map((s) => s.trim())
  const arms = want.map((id) => P.byId(id)).filter(Boolean)
  if (!arms.length) throw new Error('没有有效预设组')

  const questions = F.parseJsonl(F.rawText('financebench/open_source.jsonl')).rows.slice(0, limit).map((r) => ({
    id: r.financebench_id, type: r.question_type, question: r.question, gold: String(r.answer),
    evidence: (r.evidence || []).map((e) => e.evidence_text || '').join('\n\n'),
  }))
  console.log(`=== FinanceBench oracle 接入平台链路（仅 deepseek-flash）· ${questions.length} 题 ===`)

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dataDir = path.join(OUT, `chain-fb-${stamp}`)
  fs.mkdirSync(dataDir, { recursive: true })
  const { child, port, llm } = await startBackend({ dataDir })
  console.log(`后端 http://127.0.0.1:${port}（模型 ${llm.model}）`)
  const out = { generatedAt: new Date().toISOString(), mode: 'chain-financebench', model: llm.model, limit, judgeVotes: votes, arms: [] }

  try {
    // 建技能与预设（B0 不需要；BP = 内置预设，按名字在库里查找，不创建）
    for (const a of arms) {
      if (a.id === 'B0') continue
      if (a.builtinName) {
        const r = await fetch(`http://127.0.0.1:${port}/api/plugins/presets`)
        const j = await r.json()
        const items = j.items || j.presets || []
        const hit = items.find((x) => x.name === a.builtinName)
        if (!hit) throw new Error(`找不到内置预设「${a.builtinName}」，现有：${items.map((x) => x.name).join('、')}`)
        a.presetId = hit.id
        console.log(`使用内置预设「${hit.name}」→ id=${a.presetId}（skills=${JSON.stringify(hit.skills || [])}）`)
        continue
      }
      if (a.skill) {
        const r = await fetch(`http://127.0.0.1:${port}/api/skills`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(a.skill),
        })
        const j = await r.json()
        if (j.error) throw new Error(`建技能失败：${j.error}`)
      }
      const body = { name: `bench-${a.id}`, description: a.label, prompt_extra: a.promptExtra, enabled: true }
      if (a.tools) body.tools = a.tools
      if (a.skill) body.skills = [a.skill.name]
      const r = await fetch(`http://127.0.0.1:${port}/api/plugins/presets`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const j = await r.json()
      if (j.error) throw new Error(`建预设失败：${j.error}`)
      a.presetId = j.preset_id ?? null
      if (!a.presetId) throw new Error(`未返回 preset_id：${JSON.stringify(j).slice(0, 150)}`)
      console.log(`预设已建：bench-${a.id} → id=${a.presetId}`)
    }

    const judge = new ModelClient({ model: 'deepseek-flash' })
    const judgeOnce = async (r) => {
      const res = await judge.chat({
        system: 'You are a strict grader. Output exactly one word.',
        user: K.judgePrompt({ question: r.question, gold: r.gold, pred: r.prediction }),
        maxTokens: 2048, kind: 'chain-fb-judge',
      })
      return K.parseJudgeVerdict(res.text)
    }

    for (const a of arms) {
      console.log(`\n--- ${a.id} ${a.label} ---`)
      const rows = []
      for (const q of questions) {
        const msg = `请回答下面的问题。材料如下（摘自该公司自己的文件）：\n\n[问题]\n${q.question}\n\n[材料]\n${q.evidence}`
        const t0 = Date.now()
        const body = { message: msg }
        if (a.presetId) body.preset_id = a.presetId
        try {
          const r = await chatStream(port, body)
          rows.push({ id: q.id, type: q.type, question: q.question, gold: q.gold, prediction: r.text.slice(0, 800), ms: Date.now() - t0, toolCalls: r.toolCalls })
        } catch (e) {
          rows.push({ id: q.id, type: q.type, question: q.question, gold: q.gold, prediction: '', error: String(e.message).slice(0, 200) })
        }
        process.stdout.write(`\r  ${a.id} ${rows.length}/${questions.length}`)
      }
      process.stdout.write('\n')
      // 判分（deepseek-flash 自判；多数投票可选）
      const clean = rows.filter((r) => !r.error)
      let done = 0
      await mapLimit(clean, 6, async (r) => {
        const vs = []
        for (let i = 0; i < Math.max(1, votes); i++) vs.push(await judgeOnce(r).catch(() => 'ERROR'))
        const tally = {}
        for (const v of vs) tally[v] = (tally[v] || 0) + 1
        r.judge = Object.entries(tally).sort((x, y) => y[1] - x[1] || (x[0] === 'INCORRECT' ? -1 : 1))[0][0]
        r.correct = r.judge === 'CORRECT'
        done++
        if (done % 25 === 0) process.stdout.write(`\r  ${a.id} 判分 ${done}/${clean.length}`)
      })
      process.stdout.write('\n')
      const correct = clean.filter((r) => r.correct).length
      const refused = clean.filter((r) => r.judge === 'REFUSAL').length
      const acc = Number(((correct / Math.max(1, clean.length)) * 100).toFixed(2))
      out.arms.push({ id: a.id, label: a.label, presetId: a.presetId || null, n: clean.length, correct, accuracyPct: acc, refusalPct: Number(((refused / clean.length) * 100).toFixed(2)), meanMs: Math.round(clean.reduce((s, r) => s + (r.ms || 0), 0) / Math.max(1, clean.length)), rows })
      console.log(`  → ${a.id}：${correct}/${clean.length} = ${acc}%｜拒答 ${refused}｜${out.arms[out.arms.length - 1].meanMs} ms/题`)
    }

    console.log('\n=== 对照表（同一批题；判分为 deepseek-flash 自判）===')
    console.log('组   说明                                  准确率    拒答')
    for (const a of out.arms) console.log(`${a.id}   ${a.label.padEnd(34)} ${String(a.accuracyPct).padStart(6)}%  ${String(a.refusalPct).padStart(5)}%`)
    console.log('\n参照：口径 A（直连模型 + harness A1 提示词，judge@3）88.67%；口径 A 确定性判分 34.67%')
    out.reference = { directA1Judge3Pct: 88.67, directDeterministicPct: 34.67 }
    const f = path.join(OUT, `chain-fb-${stamp}.json`)
    fs.writeFileSync(f, JSON.stringify(out, null, 2))
    console.log(`\n产物 → ${path.relative(REPO, f)}`)
  } finally {
    if (!has('--keep')) child.kill()
  }
})().catch((e) => { console.error(e); process.exit(1) })
