/**
 * 把论文的**检索口径**公开结果也纳入对照（singleStore / sharedStore）。
 * 这是回答"我们的文档问答比 GPT-4 当年的向量库 RAG 强还是弱"的唯一依据。
 */
const fs = require('node:fs')
const path = require('node:path')
const F = require('../lib/fetch')
const S = require('../sources')

;(async () => {
  const files = [
    ['financebench/results_gpt4_singlestore.jsonl', 'results/gpt-4_singleStore.jsonl', 'GPT-4（single store 检索）'],
    ['financebench/results_gpt4_sharedstore.jsonl', 'results/gpt-4_sharedStore.jsonl', 'GPT-4（shared store 检索）'],
    ['financebench/results_gpt4_1106_singlestore.jsonl', 'results/gpt-4-1106-preview_singleStore.jsonl', 'GPT-4-1106（single store 检索）'],
    ['financebench/results_gpt4_1106_sharedstore.jsonl', 'results/gpt-4-1106-preview_sharedStore.jsonl', 'GPT-4-1106（shared store 检索）'],
    ['financebench/results_claude2_incontext.jsonl', 'results/claude-2_inContext.jsonl', 'Claude-2（in-context）'],
    ['financebench/results_gpt4_oracle.jsonl', 'results/gpt-4_oracle.jsonl', 'GPT-4（oracle）'],
    ['financebench/results_gpt4_1106_oracle.jsonl', 'results/gpt-4-1106-preview_oracle.jsonl', 'GPT-4-1106（oracle）'],
  ]
  for (const [key, repoPath, label] of files) {
    try {
      const meta = await S.repoFile('financebench', repoPath, key)
      const rows = F.parseJsonl(F.rawText(key)).rows
      const labels = {}
      for (const r of rows) labels[r.label] = (labels[r.label] || 0) + 1
      console.log(`✅ ${label.padEnd(26)} n=${rows.length} ${JSON.stringify(labels)}`)
    } catch (e) {
      console.log(`❌ ${label}: ${String(e.message).slice(0, 90)}`)
    }
  }
})()
