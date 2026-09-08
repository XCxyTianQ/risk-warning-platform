import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    // 开发期将 /api 代理到 FastAPI（8001；8000 被本机其他服务占用），前端代码直接 fetch('/api/...')
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8001',
        changeOrigin: true,
      },
    },
    watch: {
      // 编辑器/写盘工具产生临时文件，避免 EBUSY 导致 watcher 崩溃
      ignored: ['**/.App.vue.*.tmpdir/**', '**/*.tmp', '**/.git/**', '**/dist/**', '**/.venv/**'],
    },
  },
})
