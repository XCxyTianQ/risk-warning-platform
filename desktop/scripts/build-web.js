/**
 * 构建前端并把产物复制到 desktop/resources/web
 * 用法：node scripts/build-web.js
 */
const { execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const repo = path.resolve(__dirname, '..', '..')
const webDir = path.join(repo, 'web')
const dist = path.join(webDir, 'dist')
const target = path.join(__dirname, '..', 'resources', 'web')

console.log('[build-web] building frontend…')
execSync('npm run build', { cwd: webDir, stdio: 'inherit' })

fs.rmSync(target, { recursive: true, force: true })
fs.mkdirSync(target, { recursive: true })
fs.cpSync(dist, target, { recursive: true })
console.log('[build-web] copied to', target)
