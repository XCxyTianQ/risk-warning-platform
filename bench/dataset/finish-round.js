#!/usr/bin/env node
/**
 * bench/dataset/finish-round.js —— 采集完成后的自动串联（避免人工盯着轮询）
 *
 * 流程：等按公司采集收尾 → 确认合并结果 → T5 三个目标 → FinRisk-Bench + 全量 bench（含基线更新）
 * 全部输出写到 bench/report/round-log.txt，随时可查。
 *
 * 用法：node bench/dataset/finish-round.js
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const REPO = path.resolve(__dirname, '..', '..')
const DATA = path.join(REPO, 'bench', 'dataset', 'out')
const LOG = path.join(REPO, 'bench', 'report', 'round-log.txt')
fs.mkdirSync(path.dirname(LOG), { recursive: true })

const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}`
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

async function waitHarvest(maxMinutes = 240) {
  const t0 = Date.now()
  let lastProgress = -1
  while ((Date.now() - t0) / 60000 < maxMinutes) {
    const manifest = readJson('by-stock-manifest.json')
    const progress = readJson('by-stock-progress.json') || {}
    const done = Object.keys(progress).length
    // 采集结束的标志：manifest 是本次生成的（total > 20129，即超过关键词阶段的总数）
    if (manifest && manifest.total > 20129 && manifest.generatedAt > new Date(t0 - 60000).toISOString()) {
      log(`采集结束：events 总计 ${manifest.total} 条（新增 ${manifest.added}），已完成公司 ${done}`)
      return manifest
    }
    if (done !== lastProgress) {
      lastProgress = done
      log(`等待采集：已完成 ${done} 家（events 目前 ${fs.existsSync(path.join(DATA, 'events.jsonl')) ? '未合并' : '?'}）`)
    }
    await sleep(60000)
  }
  log(`等待采集超时（${maxMinutes} 分钟），继续以现有数据推进`)
  return readJson('by-stock-manifest.json')
}

function run(label, args, timeoutMs = 30 * 60 * 1000) {
  log(`▶ ${label}：node ${args.join(' ')}`)
  const r = spawnSync('node', args, { cwd: REPO, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, PYTHONUTF8: '1' } })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  fs.appendFileSync(LOG, out + '\n')
  log(`◀ ${label} 结束（exit=${r.status}）`)
  return out
}

;(async () => {
  fs.writeFileSync(LOG, '')
  log('本轮串联开始：等待按公司采集收尾…')
  const manifest = await waitHarvest()

  // 事件标签总览
  const events = fs
    .readFileSync(path.join(DATA, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  const byType = {}
  for (const e of events) byType[e.type] = (byType[e.type] || 0) + 1
  log(`标签总量 ${events.length}；分类 ${JSON.stringify(byType)}；按公司采集文件 ${manifest?.added ?? '?'} 条新增`)

  // T5 三个目标
  for (const target of ['risk_warning_next_year', 'penalty_next_year', 'any_high_event_next_year']) {
    const out = run(`T5 ${target}`, ['bench/dataset/t5.js', '--target', target])
    const m = out.match(/T5: (\{.*\})/)
    log(`  ${target} → ${m ? m[1] : '(未解析到汇总行)'}`)
  }

  // 全量 bench（含 FinRisk-Bench、T5 套件、平台指标；本机有界面时含 GUI 冒烟）
  run('全量 bench（含 FinRisk-Bench 与 T5）', ['bench/run.js', '--with-llm', '--with-reference', '--with-mcp', '--update-baseline'], 60 * 60 * 1000)
  log('本轮串联完成')
})()
