/**
 * 任务级测评：把一条**真实的用户任务**发给平台链路（口径 B），记录回答与工具调用轨迹。
 *
 * 与基准测试的区别：没有标准答案，考的是"能不能解决问题"——
 * 因此必须留下**过程证据**（调了哪些工具、拿到什么），才能判断回答里的数字是否可溯源。
 *
 *   node bench/external/chain-task.js --task-file bench/external/out/task-001.txt --tag platform
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { resolveLlm, llmEnv } = require('../lib/llm')
const { resolveBackendBin } = require('../lib/backends')

const REPO = path.resolve(__dirname, '..', '..')
const OUT = path.join(__dirname, 'out')
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }

function webDist() {
  const p = path.join(REPO, 'web', 'dist')
  return fs.existsSync(p) ? p : path.join(REPO, 'desktop', 'web-dist')
}

;(async () => {
  const taskFile = arg('--task-file', '')
  const tag = arg('--tag', 'platform')
  const timeoutMs = Number(arg('--timeout', '900000')) // 15 分钟：真实任务允许它充分调研
  if (!taskFile) throw new Error('需要 --task-file')
  const task = fs.readFileSync(path.resolve(REPO, taskFile), 'utf8').trim()

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dataDir = path.join(OUT, `task-${tag}-${stamp}`)
  fs.mkdirSync(dataDir, { recursive: true })

  const bin = resolveBackendBin(REPO)
  const llm = resolveLlm(REPO)
  const child = spawn(bin.bin, ['--port', '0', '--data-dir', dataDir, '--web-dist', webDist()], {
    env: { ...process.env, ...llmEnv(llm) }, cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const port = await new Promise((resolve, reject) => {
    let buf = ''
    const t = setTimeout(() => reject(new Error('后端启动超时')), 60000)
    const onData = (d) => { buf += d.toString(); const m = buf.match(/RWP_PORT=(\d+)/); if (m) { clearTimeout(t); resolve(Number(m[1])) } }
    child.stdout.on('data', onData); child.stderr.on('data', onData)
    child.on('exit', (c) => reject(new Error(`后端退出 code=${c}`)))
  })
  console.log(`后端 http://127.0.0.1:${port}（模型 ${llm.model}）；任务长度 ${task.length} 字`)

  const events = []
  const toolCalls = []
  let text = ''
  try {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    const res = await fetch(`http://127.0.0.1:${port}/api/chat/stream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: task }), signal: ac.signal,
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
        events.push({ ev, data })
        if (ev === 'token' && data && data.text) text += data.text
        else if (ev === 'tool' && data) { toolCalls.push(data); process.stdout.write(`\r  [工具] ${data.name || data.tool}                    `) }
        else if (ev === 'error') { console.error(`\n  平台错误：${(data && data.message) || '未知'}`) }
      }
    }
    clearTimeout(timer)
  } finally {
    child.kill()
  }
  console.log('')

  const out = {
    generatedAt: new Date().toISOString(), kind: 'task-level', agent: 'platform-chain',
    model: llm.model, taskFile, task, answer: text, toolCalls: toolCalls.map((t) => ({ name: t.name || t.tool, args: t.args || t.arguments || null })),
    toolCallCount: toolCalls.length, eventCount: events.length, dataDir: path.relative(REPO, dataDir),
  }
  const f = path.join(OUT, `task-${tag}-${stamp}.json`)
  fs.writeFileSync(f, JSON.stringify(out, null, 2))
  console.log(`回答 ${text.length} 字，工具调用 ${toolCalls.length} 次`)
  console.log(`产物 → ${path.relative(REPO, f)}`)
  fs.writeFileSync(path.join(OUT, `task-${tag}-latest.txt`), text)
  console.log(`回答正文 → bench/external/out/task-${tag}-latest.txt`)
})().catch((e) => { console.error(e); process.exit(1) })
