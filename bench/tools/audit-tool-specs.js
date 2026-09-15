/**
 * P1 守卫：校验「工具声明表 ↔ 实际注册的工具」是否一致。
 *
 * 为什么需要它：当初 `is_async_tool` 是手抄名单，新增三个行情工具时漏登记，
 * 结果模型看得见工具却调不动，运行时回 `unknown tool`，排查花了三轮。
 * 这个脚本把"漏登记"变成**一次可运行的检查**，而不是靠人记得。
 *
 *   node bench/tools/audit-tool-specs.js
 * 退出码 0 = 一致；1 = 有问题（可用于 CI）
 */
const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..', '..')
const toolsRs = fs.readFileSync(path.join(REPO, 'backend/src/agent/tools.rs'), 'utf8')
const specsRs = fs.readFileSync(path.join(REPO, 'backend/src/agent/tool_specs.rs'), 'utf8')

// 1) 实际注册的工具名：reg.register(\n "name",
const registered = [...toolsRs.matchAll(/reg\.register\(\s*\n\s*"([a-z_0-9]+)"/g)].map((m) => m[1])

// 2) 动态注册的前缀（custom_/mcp_）不参与
// 3) 声明表里的名字
const declared = [...specsRs.matchAll(/^\s*(?:sync_tool|async_tool)!\("([a-z_0-9]+)"/gm)].map((m) => m[1])

const missing = registered.filter((n) => !n.startsWith('custom_') && !n.startsWith('mcp_') && !declared.includes(n))
const extra = declared.filter((n) => !registered.includes(n))

console.log(`注册工具 ${registered.length} 个，声明表 ${declared.length} 条`)
console.log(`  同步: ${declared.filter((n) => specsRs.includes(`sync_tool!("${n}"`)).length}  异步: ${declared.filter((n) => specsRs.includes(`async_tool!("${n}"`)).length}`)
if (!missing.length && !extra.length) {
  console.log('✅ 一致：每个已注册工具都在声明表中，无多余声明')
  process.exit(0)
}
if (missing.length) console.log(`❌ 已注册但未登记（会导致分发错误）：${missing.join(', ')}`)
if (extra.length) console.log(`⚠️ 已声明但未注册（工具已删除？）：${extra.join(', ')}`)
process.exit(1)
