/**
 * E2b · FinEval-MM（多模态子集）—— **图像类基准，单独一个适配器**
 *
 * 为什么单独拆出来：实测 `deepseek-v4-pro` 不接受图像输入（prompt_tokens=124 且明确拒绝），
 * 混在文本适配器里会让"不支持图像"被误读成"多模态能力差"。拆开后：
 *   - 图像类基准只跑实测支持图像的模型；
 *   - 报告里两个模型的分工是显式声明的，而不是含糊的"某模型没跑完"。
 *
 * 任务形态：财报/研报里的图表截图 + 四选一（如"根据利润表，2023 年的营业利润是多少？"），
 * 正好对应平台"上传图片 → 读表 → 取数"的链路。
 */
const path = require('node:path')
const F = require('../lib/fetch')
const G = require('../lib/grade')
const K = require('../lib/kit')
const S = require('../sources')
const { sampleStratified } = require('../lib/sample')
const { mapLimit } = require('../lib/model')

/**
 * 载入多模态题，并**按仓库真实文件树**判定图像是否可得。
 *
 * 事实（已实测，写进报告）：15 个 TSV 共引用 1,000 道带图题，但仓库只发布了其中一部分图像
 * （figure/hg、fs、frg、cc、lc、L3Q3_4），TSV 里大量引用的 figure/pg、figure/sdt 等目录
 * 在仓库里根本不存在，HF 镜像对该数据集返回 401（需授权）。
 * 因此本基准只在"图像确实可得"的子集上评测，并把覆盖率作为结论的一部分。
 */
