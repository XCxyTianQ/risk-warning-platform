<script setup lang="ts">
import { onMounted, ref } from 'vue'

interface Health {
  status: string
  service: string
  version: string
}

const health = ref<Health | null>(null)
const error = ref('')

onMounted(async () => {
  try {
    const resp = await fetch('/api/health')
    health.value = await resp.json()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
})
</script>

<template>
  <main class="page">
    <h1>risk-warning-platform</h1>
    <p class="sub">基于多模态大模型的企业经营风险预警平台 — 工程骨架 v0.1</p>

    <section class="card">
      <h2>后端连通性检查</h2>
      <p v-if="health" class="ok">
        ✅ GET /api/health → {{ health.service }} v{{ health.version }} ({{ health.status }})
      </p>
      <p v-else-if="error" class="fail">
        ❌ 后端未连通：{{ error }}<br />
        <small>请确认 FastAPI 已在 8001 端口运行（server 目录：uvicorn app.main:app --reload --port 8001）</small>
      </p>
      <p v-else class="waiting">⏳ 正在检查后端…</p>
    </section>

    <footer>阶段1 · 工程初始化 · 前后端已连通即验收通过</footer>
  </main>
</template>

<style scoped>
.page {
  font-family: 'Microsoft YaHei', sans-serif;
  max-width: 720px;
  margin: 48px auto;
  padding: 0 16px;
}
h1 { margin-bottom: 4px; }
.sub { color: #666; margin-top: 0; }
.card {
  border: 1px solid #e5e5e5;
  border-radius: 8px;
  padding: 16px 20px;
  margin-top: 24px;
  background: #fafafa;
}
.ok { color: #1a7f37; }
.fail { color: #c0392b; }
.waiting { color: #888; }
footer { margin-top: 32px; color: #999; font-size: 13px; }
</style>
