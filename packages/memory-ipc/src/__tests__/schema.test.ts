import { describe, it, expect } from 'vitest'
import {
  MEMORY_FRAME_SCHEMA,
  MEMORY_FRAME_VERSION,
  MEMORY_FRAME_COLUMNS,
  MEMORY_FRAME_FIELD_COUNT,
} from '../schema.js'

describe('MEMORY_FRAME_SCHEMA', () => {
  it('constructs a valid Arrow Schema', () => {
    expect(MEMORY_FRAME_SCHEMA).toBeDefined()
    expect(MEMORY_FRAME_SCHEMA.fields).toBeDefined()
  })

  it('has 21 columns', () => {
    expect(MEMORY_FRAME_FIELD_COUNT).toBe(22)
    expect(MEMORY_FRAME_SCHEMA.fields.length).toBe(22)
  })

  it('exports version 1', () => {
    expect(MEMORY_FRAME_VERSION).toBe(1)
  })

  it('stores version in schema metadata', () => {
    const meta = MEMORY_FRAME_SCHEMA.metadata
    expect(meta.get('memory_frame_version')).toBe('1')
  })

  it('exports column name list', () => {
    expect(MEMORY_FRAME_COLUMNS).toContain('id')
    expect(MEMORY_FRAME_COLUMNS).toContain('namespace')
    expect(MEMORY_FRAME_COLUMNS).toContain('text')
    expect(MEMORY_FRAME_COLUMNS).toContain('decay_strength')
    expect(MEMORY_FRAME_COLUMNS).toContain('is_active')
    expect(MEMORY_FRAME_COLUMNS.length).toBe(22)
  })

  it('has non-nullable identity columns', () => {
    const id = MEMORY_FRAME_SCHEMA.fields.find((f) => f.name === 'id')
    const ns = MEMORY_FRAME_SCHEMA.fields.find((f) => f.name === 'namespace')
    const key = MEMORY_FRAME_SCHEMA.fields.find((f) => f.name === 'key')
    expect(id?.nullable).toBe(false)
    expect(ns?.nullable).toBe(false)
    expect(key?.nullable).toBe(false)
  })

  it('has nullable scope columns', () => {
    for (const name of ['scope_tenant', 'scope_project', 'scope_agent', 'scope_session']) {
      const field = MEMORY_FRAME_SCHEMA.fields.find((f) => f.name === name)
      expect(field?.nullable).toBe(true)
    }
  })

  it('has nullable decay columns', () => {
    for (const name of ['decay_strength', 'decay_half_life_ms', 'decay_last_accessed_at', 'decay_access_count']) {
      const field = MEMORY_FRAME_SCHEMA.fields.find((f) => f.name === name)
      expect(field?.nullable).toBe(true)
    }
  })
})
