import { describe, it, expect } from 'vitest'
import { tableFromArrays } from 'apache-arrow'
import {
  createEmptyColumns,
  buildTable,
  safeParseDate,
  getString,
  getBigInt,
  getFloat,
  pushDefaults,
} from '../../adapters/frame-columns.js'

// ---------------------------------------------------------------------------
// createEmptyColumns
// ---------------------------------------------------------------------------

describe('createEmptyColumns', () => {
  it('creates object with all 22 column arrays', () => {
    const cols = createEmptyColumns()
    const keys = Object.keys(cols)
    expect(keys).toHaveLength(22)
    expect(keys).toContain('id')
    expect(keys).toContain('namespace')
    expect(keys).toContain('key')
    expect(keys).toContain('scope_tenant')
    expect(keys).toContain('scope_project')
    expect(keys).toContain('scope_agent')
    expect(keys).toContain('scope_session')
    expect(keys).toContain('text')
    expect(keys).toContain('payload_json')
    expect(keys).toContain('system_created_at')
    expect(keys).toContain('system_expired_at')
    expect(keys).toContain('valid_from')
    expect(keys).toContain('valid_until')
    expect(keys).toContain('decay_strength')
    expect(keys).toContain('decay_half_life_ms')
    expect(keys).toContain('decay_last_accessed_at')
    expect(keys).toContain('decay_access_count')
    expect(keys).toContain('agent_id')
    expect(keys).toContain('category')
    expect(keys).toContain('importance')
    expect(keys).toContain('provenance_source')
    expect(keys).toContain('is_active')
  })

  it('all arrays start empty', () => {
    const cols = createEmptyColumns()
    for (const val of Object.values(cols)) {
      expect(val).toEqual([])
    }
  })
})

// ---------------------------------------------------------------------------
// buildTable
// ---------------------------------------------------------------------------

