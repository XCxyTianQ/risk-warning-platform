/**
 * 最小验证：不经完整任务，直接发一条指令看新工具是否真的取到数据。
 * 用法：node bench/external/tools/verify-market-tools.js "调用 get_board_constituents 取「贵金属」板块成分股前五"
 */
const path = require('node:path')
const { spawn } = require('node:child_process')
const { resolveLlm, llmEnv } = require('../../lib/llm')
const { resolveBackendBin } = require('../../lib/backends')

const REPO = path.resolve(__dirname, '..', '..', '..')
const msg = process.argv[2] || '调用 get_board_constituents 取「贵金属」板块成分股前五，只输出结果，不要解释。'

;(async () => {
  const llm = resolveLlm(REPO)
  const child = spawn(resolveBackendBin(REPO).bin, ['--port', '0', '--data-dir', path.join(__dirname, '..', 'out', 'tmp-check'), '--web-dist', path.join(REPO, 'desktop', 'resources', 'web')], {
    env: { ...process.env, ...llmEnv(llm) }, cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const port = await new Promise((resolve, reject) => {
    let buf = ''
    const t = setTimeout(() => reject(new Error('后端启动超时')), 60000)
    const on = (d) => { buf += d.toString(); const m = buf.match(/RWP_PORT=(\d+)/); if (m) { clearTimeout(t); resolve(Number(m[1])) } }
    child.stdout.on('data', on); child.stderr.on('data', on)
    child.on('exit', (c) => reject(new Error(`后端退出 ${c}`)))
  })
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/chat/stream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: msg }),
    })
    let text = '', b = ''
    const tools = []
    for await (const chunk of res.body) {
      b += Buffer.from(chunk).toString('utf8')
      const parts = b.split('\n\n'); b = parts.pop() || ''
      for (const p of parts) {
        const ev = (p.match(/^event:\s*(.+)$/m) || [])[1]
        const dl = (p.match(/^data:\s*(.+)$/m) || [])[1]
        if (!ev) continue
        let d = null
        try { d = dl ? JSON.parse(dl) : null } catch { d = null }
        if (ev === 'token' && d && d.text) text += d.text
        else if (ev === 'tool' && d) tools.push(d.name || d.tool)
        else if (ev === 'error') console.error('  平台错误:', d && d.message)
      }
    }
    console.log('工具调用:', tools.join(' → ') || '（无）')
    console.log('--- 回答 ---')
    console.log(text.slice(0, 900))
  } finally { child.kill() }
})().catch((e) => { console.error(e.message); process.exit(1) })
