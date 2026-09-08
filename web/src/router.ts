import { createRouter, createWebHistory } from 'vue-router'

import ShareView from './views/ShareView.vue'
import WorkspaceView from './workspace/WorkspaceView.vue'

/** 单一工作台路由；旧路径重定向到工作台（面板由命令面板/工具条打开） */
export const routes = [
  { path: '/', name: 'workspace', component: WorkspaceView, meta: { title: '工作台' } },
  { path: '/share/:token', name: 'share', component: ShareView, meta: { title: '共享对话', standalone: true } },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
})
