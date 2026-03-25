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
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
})
