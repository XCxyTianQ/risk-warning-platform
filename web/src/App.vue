<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'

const route = useRoute()
const apiOk = ref<boolean | null>(null)
const theme = ref<'light' | 'dark'>('light')

const NAV = [
  { to: '/', label: '风险总览', icon: '📊' },
  { to: '/analyze', label: '智能研判', icon: '🧠' },
  { to: '/enterprises', label: '企业档案', icon: '🏢' },
  { to: '/alerts', label: '风险线索', icon: '🚨' },
]

const pageTitle = computed(() => (route.meta.title as string) ?? '')

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
  } catch {
    apiOk.value = false
  }
})
</script>

<template>
  <div class="shell">
    <!-- 侧边栏 -->
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">险</div>
        <div class="brand-text">
          <div class="brand-name">风险预警平台</div>
          <div class="brand-sub">Multimodal LLM</div>
        </div>
      </div>

      <nav class="nav">
        <RouterLink v-for="item in NAV" :key="item.to" :to="item.to" class="nav-item">
          <span class="nav-icon">{{ item.icon }}</span>
          <span class="nav-label">{{ item.label }}</span>
        </RouterLink>
      </nav>

      <div class="sidebar-foot">
        <div class="foot-row">
          <span class="foot-label">大模型</span>
          <span class="foot-value">DeepSeek v4</span>
        </div>
        <div class="foot-row">
          <span class="foot-label">版本</span>
          <span class="foot-value">v0.3</span>
        </div>
      </div>
    </aside>

    <!-- 主区域 -->
    <div class="main">
      <header class="topbar">
        <div class="crumb">
          <span class="crumb-root">企业经营风险预警</span>
          <span class="crumb-sep">/</span>
          <span class="crumb-page">{{ pageTitle }}</span>
        </div>
        <div class="topbar-right">
          <span class="pill" :class="apiOk === false ? 'fail' : apiOk ? 'ok' : ''">
            <i class="dot"></i>
            API {{ apiOk === null ? '检测中' : apiOk ? '正常' : '未连接' }}
          </span>
          <button class="theme-btn" :title="theme === 'light' ? '切换深色' : '切换浅色'" @click="toggleTheme">
            {{ theme === 'light' ? '🌙' : '☀️' }}
          </button>
        </div>
      </header>

      <main class="content">
        <RouterView />
      </main>
    </div>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  min-height: 100vh;
}

/* ---------- 侧边栏 ---------- */
.sidebar {
  width: 210px;
  flex: none;
  background: var(--sidebar);
  color: var(--sidebar-text);
  display: flex;
  flex-direction: column;
  padding: 18px 12px;
  position: sticky;
  top: 0;
  height: 100vh;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 6px 18px;
}

.brand-mark {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: linear-gradient(135deg, var(--primary), var(--accent));
  color: #fff;
  font-weight: 700;
  font-size: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.brand-name {
  color: #fff;
  font-size: 14px;
  font-weight: 700;
}

.brand-sub {
  font-size: 10.5px;
  color: #7c8ba6;
  letter-spacing: 0.5px;
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-radius: 8px;
  color: var(--sidebar-text);
  font-size: 13.5px;
  transition: all 0.15s;
}

.nav-item:hover {
  background: rgba(255, 255, 255, 0.06);
  color: #fff;
}

.nav-item.router-link-exact-active {
  background: var(--sidebar-active);
  color: #fff;
  font-weight: 600;
}

.nav-icon {
  font-size: 15px;
}

.sidebar-foot {
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  padding-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.foot-row {
  display: flex;
  justify-content: space-between;
  font-size: 11.5px;
}

.foot-label {
  color: #7c8ba6;
}

.foot-value {
  color: #cbd5e1;
}

/* ---------- 主区 ---------- */
.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.topbar {
  height: 56px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  z-index: 5;
}

.crumb {
  font-size: 13px;
  color: var(--text-sub);
}

.crumb-page {
  color: var(--text);
  font-weight: 600;
}

.crumb-sep {
  margin: 0 8px;
  color: var(--border);
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
  font-size: 12px;
  color: var(--text-sub);
  background: var(--border-soft);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 4px 12px;
}

.pill .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #9ca3af;
}

.pill.ok .dot {
  background: var(--ok);
}

.pill.fail .dot {
  background: var(--danger);
}

.theme-btn {
  border: 1px solid var(--border);
  background: var(--bg-elev);
  border-radius: 8px;
  width: 34px;
  height: 30px;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
}

.theme-btn:hover {
  border-color: var(--primary);
}

.content {
  padding: 20px 24px 40px;
  flex: 1;
}

@media (max-width: 860px) {
  .sidebar {
    width: 64px;
    padding: 16px 8px;
  }
  .brand-text,
  .nav-label,
  .sidebar-foot {
    display: none;
  }
  .nav-item {
    justify-content: center;
  }
  .content {
    padding: 16px 14px 32px;
  }
}
</style>
