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
import { useThemeStore } from './stores/theme.js'
import './assets/main.css'

const app = createApp(App)
const pinia = createPinia()
app.use(pinia)
app.use(router)

// Initialise the explicit theme boundary before mount so the very first paint
// already reflects the user's chosen mode (or the system preference when the
// store is in its default `system` state).
const themeStore = useThemeStore(pinia)
themeStore.init()

app.mount('#app')
