/**
 * DzupAgent Playground -- Vue 3 SPA entry point.
 *
 * Mounts the playground application with Pinia state management
 * and Vue Router for SPA navigation.
 */
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router/index.js'
import './assets/main.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
