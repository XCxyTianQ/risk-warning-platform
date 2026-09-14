/**
 * 确定性抽样：同一个种子 + 同一份数据 → 同一批题，且批次的 sha256 可写进报告。
 * 目的很直白：防止"这次抽到的题恰好简单"这类说不清的事，也让别人能复核同一批题。
 */
const crypto = require('node:crypto')

/** 固定种子 PRNG（mulberry32），不依赖任何库 */
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashOf(x) {
  const s = typeof x === 'string' ? x : JSON.stringify(x)
  return crypto.createHash('sha256').update(s).digest('hex')
}

/**
 * 从数组里确定性地抽 n 条（Fisher-Yates + 固定种子），返回 {items, ids, hash, seed, requested, available}
 * @param {Array} items
 * @param {number} n 抽多少（>=items.length 则全量）
 * @param {number} seed
 * @param {(item:any)=>string} idOf 取唯一 id
 */
function sample(items, n, seed, idOf = (x) => String(x.id)) {
  const arr = items.slice()
  const rnd = mulberry32(seed)
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  const picked = arr.slice(0, Math.min(n, arr.length))
  // 保持原始相对顺序，便于人读产物
  const order = new Map(items.map((x, i) => [idOf(x), i]))
  picked.sort((a, b) => (order.get(idOf(a)) ?? 0) - (order.get(idOf(b)) ?? 0))
  const ids = picked.map(idOf)
  return { items: picked, ids, hash: hashOf(ids.join('\n')), seed, requested: n, available: items.length }
}

/** 分层抽样：先按层分组，再在层内按比例分配名额（保证每层至少 minPerStratum 条，若层够大） */
function sampleStratified(items, n, seed, strataOf, idOf = (x) => String(x.id), minPerStratum = 3) {
  const groups = new Map()
  for (const it of items) {
    const k = strataOf(it)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(it)
  }
  const keys = [...groups.keys()].sort()
  const alloc = new Map()
  let remaining = Math.min(n, items.length)
  // 第一轮：按比例
  for (const k of keys) {
    const share = Math.max(minPerStratum, Math.round((groups.get(k).length / items.length) * n))
    const take = Math.min(share, groups.get(k).length, remaining)
    alloc.set(k, take)
    remaining -= take
  }
  // 第二轮：还有名额就补给还没抽满的层
  const rnd = mulberry32(seed)
  for (const k of keys) {
    if (remaining <= 0) break
    const cur = alloc.get(k)
    const cap = groups.get(k).length
    if (cur < cap) {
      const add = Math.min(cap - cur, remaining)
      alloc.set(k, cur + add)
      remaining -= add
    }
  }
  let s = seed
  const picked = []
  const perStratum = {}
  for (const k of keys) {
    const take = alloc.get(k)
    const sub = sample(groups.get(k), take, (s = (s * 1664525 + 1013904223) >>> 0), idOf)
    perStratum[k] = { available: groups.get(k).length, picked: sub.items.length, hash: sub.hash.slice(0, 12) }
    picked.push(...sub.items)
  }
  void rnd
  const order = new Map(items.map((x, i) => [idOf(x), i]))
  picked.sort((a, b) => (order.get(idOf(a)) ?? 0) - (order.get(idOf(b)) ?? 0))
  const ids = picked.map(idOf)
  return { items: picked, ids, hash: hashOf(ids.join('\n')), seed, requested: n, available: items.length, perStratum }
}

module.exports = { mulberry32, hashOf, sample, sampleStratified }
