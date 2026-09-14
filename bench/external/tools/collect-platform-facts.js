/**
 * 采集"平台简介"所需的客观事实：工具数、表数、维度名、数据源、代码规模。
 * 全部从源码里数出来，不手写，避免简介里的数字与代码脱节。
 */
const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..', '..', '..')

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (['target', 'node_modules', 'dist', '.git', 'out', 'cache'].includes(e.name)) continue
      walk(p, acc)
    } else acc.push(p)
  }
  return acc
}
const loc = (dir, ext) => walk(path.join(REPO, dir)).filter((f) => f.endsWith(ext)).reduce((s, f) => s + fs.readFileSync(f, 'utf8').split('\n').length, 0)

const toolsSrc = fs.readFileSync(path.join(REPO, 'backend/src/agent/tools.rs'), 'utf8')
// 工具注册形如 reg.register("name", "描述", json!({...}), read_only)
const regCalls = [...toolsSrc.matchAll(/reg\.register\(\s*"([a-z][a-z0-9_]*)"/g)].map((m) => m[1])
const toolNames = [...new Set(regCalls)]
const schema = fs.readFileSync(path.join(REPO, 'backend/src/db/schema.rs'), 'utf8')
const tables = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_]+)/g)].map((m) => m[1])
const dimsSrc = fs.readFileSync(path.join(REPO, 'backend/src/agent/tools.rs'), 'utf8')
// 六维名称写在工具描述里：财务健康/法律合规/舆情声誉/经营能力/信用状况/供应链稳定
const dimLabels = ['财务健康', '法律合规', '舆情声誉', '经营能力', '信用状况', '供应链稳定'].filter((d) => dimsSrc.includes(d))
const srcFiles = fs.readdirSync(path.join(REPO, 'backend/src/datasources')).filter((f) => f !== 'http.rs' && f !== 'mod.rs')

console.log('== 代码规模（行数，含空行与注释） ==')
console.log('Rust(backend/src):', loc('backend/src', '.rs'))
console.log('前端(web/src .vue/.ts):', loc('web/src', '.vue') + loc('web/src', '.ts'))
console.log('桌面端脚本(desktop/scripts):', loc('desktop/scripts', '.js'))
console.log('评测框架(bench):', loc('bench', '.js'))
console.log('== 工具 ==')
console.log('注册工具数:', toolNames.length)
console.log(toolNames.join(', '))
console.log('== 数据表 ==')
console.log(tables.length, '张:', tables.join(', '))
console.log('== 风险维度 ==')
console.log(dimLabels.join(' / '))
console.log('== 数据源 ==')
console.log(srcFiles.join(', '))
console.log('== 桌面端 ==')
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'desktop/package.json'), 'utf8'))
  console.log('版本', pkg.version, '| electron', (pkg.devDependencies || {}).electron)
} catch (e) {
  console.log('读不到 desktop/package.json')
}
