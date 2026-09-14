/**
 * 口径 B：经**平台链路**作答，而不是直接问模型。
 *
 * 为什么要有这一项：口径 A（直连模型）测的是"底座"，回答不了"你们平台自己那套链路行不行"。
 * 这里把同一批题（同一种子、同一批题号）送进平台真实的对话链路
 * （平台系统提示词 + 25 个工具 + 附件读取），再与口径 A 在同一批题上对比。
 * 两者的差额就是"平台链路带来的增益或损失"，这是别人问得最多、也最容易被含糊过去的问题。
 *
 * 用法：
 *   node bench/external/platform-chain.js --cflue 60 --mm 20
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { resolveLlm, llmEnv } = require('../lib/llm')
const F = require('./lib/fetch')
const G = require('./lib/grade')
const S = require('./sources')
const { resolveBackendBin } = require('../lib/backends')

const REPO = path.resolve(__dirname, '..', '..')
const OUT = path.join(__dirname, 'out')
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }

function webDist() {
  const a = path.join(REPO, 'desktop', 'resources', 'web')
  const b = path.join(REPO, 'web', 'dist')
  return fs.existsSync(path.join(a, 'index.html')) ? a : b
}

/** 起后端：--port 0 让它自己选端口并打印 RWP_PORT */
async function startBackend({ dataDir }) {
  const bin = resolveBackendBin(REPO)
  if (!bin) throw new Error('找不到后端二进制（先 cargo build --release 或 npm run build:backend）')
  const llm = resolveLlm(REPO)
  if (!llm.ready) throw new Error(`未找到 API Key（尝试过 ${llm.tried.join(' / ')}）`)
  const child = spawn(bin.bin, ['--port', '0', '--data-dir', dataDir, '--web-dist', webDist()], {
    env: { ...process.env, ...llmEnv(llm) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const port = await new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error(`后端启动超时，输出：${buf.slice(-400)}`)), 60000)
    child.stdout.on('data', (d) => {
      buf += d.toString()
      const m = buf.match(/RWP_PORT=(\d+)/)
      if (m) { clearTimeout(timer); resolve(Number(m[1])) }
    })
    child.stderr.on('data', (d) => { buf += d.toString() })
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`后端退出（code=${code}）：${buf.slice(-400)}`)) })
  })
  return { child, port, llm }
}

/** 读 SSE：累积 token 文本，返回 {text, events, usage, toolCalls} */
async function chatStream(port, body, { timeoutMs = 180000 } = {}) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const events = []
  let text = ''
  let reasoning = ''
  let usage = null
  const toolCalls = []
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
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
        events.push(ev)
        if (ev === 'token' && data && data.text) text += data.text
        else if (ev === 'reasoning' && data && data.text) reasoning += data.text
        else if (ev === 'usage') usage = data
        else if (ev === 'tool' && data) toolCalls.push(data.name || data.tool || 'unknown')
        else if (ev === 'error') throw new Error(`平台返回错误：${(data && data.message) || '未知'}`)
      }
    }
    return { text: text.trim(), reasoning, usage, events, toolCalls }
  } finally {
    clearTimeout(timer)
  }
}

