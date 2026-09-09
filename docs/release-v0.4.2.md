# v0.4.2 · 修复复杂问题触发的 LLM HTTP 400

> 发布日期：2026-09-09　｜　适用：Windows 10/11、macOS 11+（Apple Silicon / Intel）
>
> 修补版本，功能范围与 v0.4.1 一致；修复"连续工具调用后，下一轮提问报模型调用失败（LLM HTTP 400）"。
> 已装 v0.4.0 / v0.4.1 的同事建议升级。

---

## 问题现象

在对话区提出需要**多轮工具调用**的复杂问题（如"刚刚拉取了 002842 和 002378 的相关信息，
发现其【毛利率】评分普遍较低，这是为什么"）时，模型返回：

```
模型调用失败：LLM HTTP 400:
{"error":{"message":"Messages with role 'tool' must be a response to a preceding message
with 'tool_calls'","type":"invalid_request_error",...}}
```

## 根因

会话上下文按"最近 12 条消息"截取，**没有保证工具调用与工具结果成对**：

```
user → assistant(tool_calls) → tool → assistant → user → assistant(tool_calls) → ...
        └────────── 一对 ──────────┘
                        ↑
             窗口从这里开始 → 首条是孤立的 tool 消息 → 提供方拒绝（400）
```

复杂问题会连续触发多轮工具（本次实测：4 步 8 次工具调用），消息很快超过 12 条，
窗口起点落到 `tool` 消息上就会 400。另有两种同源故障：

- 用户在工具执行中途中断会话 → 留下 `assistant(tool_calls)` 却没有对应 `tool` 结果
  （400：`insufficient tool messages following tool_calls message`）；
- 超长工具结果按字符截断，把 JSON 截成半截，模型读到无效 JSON。

以上三种均已用真实 API 复现并确认。

## 修复内容

1. **上下文成对性校验**（`agent/session.py`）：
   - 孤立的 `tool` 消息（其 `assistant(tool_calls)` 已被窗口裁掉）直接丢弃；
   - `assistant(tool_calls)` 缺失的 `tool` 结果自动补占位结果，保证序列合法；
2. **兜底重试**（`agent/loop.py`）：万一仍遇到工具序列类 400，自动改用"仅 user/纯文本
   assistant"的精简上下文重试一次，用户侧无感知；
3. **工具结果截断改为合法 JSON**：超长时返回 `{"truncated": true, "note": ..., "summary": ...}`，
   模型能据此改用更聚焦的查询（实测中模型自动改用横向对比工具完成了回答）。

历史会话无需处理：修复在构建上下文时生效，旧会话可直接继续提问。

## 验证

| 用例 | 修复前 | 修复后 |
|---|---|---|
| 孤立 `tool` 消息 | 400 | 200 |
| `assistant(tool_calls)` 缺结果 | 400 | 200（自动补占位） |
| 14 条消息窗口从 `tool` 开始 | 400 | 200（丢弃孤立项） |
| 用户原问题（002842 / 002378 毛利率） | 400 | 完成，4 步 8 次工具调用，正常输出结论 |

---

## 下载

| 平台 | 文件 |
|---|---|
| Windows 10/11 | `RiskWarningPlatform-0.4.2-x64.exe`（安装包）、`RiskWarningPlatform-0.4.2-portable.exe`（便携版） |
| macOS Apple Silicon | `RiskWarningPlatform-0.4.2-mac-arm64.dmg` / `.zip` |
| macOS Intel | `RiskWarningPlatform-0.4.2-mac-x64.dmg` / `.zip` |
| macOS 免签名回退 | `RiskWarningPlatform-0.4.2-macos-source.zip`（本机 Python 运行） |

校验文件：`SHA256SUMS-windows.txt` / `SHA256SUMS-macos-arm64.txt` / `SHA256SUMS-macos-x64.txt`

---

## macOS 首次打开

安装包未做 Apple 签名/公证，首次打开按任一方式处理：

1. 拖入「应用程序」→ **右键 App → 打开 → 弹窗中再点「打开」**；
2. 或终端执行 `xattr -dr com.apple.quarantine "/Applications/企业经营风险预警平台.app"`；
3. 或使用 `-macos-source.zip`（右键 `start.command` → 打开，需本机 Python 3.10+）。

---

## 首次使用

右上角 **⚙ 设置** → 选择提供商 → 填 API Key → 获取可用模型 → 回对话区提问，例如：

- `600518 现在风险怎么样？`
- `002842 和 002378 的毛利率为什么偏低？`
- `康美药业最新财报的盈利质量怎么样？`

数据目录：Windows `%APPDATA%\RiskWarningPlatform\data`；
macOS `~/Library/Application Support/RiskWarningPlatform/data`。

> 数据来自公开信源，模型结果为规则化测算，不构成投资建议。
