/**
 * Vue Router configuration for the DzupAgent Playground.
 */
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'playground',
    component: () => import('../views/PlaygroundView.vue'),
  },
  {
    path: '/agent-definitions',
    name: 'agent-definitions',
    component: () => import('../views/AgentDefinitionsView.vue'),
  },
  {
    path: '/agents',
    name: 'agents',
    redirect: '/agent-definitions',
  },
  {
    path: '/runs',
    name: 'runs',
    component: () => import('../views/RunHistoryBrowser.vue'),
  },
  {
    path: '/runs/:id',
    name: 'run-detail',
    component: () => import('../views/RunDetailView.vue'),
  },
  {
    path: '/eval-dashboard',
    name: 'eval-dashboard',
    component: () => import('../views/EvalDashboard.vue'),
  },
  {
    path: '/evals',
    name: 'evals',
    component: () => import('../views/EvalsView.vue'),
  },
  {
    path: '/evals/:id',
    name: 'eval-detail',
    component: () => import('../views/EvalRunDetailView.vue'),
  },
  {
    path: '/benchmarks',
    name: 'benchmarks',
    component: () => import('../views/BenchmarksView.vue'),
  },
  {
    path: '/benchmarks/:runId',
    name: 'benchmark-detail',
    component: () => import('../views/BenchmarkRunDetailView.vue'),
  },
  {
    path: '/marketplace',
    name: 'marketplace',
    component: () => import('../views/MarketplaceView.vue'),
  },
  {
    path: '/a2a',
    name: 'A2ATasks',
    component: () => import('../views/A2ATasksView.vue'),
  },
  {
    path: '/a2a/tasks/:id',
    name: 'A2ATaskDetail',
    component: () => import('../views/A2ATaskDetailView.vue'),
  },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
})
