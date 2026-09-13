#!/usr/bin/env node
/**
 * bench/tools/scan-legacy-inserts.js —— 旧库升级风险扫描（维护工具）
 *
 * 背景：旧数据目录（Python/SQLAlchemy 建的库）里很多列是 `NOT NULL` 却没有 DEFAULT，
 * 而 Rust 侧的 INSERT 常常只写自己关心的列、其余靠默认值补齐 → 在旧库上直接约束失败。
 * 这个脚本把"旧库 schema × 全部 INSERT 语句"对一遍，列出**会炸的列**，防止这类问题再次发生。
 *
 * 用法：
 *   node bench/tools/scan-legacy-inserts.js --db "%APPDATA%\RiskWarningPlatform\data\platform.db"
 *   node bench/tools/scan-legacy-inserts.js --db <任意旧库> --repo .
 *
 * 期望输出：`（未发现）`；一旦列出表名，就说明该表的写入在旧库上会失败，
 * 需要在 `db::migrate()` 里补迁移（参见 docs/v1-工程重评估与量化指标方案.md 9.8）。
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const argv = process.argv.slice(2)
const argOf = (name, def = '') => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}
const REPO = path.resolve(argOf('--repo', path.join(__dirname, '..', '..')))
const DB = argOf('--db', path.join(process.env.APPDATA || '', 'RiskWarningPlatform', 'data', 'platform.db'))

if (!fs.existsSync(DB)) {
  console.error(`找不到数据库：${DB}\n用法：node bench/tools/scan-legacy-inserts.js --db <旧库路径>`)
  process.exit(2)
}

const pyScript = `
import sqlite3, json, sys
con = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
out = {}
for (name,) in con.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%'"):
    cols = []
    for c in con.execute(f"pragma table_info({name})"):
        cols.append({"name": c[1], "notnull": bool(c[3]), "default": c[4], "pk": bool(c[5])})
    out[name] = cols
print(json.dumps(out))
`
const py = spawnSync('python', ['-c', pyScript, DB], {
  encoding: 'utf8',
  env: { ...process.env, PYTHONUTF8: '1' },
})
if (py.status !== 0) {
  console.error('读取旧库失败：', py.stderr)
  process.exit(2)
}
const schema = JSON.parse(py.stdout)

const files = []
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (e.name.endsWith('.rs')) files.push(p)
  }
}
walk(path.join(REPO, 'backend', 'src'))

const inserts = []
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8')
  const re = /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)\s*\(([^)]*)\)/gis
  let m
  while ((m = re.exec(text))) {
    inserts.push({
      file: path.relative(REPO, f),
      table: m[1],
      cols: m[2]
        .split(',')
        .map((c) => c.trim().replace(/^"|"$/g, ''))
        .filter((c) => /^[a-z_][a-z0-9_]*$/i.test(c)),
    })
  }
}

const report = []
for (const ins of inserts) {
  const table = schema[ins.table]
  if (!table) continue
  const risky = table.filter((c) => c.notnull && c.default === null && !c.pk && !ins.cols.includes(c.name))
  if (risky.length) {
    report.push({ table: ins.table, file: ins.file, cols: ins.cols, missing: risky.map((c) => c.name) })
  }
}

console.log(`扫描库：${DB}`)
console.log(`INSERT 语句：${inserts.length} 条，涉及表：${[...new Set(inserts.map((i) => i.table))].length} 张`)
console.log('=== 旧库上会因 NOT NULL 无默认值而失败的 INSERT ===')
if (!report.length) {
  console.log('（未发现）')
  process.exit(0)
}
for (const r of report) {
  console.log(`- ${r.table}  (${r.file})`)
  console.log(`    INSERT 列: ${r.cols.join(', ')}`)
  console.log(`    缺失且 NOT NULL 无默认值: ${r.missing.join(', ')}`)
}
process.exit(1)