async function loadMultimodal(log = () => {}) {
  await S.ensureFinevalMM({ log })
  const repoFiles = await S.repoPathSet('fineval')
  const items = []
  const missing = {}
  const funnel = { rows: 0, withImage: 0, withImageAndAnswer: 0, resolvableImage: 0, usable: 0 }
  for (const tsv of S.FINEVAL_MM) {
    const key = `fineval/mm_${tsv.split('/').pop()}`
    const t = F.parseTable(F.rawText(key), '\t')
    t.rows.forEach((r, i) => {
      funnel.rows++
      const img = String(r.image || '').trim()
      const answer = String(r.answer || '').trim().toUpperCase()
      if (!img) return
      funnel.withImage++
      if (!answer) return
      funnel.withImageAndAnswer++
      const repoPath = `multimodeldata/${img.replace(/^data\//, '')}`
      if (!repoFiles.has(repoPath)) {
        const sub = img.replace(/^data\/figure\//, '').split('/')[0]
        missing[sub] = (missing[sub] || 0) + 1
        return
      }
      funnel.resolvableImage++
      const choices = ['A', 'B', 'C', 'D'].map((k) => ({ key: k, text: String(r[k] || '').trim() })).filter((c) => c.text)
      if (choices.length < 2) return
      funnel.usable++
      items.push({
        id: `mm_${path.basename(tsv, '.tsv')}_${i}`,
        kind: 'multimodal',
        group: `FinEval-MM/${r.fintype || '未知'}`,
        fintype: r.fintype || '未知',
        type: r.type || '',
        image: repoPath,
        question: String(r.question || '').trim(),
        choices,
        gold: answer,
        background: String(r.background_story || '').trim(),
        information: String(r.information || '').trim(),
        round: String(r.round || '').trim(),
      })
    })
  }
  return { items, coverage: { funnel, missingBySubdir: missing, totalWithImage: funnel.withImageAndAnswer, available: items.length } }
}

module.exports = {
  id: 'fineval-mm',
  title: 'FinEval-MM（财报图表截图四选一）',
  layer: '多模态读取层：从财报/研报图表截图中取数',
  requiresVision: true,
  source: { repo: 'SUFE-AIFLM-Lab/FinEval', ref: 'main', paper: 'https://aclanthology.org/2025.naacl-long.318.pdf' },

  async plan({ seed = 20260101, sizes = {}, log = () => {} } = {}) {
    const { items: mm, coverage } = await loadMultimodal(log)
    const mSample = sampleStratified(mm, sizes.multimodal ?? 150, seed + 2, (x) => x.fintype, (x) => x.id, 5)
    const roundStats = {}
    for (const x of mm) roundStats[x.round || '1'] = (roundStats[x.round || '1'] || 0) + 1
    return {
      tasks: mSample.items,
      sample: {
        multimodal: { available: mm.length, picked: mSample.items.length, hash: mSample.hash, seed: seed + 2, perStratum: mSample.perStratum },
        coverage: { ...coverage, coveragePct: coverage.funnel.withImageAndAnswer ? Number(((coverage.funnel.usable / coverage.funnel.withImageAndAnswer) * 100).toFixed(1)) : null },
        roundDistribution: roundStats,
      },
      notes: [
        `数据可得性漏斗：TSV 总行 ${coverage.funnel.rows} → 带图 ${coverage.funnel.withImage} → 带图且有答案 ${coverage.funnel.withImageAndAnswer} → 图像在仓库中确实存在 ${coverage.funnel.resolvableImage} → 选项≥2 可用 ${coverage.funnel.usable}`,
        `拿不到图像的目录（按引用次数）：${Object.entries(coverage.missingBySubdir).sort((a, b) => b[1] - a[1]).map(([k, v]) => `figure/${k}×${v}`).join('、')}——仓库未发布、HF 镜像返回 401`,
        `本项只在可用子集（${coverage.funnel.usable} 题）上分层抽 ${mSample.items.length} 题；round 字段分布 ${JSON.stringify(roundStats)}`,
        '本轮按单轮提问（不构造多轮上下文）',
      ],
    }
  },

  async run({ tasks, client, concurrency = 4, log = () => {} }) {
    let done = 0
    const rows = await mapLimit(tasks, Math.min(concurrency, 4), async (t) => {
      const t0 = Date.now()
      try {
        const meta = await S.repoFile('fineval', t.image, `fineval_fig/${path.basename(t.image)}`)
        const imgPath = F.rawPath(`fineval_fig/${path.basename(t.image)}`)
        const opts = t.choices.map((c) => `${c.key}. ${c.text}`).join('\n')
        const ctx = [t.background, t.information].filter(Boolean).join('\n')
        const user = `${ctx ? ctx + '\n\n' : ''}${t.question}\n选项：\n${opts}\n\n请根据图片内容回答，只输出选项字母。`
        const r = await client.vision({
          system: '你是金融图表分析助手。仔细阅读图片中的表格或图形后作答，只输出选项字母，不要解释。',
          user,
          images: [imgPath],
          maxTokens: 3072,
          kind: 'fineval-mm',
        })
        const g = G.gradeMcq(r.text, t.gold)
        done++
        if (done % 20 === 0) log(`  FinEval-MM ${done}/${tasks.length}`)
        return { ...t, imageSha: meta.sha256.slice(0, 12), imageBytes: meta.bytes, prediction: r.text.trim(), grade: g, correct: r.truncated && !r.text ? null : g.correct, ms: Date.now() - t0, usage: r.usage, error: null }
      } catch (e) {
        return { ...t, prediction: '', grade: null, correct: null, ms: Date.now() - t0, error: String(e.message).slice(0, 300) }
      }
    })
    const clean = rows.filter((r) => !r.error)
    const byFintype = K.aggregate(clean, { groupKey: 'group' })
    const metrics = {
      multimodal: {
        metric: '四选一准确率',
        overall: byFintype.__ALL__,
        byFintype,
        abstainRate: rows.length ? K.pct(clean.filter((r) => r.grade && r.grade.abstained).length / rows.length) : null,
        meanImageKB: clean.length ? Number((clean.reduce((s, r) => s + (r.imageBytes || 0), 0) / clean.length / 1024).toFixed(1)) : null,
        errors: rows.filter((r) => r.error).length,
      },
    }
    return { rows, metrics, groups: byFintype }
  },
}