describe('buildTable', () => {
  it('builds an Arrow table from populated columns', () => {
    const cols = createEmptyColumns()
    cols.id.push('r1')
    cols.namespace.push('test')
    cols.key.push('k1')
    cols.scope_tenant.push('tenant')
    cols.scope_project.push(null)
    cols.scope_agent.push(null)
    cols.scope_session.push(null)
    cols.text.push('hello')
    cols.payload_json.push(null)
    cols.system_created_at.push(BigInt(1000))
    cols.system_expired_at.push(null)
    cols.valid_from.push(BigInt(1000))
    cols.valid_until.push(null)
    cols.decay_strength.push(null)
    cols.decay_half_life_ms.push(null)
    cols.decay_last_accessed_at.push(null)
    cols.decay_access_count.push(null)
    cols.agent_id.push(null)
    cols.category.push('decision')
    cols.importance.push(0.8)
    cols.provenance_source.push('imported')
    cols.is_active.push(true)

    const table = buildTable(cols)
    expect(table.numRows).toBe(1)
    expect(table.getChild('id')?.get(0)).toBe('r1')
    expect(table.getChild('text')?.get(0)).toBe('hello')
    expect(table.getChild('is_active')?.get(0)).toBe(true)
  })

  it('builds empty table from empty columns', () => {
    const cols = createEmptyColumns()
    const table = buildTable(cols)
    expect(table.numRows).toBe(0)
  })

  it('handles multiple rows', () => {
    const cols = createEmptyColumns()
    for (let i = 0; i < 5; i++) {
      cols.id.push(`r${i}`)
      cols.namespace.push('ns')
      cols.key.push(`k${i}`)
      cols.scope_tenant.push(null)
      cols.scope_project.push(null)
      cols.scope_agent.push(null)
      cols.scope_session.push(null)
      cols.text.push(`text ${i}`)
      cols.payload_json.push(null)
      cols.system_created_at.push(BigInt(Date.now()))
      cols.system_expired_at.push(null)
      cols.valid_from.push(BigInt(Date.now()))
      cols.valid_until.push(null)
      cols.decay_strength.push(null)
      cols.decay_half_life_ms.push(null)
      cols.decay_last_accessed_at.push(null)
      cols.decay_access_count.push(null)
      cols.agent_id.push(null)
      cols.category.push(null)
      cols.importance.push(null)
      cols.provenance_source.push(null)
      cols.is_active.push(true)
    }

    const table = buildTable(cols)
    expect(table.numRows).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// safeParseDate
// ---------------------------------------------------------------------------

describe('safeParseDate', () => {
  it('parses valid ISO date string', () => {
    const ms = safeParseDate('2025-06-01T00:00:00Z')
    expect(ms).toBe(Date.parse('2025-06-01T00:00:00Z'))
  })

  it('returns fallback for invalid date', () => {
    const ms = safeParseDate('not-a-date', 42)
    expect(ms).toBe(42)
  })

  it('returns Date.now() when fallback not provided and date is invalid', () => {
    const before = Date.now()
    const ms = safeParseDate('bad-date')
    const after = Date.now()
    expect(ms).toBeGreaterThanOrEqual(before)
    expect(ms).toBeLessThanOrEqual(after)
  })

  it('handles epoch zero', () => {
    const ms = safeParseDate('1970-01-01T00:00:00Z')
    expect(ms).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// getString / getBigInt / getFloat
// ---------------------------------------------------------------------------

describe('getString', () => {
  it('reads string value from table', () => {
    const table = tableFromArrays({ name: ['hello', 'world'] })
    expect(getString(table, 'name', 0)).toBe('hello')
    expect(getString(table, 'name', 1)).toBe('world')
  })

  it('returns null for non-existent column', () => {
    const table = tableFromArrays({ name: ['hello'] })
    expect(getString(table, 'missing', 0)).toBeNull()
  })

  it('returns null for null value', () => {
    const table = tableFromArrays({ name: ['hello', null] })
    expect(getString(table, 'name', 1)).toBeNull()
  })
})

describe('getBigInt', () => {
  it('reads bigint value from table', () => {
    const table = tableFromArrays({ ts: [BigInt(1000), BigInt(2000)] })
    expect(getBigInt(table, 'ts', 0)).toBe(BigInt(1000))
  })

  it('returns null for non-existent column', () => {
    const table = tableFromArrays({ ts: [BigInt(1000)] })
    expect(getBigInt(table, 'missing', 0)).toBeNull()
  })
})

describe('getFloat', () => {
  it('reads float value from table', () => {
    const table = tableFromArrays({ score: [0.5, 0.9] })
    expect(getFloat(table, 'score', 0)).toBeCloseTo(0.5, 5)
  })

  it('returns null for non-existent column', () => {
    const table = tableFromArrays({ score: [0.5] })
    expect(getFloat(table, 'missing', 0)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// pushDefaults
// ---------------------------------------------------------------------------

describe('pushDefaults', () => {
  it('pushes default null/imported/true values', () => {
    const cols = createEmptyColumns()

    // Push required fields first to keep arrays in sync
    cols.id.push('r1')
    cols.namespace.push('ns')
    cols.key.push('k1')
    cols.scope_tenant.push(null)
    cols.scope_project.push(null)
    cols.scope_agent.push(null)
    cols.scope_session.push(null)
    cols.text.push('text')
    cols.payload_json.push(null)
    cols.system_created_at.push(BigInt(Date.now()))
    cols.valid_from.push(BigInt(Date.now()))
    cols.agent_id.push(null)
    cols.category.push(null)
    cols.importance.push(null)

    pushDefaults(cols)

    expect(cols.system_expired_at[0]).toBeNull()
    expect(cols.valid_until[0]).toBeNull()
    expect(cols.decay_strength[0]).toBeNull()
    expect(cols.decay_half_life_ms[0]).toBeNull()
    expect(cols.decay_last_accessed_at[0]).toBeNull()
    expect(cols.decay_access_count[0]).toBeNull()
    expect(cols.provenance_source[0]).toBe('imported')
    expect(cols.is_active[0]).toBe(true)
  })

  it('accepts overrides with scopeProject and category defined', () => {
    const cols = createEmptyColumns()

    cols.id.push('r2')
    cols.namespace.push('ns')
    cols.key.push('k2')
    cols.scope_tenant.push(null)
    cols.scope_project.push('proj-1')
    cols.scope_agent.push(null)
    cols.scope_session.push(null)
    cols.text.push('text')
    cols.payload_json.push(null)
    cols.system_created_at.push(BigInt(Date.now()))
    cols.valid_from.push(BigInt(Date.now()))
    cols.agent_id.push(null)
    cols.category.push('lesson')
    cols.importance.push(0.8)

    // Passing overrides covers the if(overrides) branch and the
    // scopeProject/category sub-branches inside pushDefaults
    pushDefaults(cols, { scopeProject: 'proj-1', category: 'lesson' })

    expect(cols.system_expired_at[0]).toBeNull()
    expect(cols.provenance_source[0]).toBe('imported')
    expect(cols.is_active[0]).toBe(true)
  })

  it('accepts overrides with undefined scopeProject and category', () => {
    const cols = createEmptyColumns()

    cols.id.push('r3')
    cols.namespace.push('ns')
    cols.key.push('k3')
    cols.scope_tenant.push(null)
    cols.scope_project.push(null)
    cols.scope_agent.push(null)
    cols.scope_session.push(null)
    cols.text.push('text')
    cols.payload_json.push(null)
    cols.system_created_at.push(BigInt(Date.now()))
    cols.valid_from.push(BigInt(Date.now()))
    cols.agent_id.push(null)
    cols.category.push(null)
    cols.importance.push(null)

    // overrides present but without scopeProject or category — hits the outer
    // if(overrides) branch but not the inner sub-branches
    pushDefaults(cols, { scopeSession: 'sess-1' })

    expect(cols.provenance_source[0]).toBe('imported')
    expect(cols.is_active[0]).toBe(true)
  })
})
