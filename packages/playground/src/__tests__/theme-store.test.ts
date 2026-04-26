/**
 * Tests for the explicit theme boundary store -- verifies that `setTheme`
 * writes (or removes) the `data-theme` attribute on `<html>` and that the
 * default state is `system`.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useThemeStore } from '../stores/theme.js'

describe('useThemeStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    document.documentElement.removeAttribute('data-theme')
  })

  it('defaults to "system" with no data-theme attribute', () => {
    const store = useThemeStore()
    expect(store.theme).toBe('system')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('setTheme("dark") writes data-theme="dark" on <html>', () => {
    const store = useThemeStore()
    store.setTheme('dark')
    expect(store.theme).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('setTheme("light") writes data-theme="light" on <html>', () => {
    const store = useThemeStore()
    store.setTheme('light')
    expect(store.theme).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('setTheme("system") removes the data-theme attribute', () => {
    const store = useThemeStore()
    store.setTheme('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    store.setTheme('system')
    expect(store.theme).toBe('system')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('switching between explicit themes updates the attribute in place', () => {
    const store = useThemeStore()
    store.setTheme('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    store.setTheme('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('init() applies the current theme value to the DOM', () => {
    const store = useThemeStore()
    // simulate the default flow: store starts in system, init no-ops the attr
    store.init()
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)

    // change without applying, then call init to re-sync
    store.theme = 'dark'
    store.init()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })
})
