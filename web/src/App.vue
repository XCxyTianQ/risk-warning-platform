<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterView } from 'vue-router'

import StatusBar from './workspace/StatusBar.vue'
import SettingsDialog from './workspace/SettingsDialog.vue'
import { usageState } from './workspace/usage'

const apiOk = ref<boolean | null>(null)
const theme = ref<'light' | 'dark'>('light')
const settingsOpen = ref(false)

function applyTheme() {
  document.documentElement.dataset.theme = theme.value
  localStorage.setItem('rw-theme', theme.value)
}

function toggleTheme() {
  theme.value = theme.value === 'light' ? 'dark' : 'light'
  applyTheme()
}

onMounted(async () => {
  const saved = localStorage.getItem('rw-theme')
  if (saved === 'dark' || saved === 'light') theme.value = saved
  applyTheme()
  try {
    const resp = await fetch('/api/health')
    apiOk.value = resp.ok
    usageState.apiOk = resp.ok
  } catch {
    apiOk.value = false
    usageState.apiOk = false
  }
})
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark">险</div>
        <div>
          <div class="brand-name">企业经营风险预警平台</div>
          <div class="brand-sub">Agent Workspace · Multimodal LLM</div>
        </div>
      </div>

      <div class="topbar-right">
        <span class="pill" :class="apiOk === false ? 'fail' : apiOk ? 'ok' : ''">
          <i class="dot"></i>
          API {{ apiOk === null ? '检测中' : apiOk ? '正常' : '未连接' }}
        </span>
        <span class="pill"><i class="dot ok-dot"></i>{{ usageState.model || 'DeepSeek' }}</span>
        <button class="icon-btn" title="设置" @click="settingsOpen = true">⚙</button>
        <button class="theme-btn" :title="theme === 'light' ? '切换深色' : '切换浅色'" @click="toggleTheme">
          {{ theme === 'light' ? '🌙' : '☀️' }}
        </button>
      </div>
    </header>

    <main class="content">
      <RouterView />
    </main>

    <StatusBar />
    <SettingsDialog v-if="settingsOpen" @close="settingsOpen = false" @saved="settingsOpen = false" />
  </div>
</template>

<style scoped>
.shell {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.topbar {
  height: 56px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  z-index: 20;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.brand-mark {
  width: 34px;
  height: 34px;
  border-radius: 9px;
  background: linear-gradient(135deg, var(--primary), var(--accent));
  color: #fff;
  font-weight: 700;
  font-size: 17px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.brand-name {
  font-size: 14px;
  font-weight: 700;
}

.brand-sub {
  font-size: 10.5px;
  color: var(--text-sub);
  letter-spacing: 0.4px;
}

.topbar-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--text-sub);
  background: var(--border-soft);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 4px 11px;
}

.pill .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #9ca3af;
}

.pill.ok .dot,
.pill .ok-dot {
  background: var(--ok);
}

.pill.fail .dot {
  background: var(--danger);
}

.theme-btn,
.icon-btn {
  border: 1px solid var(--border);
  background: var(--bg-elev);
  border-radius: 8px;
  width: 34px;
  height: 30px;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
}

.theme-btn:hover,
.icon-btn:hover {
  border-color: var(--primary);
  color: var(--primary);
}

.content {
  flex: 1;
  min-height: 0;
  padding: 16px 20px 48px;
  max-width: 1720px;
  width: 100%;
  margin: 0 auto;
}

@media (max-width: 700px) {
  .brand-sub,
  .topbar-right .pill {
    display: none;
  }
  .content {
    padding: 12px 12px 24px;
  }
}
</style>
