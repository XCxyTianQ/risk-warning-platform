/**
 * 外部基准可达性探测：数据能不能真的下载下来（决定"对齐"可行性的唯一标准）
 */
const dns = require('node:dns')
try { dns.setDefaultResultOrder('ipv4first') } catch {}

const UA = { 'User-Agent': 'Mozilla/5.0 (rwp-bench external-benchmark probe)' }

const TARGETS = [
  ['CFLUE 仓库 README', 'https://raw.githubusercontent.com/aliyun/cflue/master/README.md'],
  ['CFLUE 数据目录（GitHub API）', 'https://api.github.com/repos/aliyun/cflue/contents/data'],
  ['FinEval README', 'https://raw.githubusercontent.com/SUFE-AIFLM-Lab/FinEval/main/README.md'],
  ['FinEval 数据目录（GitHub API）', 'https://api.github.com/repos/SUFE-AIFLM-Lab/FinEval/contents/data'],
  ['CFBenchmark README (HF)', 'https://huggingface.co/datasets/TongjiFinLab/CFBenchmark/resolve/main/README.md'],
  ['CFBenchmark 文件列表 (HF API)', 'https://huggingface.co/api/datasets/TongjiFinLab/CFBenchmark'],
  ['FinanceBench README', 'https://raw.githubusercontent.com/patronus-ai/financebench/main/README.md'],
  ['FinanceBench 数据文件', 'https://raw.githubusercontent.com/patronus-ai/financebench/main/data/financebench_open_source.jsonl'],
  ['BFCL (gorilla) README', 'https://raw.githubusercontent.com/ShishirPatil/gorilla/main/berkeley-function-call-leaderboard/README.md'],
  ['BFCL 数据目录 (GitHub API)', 'https://api.github.com/repos/ShishirPatil/gorilla/contents/berkeley-function-call-leaderboard/bfcl_eval/data'],
  ['OmniDocBench README', 'https://raw.githubusercontent.com/opendatalab/OmniDocBench/main/README_zh-CN.md'],
  ['FinBen (HF)', 'https://huggingface.co/api/datasets/TheFinAI/FinBen'],
]

async function probe([name, url]) {
  const t0 = Date.now()
  try {
    const res = await fetch(url, { headers: UA })
    const text = await res.text()
    const ms = Date.now() - t0
    let extra = ''
    const ct = res.headers.get('content-type') || ''
    if (ct.includes('json')) {
      try {
        const j = JSON.parse(text)
        if (Array.isArray(j)) extra = `${j.length} 个条目：` + j.slice(0, 4).map((x) => x.name).join(', ')
        else if (j.siblings) extra = `${j.siblings.length} 个文件：` + j.siblings.slice(0, 4).map((x) => x.rfilename).join(', ')
        else extra = Object.keys(j).slice(0, 5).join(', ')
      } catch {}
    } else {
      extra = text.replace(/\s+/g, ' ').slice(0, 90)
    }
    const ok = res.status === 200
    console.log(`${ok ? '✅' : '❌'} ${name.padEnd(30)} ${String(res.status).padStart(4)} ${String((text.length / 1024).toFixed(1) + 'KB').padStart(9)} ${String(ms + 'ms').padStart(7)}  ${extra}`)
    return { name, ok, status: res.status, bytes: text.length }
  } catch (e) {
    console.log(`❌ ${name.padEnd(30)}    -        -        -  ${String(e.message || e).slice(0, 70)}`)
    return { name, ok: false, status: 0 }
  }
}

;(async () => {
  const out = []
  for (const t of TARGETS) out.push(await probe(t))
  const okCount = out.filter((x) => x.ok).length
  console.log(`\n可达 ${okCount} / ${out.length}`)
})()
