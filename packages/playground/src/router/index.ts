/**
 * Vue Router configuration for the ForgeAgent Playground.
 */
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'playground',
    component: () => import('../views/PlaygroundView.vue'),
  },
  {
    path: '/agents',
    name: 'agents',
    component: () => import('../views/AgentsView.vue'),
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
