import { describe, it, expect } from 'vitest'
import { LocaleManager, EN_STRINGS } from '../i18n/locale-manager.js'

describe('LocaleManager', () => {
  it('returns English strings by default', () => {
    const mgr = new LocaleManager()
    expect(mgr.t('error.unknown')).toBe('An unknown error occurred')
  })

  it('returns the key itself when not found', () => {
    const mgr = new LocaleManager()
    expect(mgr.t('nonexistent.key')).toBe('nonexistent.key')
  })

  it('registers and resolves a new locale', () => {
    const mgr = new LocaleManager()
    mgr.register('es', { 'error.unknown': 'Ocurrio un error desconocido' })
    expect(mgr.t('error.unknown', 'es')).toBe('Ocurrio un error desconocido')
  })

  it('falls back to fallback locale when key is missing in target locale', () => {
    const mgr = new LocaleManager()
    mgr.register('fr', { 'error.unknown': 'Erreur inconnue' })
    // 'error.timeout' not registered in French, should fall back to English
    expect(mgr.t('error.timeout', 'fr')).toBe('The operation timed out')
  })

  it('supports interpolation params', () => {
    const mgr = new LocaleManager()
    const result = mgr.t('budget.warning', 'en', { percent: '85' })
    expect(result).toBe('Budget usage has reached 85%')
  })

  it('preserves unmatched placeholders', () => {
    const mgr = new LocaleManager()
    const result = mgr.t('budget.remaining', 'en', { amount: '50' })
    expect(result).toBe('50 remaining of {total} budget')
  })

  it('sets and gets default locale', () => {
    const mgr = new LocaleManager()
    expect(mgr.defaultLocale).toBe('en')
    mgr.setLocale('de')
    expect(mgr.defaultLocale).toBe('de')
  })

  it('lists available locales', () => {
    const mgr = new LocaleManager()
    expect(mgr.listLocales()).toEqual(['en'])
    mgr.register('ja', { 'status.running': 'running_ja' })
    expect(mgr.listLocales()).toContain('ja')
  })

  it('merges strings when registering same locale twice', () => {
    const mgr = new LocaleManager()
    mgr.register('en', { 'custom.key': 'Custom value' })
    expect(mgr.t('custom.key')).toBe('Custom value')
    // Original strings still present
    expect(mgr.t('error.unknown')).toBe('An unknown error occurred')
  })

  it('uses custom default and fallback locales', () => {
    const mgr = new LocaleManager({ defaultLocale: 'es', fallbackLocale: 'en' })
    mgr.register('es', { 'status.running': 'Ejecutando' })
    expect(mgr.t('status.running')).toBe('Ejecutando')
    expect(mgr.t('error.unknown')).toBe('An unknown error occurred') // fallback
  })
})

describe('EN_STRINGS', () => {
  it('contains expected keys', () => {
    expect(EN_STRINGS['error.unknown']).toBeDefined()
    expect(EN_STRINGS['budget.warning']).toBeDefined()
    expect(EN_STRINGS['status.running']).toBeDefined()
    expect(EN_STRINGS['memory.consolidating']).toBeDefined()
    expect(EN_STRINGS['plugin.loaded']).toBeDefined()
  })

  it('has at least 20 entries', () => {
    expect(Object.keys(EN_STRINGS).length).toBeGreaterThanOrEqual(20)
  })
})