async function uploadImage(port, file, filename) {
  const b64 = fs.readFileSync(file).toString('base64')
  const res = await fetch(`http://127.0.0.1:${port}/api/attachments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, data_base64: b64, mime: 'image/jpeg' }),
  })
  const j = await res.json()
  const id = j.id || (j.attachment && j.attachment.id)
  if (!id) throw new Error(`附件上传失败：${JSON.stringify(j).slice(0, 200)}`)
  return id
}

;(async () => {
  const nCflue = Number(arg('--cflue', 60))
  const nMm = Number(arg('--mm', 20))
  const seed = Number(arg('--seed', 20260101))
  const presetArm = arg('--preset-arm', '') // 例如 B5：提示词修复 + 去工具 + 载入技能
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dataDir = path.join(OUT, `platform-chain-${stamp}`)
  fs.mkdirSync(dataDir, { recursive: true })

  console.log('=== 口径 B：经平台链路复测（同一种子、同一批题）===')
  const { child, port, llm } = await startBackend({ dataDir })
  console.log(`后端已启动：http://127.0.0.1:${port}（模型 ${llm.model}，Key 来源 ${llm.keySource}）`)
  const out = { generatedAt: new Date().toISOString(), mode: 'platform-chain', model: llm.model, port, seed, presetArm: presetArm || null, cflue: null, finevalMm: null }

  // ---------- 可选：装载消融预设（提示词修复 / 去工具 / 技能）----------
  let presetId = null
  if (presetArm) {
    const ARMS = require('./lib/chain-presets')
    const arm = ARMS.byId(presetArm)
    if (!arm) throw new Error(`未知预设组 ${presetArm}（可选 ${ARMS.LIST.map((a) => a.id).join(',')}）`)
    if (arm.skill) {
      const r = await fetch(`http://127.0.0.1:${port}/api/skills`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(arm.skill),
      })
      const j = await r.json()
      if (j.error) throw new Error(`建技能失败：${j.error}`)
      console.log(`技能已建：${arm.skill.name} → id=${j.skill_id ?? j.id}`)
    }
    const body = { name: `bench-${arm.id}`, description: arm.label, prompt_extra: arm.promptExtra, enabled: true }
    if (arm.tools) body.tools = arm.tools
    if (arm.skill) body.skills = [arm.skill.name]
    const r = await fetch(`http://127.0.0.1:${port}/api/plugins/presets`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const j = await r.json()
    if (j.error) throw new Error(`建预设失败：${j.error}`)
    presetId = j.preset_id ?? j.id ?? null
    if (!presetId) throw new Error(`建预设未返回 preset_id：${JSON.stringify(j).slice(0, 160)}`)
    out.presetId = presetId
    console.log(`预设已建：bench-${arm.id} → id=${presetId}（tools=${JSON.stringify(arm.tools)} skills=${arm.skill ? JSON.stringify([arm.skill.name]) : '[]'}）`)
  }
  const withPreset = (b) => (presetId ? { ...b, preset_id: presetId } : b)

  try {
    // ---------- CFLUE 知识题：与口径 A 完全相同的抽样方式 ----------
    if (nCflue > 0) {
      const cflue = require('./adapters/cflue')
      const plan = await cflue.plan({ seed, sizes: { knowledge: nCflue, application: 0 } })
      const kn = plan.tasks.filter((t) => t.kind === 'knowledge')
      console.log(`\nCFLUE 知识题 ${kn.length} 题（样本哈希 ${plan.sample.knowledge.hash.slice(0, 12)}）`)
      const rows = []
      for (const t of kn) {
        const opts = t.choices.map((c) => `${c.key}. ${c.text}`).join('\n')
        const msg = `请回答下面的单项选择题，并直接给出正确选项的字母（不要解释）：\n\n${t.question}\n${opts}`
        const t0 = Date.now()
        try {
          const r = await chatStream(port, withPreset({ message: msg }))
          const g = G.gradeMcq(r.text, t.gold)
          rows.push({ id: t.id, group: t.group, gold: t.gold, prediction: r.text.slice(0, 500), grade: g, correct: g.correct, ms: Date.now() - t0, toolCalls: r.toolCalls, events: r.events.length, error: null })
          process.stdout.write(`\r  CFLUE ${rows.length}/${kn.length}`)
        } catch (e) {
          rows.push({ id: t.id, group: t.group, gold: t.gold, prediction: '', grade: null, correct: null, ms: Date.now() - t0, error: String(e.message).slice(0, 300) })
        }
      }
      console.log('')
      const clean = rows.filter((r) => !r.error)
      const correct = clean.filter((r) => r.correct).length
      const how = {}
      for (const r of clean) how[r.grade.how] = (how[r.grade.how] || 0) + 1
      out.cflue = {
        n: clean.length,
        correct,
        accuracyPct: clean.length ? Number(((correct / clean.length) * 100).toFixed(2)) : null,
        sampleHash: plan.sample.knowledge.hash,
        extractMode: how,
        emptyAnswers: clean.filter((r) => !r.prediction).length,
        weakExtraction: clean.filter((r) => ['weak-scan', 'weak-single'].includes(r.grade.how)).length,
        usedTools: clean.filter((r) => r.toolCalls.length).length,
        meanMs: clean.length ? Math.round(clean.reduce((s, r) => s + r.ms, 0) / clean.length) : null,
        errors: rows.filter((r) => r.error).length,
        rows,
      }
      console.log(`  → 平台链路准确率 ${out.cflue.accuracyPct}%（n=${clean.length}，空回答 ${out.cflue.emptyAnswers}，宽松抽取 ${out.cflue.weakExtraction}），平均 ${out.cflue.meanMs} ms/题，用到工具的 ${out.cflue.usedTools} 题`)
    }

    // ---------- FinEval-MM：走平台的图片读取链路 ----------
    if (nMm > 0) {
      const mmAd = require('./adapters/fineval-mm')
      const plan = await mmAd.plan({ seed, sizes: { multimodal: nMm } })
      const tasks = plan.tasks
      console.log(`\nFinEval-MM ${tasks.length} 题（样本哈希 ${plan.sample.multimodal.hash.slice(0, 12)}）`)
      const rows = []
      for (const t of tasks) {
        const t0 = Date.now()
        try {
          const imgPath = F.rawPath(`fineval_fig/${path.basename(t.image)}`)
          const attId = await uploadImage(port, imgPath, path.basename(t.image))
          const opts = t.choices.map((c) => `${c.key}. ${c.text}`).join('\n')
          const msg = `${t.question}\n${opts}\n\n请阅读附件图片后作答，只输出选项字母。`
          const r = await chatStream(port, withPreset({ message: msg, attachment_ids: [attId] }), { timeoutMs: 240000 })
          const g = G.gradeMcq(r.text, t.gold)
          rows.push({ id: t.id, group: t.group, gold: t.gold, prediction: r.text.slice(0, 500), grade: g, correct: g.correct, ms: Date.now() - t0, toolCalls: r.toolCalls, attachmentId: attId, error: null })
          process.stdout.write(`\r  FinEval-MM ${rows.length}/${tasks.length}`)
        } catch (e) {
          rows.push({ id: t.id, group: t.group, gold: t.gold, prediction: '', grade: null, correct: null, ms: Date.now() - t0, error: String(e.message).slice(0, 300) })
        }
      }
      console.log('')
      const clean = rows.filter((r) => !r.error)
      const correct = clean.filter((r) => r.correct).length
      out.finevalMm = {
        n: clean.length,
        correct,
        accuracyPct: clean.length ? Number(((correct / clean.length) * 100).toFixed(2)) : null,
        sampleHash: plan.sample.multimodal.hash,
        usedTools: clean.filter((r) => r.toolCalls.length).length,
        meanMs: clean.length ? Math.round(clean.reduce((s, r) => s + r.ms, 0) / clean.length) : null,
        errors: rows.filter((r) => r.error).length,
        rows,
      }
      console.log(`  → 平台链路准确率 ${out.finevalMm.accuracyPct}%（n=${clean.length}），平均 ${out.finevalMm.meanMs} ms/题`)
    }
  } finally {
    child.kill()
    console.log('\n后端已停止')
  }

  const file = path.join(OUT, `platform-chain-${stamp}.json`)
  fs.writeFileSync(file, JSON.stringify(out, null, 2))
  console.log(`产物 → ${path.relative(REPO, file)}`)
  console.log(`PLATFORM-CHAIN: ${JSON.stringify({ model: out.model, cflue: out.cflue && { accuracyPct: out.cflue.accuracyPct, n: out.cflue.n, sampleHash: out.cflue.sampleHash }, finevalMm: out.finevalMm && { accuracyPct: out.finevalMm.accuracyPct, n: out.finevalMm.n, sampleHash: out.finevalMm.sampleHash } })}`)
})().catch((e) => { console.error(e); process.exit(1) })
