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
    path: '/agents',
    name: 'agents',
    component: () => import('../views/AgentsView.vue'),
  },
  {
    path: '/marketplace',
    name: 'marketplace',
    component: () => import('../views/MarketplaceView.vue'),
  },
  {
    path: '/runs/:id',
    name: 'run-detail',
    component: () => import('../views/RunDetailView.vue'),
  },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
})
