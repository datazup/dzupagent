/**
 * Theme store -- explicit playground theme boundary.
 *
 * Manages the playground's effective color scheme. Three modes are supported:
 *   - `system` (default): no `data-theme` attribute is applied; the
 *     `@media (prefers-color-scheme: dark)` block in `main.css` decides.
 *   - `light`: forces the light token set by writing `data-theme="light"`
 *     onto `<html>`, overriding the OS preference.
 *   - `dark`: forces the dark token set by writing `data-theme="dark"`.
 *
 * The matching CSS selectors live in `assets/main.css`. Calling
 * `setTheme('system')` removes the attribute so the OS preference takes
 * over again.
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'

export type ThemeMode = 'light' | 'dark' | 'system'

export const useThemeStore = defineStore('theme', () => {
  const theme = ref<ThemeMode>('system')

  /** Apply the current theme value to the DOM. Safe to call in non-DOM
   *  environments -- it no-ops when `document` is undefined. */
  function applyTheme(value: ThemeMode): void {
    if (typeof document === 'undefined') return
    const root = document.documentElement
    if (value === 'system') {
      root.removeAttribute('data-theme')
    } else {
      root.setAttribute('data-theme', value)
    }
  }

  function setTheme(next: ThemeMode): void {
    theme.value = next
    applyTheme(next)
  }

  /** Initialise the DOM from the current store value. Called by `main.ts`. */
  function init(): void {
    applyTheme(theme.value)
  }

  return { theme, setTheme, init }
})
