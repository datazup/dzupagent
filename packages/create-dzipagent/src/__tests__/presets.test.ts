import { describe, it, expect } from 'vitest'
import { presets, getPreset, listPresets, PRESET_NAMES } from '../presets.js'
import { templateRegistry } from '../templates/index.js'

describe('presets', () => {
  it('has 4 built-in presets', () => {
    expect(PRESET_NAMES).toHaveLength(4)
    expect(Object.keys(presets)).toHaveLength(4)
  })

  it('each preset references a valid template', () => {
    for (const preset of listPresets()) {
      expect(templateRegistry[preset.template]).toBeDefined()
    }
  })

  it('each preset has required fields', () => {
    for (const preset of listPresets()) {
      expect(preset.name).toBeTruthy()
      expect(preset.label).toBeTruthy()
      expect(preset.description).toBeTruthy()
      expect(preset.template).toBeTruthy()
      expect(Array.isArray(preset.features)).toBe(true)
      expect(['postgres', 'sqlite', 'none']).toContain(preset.database)
      expect(['api-key', 'jwt', 'none']).toContain(preset.auth)
    }
  })

  it('getPreset returns the correct preset', () => {
    const starter = getPreset('starter')
    expect(starter).toBeDefined()
    expect(starter?.name).toBe('starter')
    expect(starter?.template).toBe('full-stack')
    expect(starter?.features).toContain('auth')
  })

  it('getPreset returns undefined for unknown preset', () => {
    expect(getPreset('nonexistent')).toBeUndefined()
  })

  it('minimal preset has no features', () => {
    const minimal = getPreset('minimal')
    expect(minimal?.features).toHaveLength(0)
    expect(minimal?.database).toBe('none')
  })

  it('full preset has all major features', () => {
    const full = getPreset('full')
    expect(full?.features).toContain('auth')
    expect(full?.features).toContain('dashboard')
    expect(full?.features).toContain('billing')
    expect(full?.features).toContain('teams')
    expect(full?.features).toContain('ai')
  })

  it('api-only preset uses server template', () => {
    const apiOnly = getPreset('api-only')
    expect(apiOnly?.template).toBe('server')
  })

  it('listPresets returns all presets in order', () => {
    const list = listPresets()
    expect(list).toHaveLength(4)
    expect(list[0]?.name).toBe('minimal')
    expect(list[1]?.name).toBe('starter')
    expect(list[2]?.name).toBe('full')
    expect(list[3]?.name).toBe('api-only')
  })
})
