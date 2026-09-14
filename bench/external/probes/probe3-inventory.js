/**
 * 把各基准仓库的文件树抓下来缓存到磁盘，并打印"我们真正可能用到"的候选文件。
 * 缓存目的：GitHub 匿名 API 只有 60 次/小时，不能反复抓。
 */
const fs = require('node:fs')
const path = require('node:path')
const dns = require('node:dns')
try { dns.setDefaultResultOrder('ipv4first') } catch {}

const UA = { 'User-Agent': 'Mozilla/5.0 (rwp-bench external-benchmark probe)' }
const CACHE = path.join(__dirname, '..', 'cache', 'trees')
fs.mkdirSync(CACHE, { recursive: true })

const REPOS = [
  ['cflue', 'aliyun/cflue', 'master'],
  ['fineval', 'SUFE-AIFLM-Lab/FinEval', 'main'],
  ['financebench', 'patronus-ai/financebench', 'main'],
  ['omnidocbench', 'opendatalab/OmniDocBench', 'main'],
  ['gorilla', 'ShishirPatil/gorilla', 'main'],
]

async function tree(key, repo, br) {
  const file = path.join(CACHE, `${key}.json`)
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'))
  const res = await fetch(`https://api.github.com/repos/${repo}/git/trees/${br}?recursive=1`, { headers: UA })
  if (!res.ok) throw new Error(`${repo} -> ${res.status}`)
  const j = await res.json()
  fs.writeFileSync(file, JSON.stringify(j))
  return j
}

const fmt = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : (n / 1024).toFixed(0) + 'KB')

;(async () => {
  for (const [key, repo, br] of REPOS) {
    let j
    try { j = await tree(key, repo, br) } catch (e) { console.log(`\n### ${key}: ${e.message}`); continue }
    const all = j.tree.filter((x) => x.type === 'blob')
    console.log(`\n### ${key}  (${repo}@${br})  文件总数 ${all.length}`)
    // 只打印可能有用的：数据、样例、结果、图片目录
    const interesting = all.filter((x) =>
      /\.(json|jsonl|csv|tsv|xlsx?|zip|parquet|md|png|jpg|jpeg|pdf)$/i.test(x.path) &&
      !/\.(git|github)\//i.test(x.path) &&
      !/(^|\/)(docs?|assets?|images?|figures?|pics?)\/.*\.(png|jpg|jpeg)$/i.test(x.path) &&
      !/test|spec|__pycache__/i.test(x.path))
    for (const x of interesting.sort((a, b) => (b.size || 0) - (a.size || 0)).slice(0, 30)) {
      console.log(`   ${String(fmt(x.size || 0)).padStart(8)}  ${x.path}`)
    }
    // 目录聚合，便于看数据在哪
    const dirs = {}
    for (const x of all) {
      const d = x.path.split('/').slice(0, 2).join('/')
      dirs[d] = dirs[d] || { n: 0, bytes: 0 }
      dirs[d].n++; dirs[d].bytes += x.size || 0
    }
    const topDirs = Object.entries(dirs).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 8)
    console.log('   -- 目录体积 top8: ' + topDirs.map(([d, v]) => `${d}(${v.n}文件/${fmt(v.bytes)})`).join(', '))
  }
})()
