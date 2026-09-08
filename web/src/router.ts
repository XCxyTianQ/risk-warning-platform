import { createRouter, createWebHistory } from 'vue-router'

import DashboardView from './views/DashboardView.vue'
import ChatView from './views/ChatView.vue'
import AnalyzeView from './views/AnalyzeView.vue'
import EnterprisesView from './views/EnterprisesView.vue'
import EnterpriseDetailView from './views/EnterpriseDetailView.vue'
import AlertsView from './views/AlertsView.vue'

export const routes = [
  { path: '/', name: 'dashboard', component: DashboardView, meta: { title: '风险总览' } },
  { path: '/chat', name: 'chat', component: ChatView, meta: { title: '智能问答' } },
  { path: '/analyze', name: 'analyze', component: AnalyzeView, meta: { title: '智能研判' } },
  { path: '/enterprises', name: 'enterprises', component: EnterprisesView, meta: { title: '企业档案' } },
  {
    path: '/enterprises/:id',
    name: 'enterprise-detail',
    component: EnterpriseDetailView,
    meta: { title: '企业详情', hidden: true },
  },
  { path: '/alerts', name: 'alerts', component: AlertsView, meta: { title: '风险线索' } },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
})
