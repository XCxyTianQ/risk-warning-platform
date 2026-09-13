#!/usr/bin/env node
/**
 * bench/dataset/finish-round2.js —— 非财务数据补齐后的自动串联
 *
 * 等待顺序：非财务采集收尾 → replay（含时间平移的新闻/司法）→ T5 三目标 → 全量 bench（更新基线）
 * 日志：bench/report/round2-log.txt
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const REPO = path.resolve(__dirname, '..', '..')
const DATA = path.join(REPO, 'bench', 'dataset', 'out')
const LOG = path.join(REPO, 'bench', 'report', 'round2-log.txt')
fs.mkdirSync(path.dirname(LOG), { recursive: true })
const log = (m) => {
  const line = `[${new Date().toISOString()}] ${m}`
  console.log(line)
  fs.appendFileSync(LOG, line + '\n')
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'))
  } catch {
    return null
  }
}

async function waitNonfinancial(maxMinutes = 180) {
  const t0 = Date.now()
  let last = 0
  while ((Date.now() - t0) / 60000 < maxMinutes) {
    const mf = readJson('nonfinancial-manifest.json')
    if (mf && mf.generatedAt > new Date(t0 - 60000).toISOString()) {
      log(`非财务采集完成：新闻 ${mf.news} 条 / 司法 ${mf.legal} 条（请求 ${mf.requests}，失败 ${mf.errors}）`)
      return mf
    }
    const prog = readJson('nonfinancial-progress.json') || {}
    const done = Object.keys(prog).length
    if (done !== last) {
      last = done
      log(`等待非财务采集：已完成 ${done} 家`)
    }
    await sleep(60000)
  }
  log(`等待超时（${maxMinutes} 分钟），以现有数据推进`)
  return readJson('nonfinancial-manifest.json')
}

function run(label, args, timeoutMs = 40 * 60 * 1000) {
  log(`▶ ${label}`)
  const r = spawnSync('node', args, { cwd: REPO, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, PYTHONUTF8: '1' } })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  fs.appendFileSync(LOG, out + '\n')
  log(`◀ ${label}（exit=${r.status}）`)
  return out
}

;(async () => {
  fs.writeFileSync(LOG, '')
  log('第二阶段串联开始：等待非财务数据采集收尾…')
  await waitNonfinancial()

  const out = run('平台 replay（含新闻/司法，时间平移）', ['bench/dataset/replay.js'], 60 * 60 * 1000)
  const line = out.split('\n').filter((l) => l.includes('：企业')).slice(-3).join(' | ')
  log(`replay 摘要：${line || '(无)'}`)

  for (const target of ['risk_warning_next_year', 'penalty_next_year', 'any_high_event_next_year']) {
    const o = run(`T5 ${target}`, ['bench/dataset/t5.js', '--target', target])
    const m = o.match(/T5: (\{.*\})/)
    log(`  ${target} → ${m ? m[1] : '(未解析)'}`)
  }

  run('全量 bench（含 FinRisk-Bench 与 T5）', ['bench/run.js', '--with-llm', '--with-reference', '--with-mcp', '--update-baseline'], 60 * 60 * 1000)
  log('第二阶段串联完成')
})()
