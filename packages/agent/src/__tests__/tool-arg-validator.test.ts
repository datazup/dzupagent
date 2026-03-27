import { describe, it, expect } from 'vitest'
import {
  validateAndRepairToolArgs,
  formatSchemaHint,
} from '../agent/tool-arg-validator.js'

const SCHEMA_WITH_DEFAULTS = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    lines: { type: 'number', default: 100 },
    recursive: { type: 'boolean', default: false },
  },
  required: ['path'],
}

const SCHEMA_ARRAY = {
  type: 'object',
  properties: {
    tags: { type: 'array', items: { type: 'string' } },
    name: { type: 'string' },
  },
  required: ['tags', 'name'],
}

describe('validateAndRepairToolArgs', () => {
  // ---- Valid args pass through unchanged ----

  it('passes valid args through unchanged', () => {
    const args = { path: '/src/index.ts', lines: 50, recursive: true }
    const result = validateAndRepairToolArgs(args, SCHEMA_WITH_DEFAULTS)

    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.repairedArgs).toEqual(args)
  })

  it('passes valid args with optional fields omitted', () => {
    const args = { path: '/src/index.ts' }
    const result = validateAndRepairToolArgs(args, SCHEMA_WITH_DEFAULTS)

    expect(result.valid).toBe(true)
    // Missing optional fields with defaults should be filled in
    expect(result.repairedArgs).toEqual({
      path: '/src/index.ts',
      lines: 100,
      recursive: false,
    })
  })

  // ---- String-to-number coercion ----

  it('coerces string to number when autoRepair is enabled', () => {
    const args = { path: '/src/index.ts', lines: '42' }
    const result = validateAndRepairToolArgs(args, SCHEMA_WITH_DEFAULTS)

    expect(result.valid).toBe(true)
    expect(result.repairedArgs!.lines).toBe(42)
  })

  it('coerces string to number for float values', () => {
    const schema = {
      type: 'object',
      properties: { score: { type: 'number' } },
      required: ['score'],
    }
    const result = validateAndRepairToolArgs({ score: '3.14' }, schema)

    expect(result.valid).toBe(true)
    expect(result.repairedArgs!.score).toBeCloseTo(3.14)
  })

  it('fails string-to-number coercion for non-numeric strings', () => {
    const schema = {
      type: 'object',
      properties: { count: { type: 'number' } },
      required: ['count'],
    }
    const result = validateAndRepairToolArgs(
      { count: 'not-a-number' },
      schema,
      { autoRepair: false },
    )

    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors[0]).toContain('Expected number')
  })

  // ---- String-to-boolean coercion ----

  it('coerces string "true" to boolean true', () => {
    const args = { path: '/src', recursive: 'true' }
    const result = validateAndRepairToolArgs(args, SCHEMA_WITH_DEFAULTS)

    expect(result.valid).toBe(true)
    expect(result.repairedArgs!.recursive).toBe(true)
  })

  it('coerces string "false" to boolean false', () => {
    const args = { path: '/src', recursive: 'false' }
    const result = validateAndRepairToolArgs(args, SCHEMA_WITH_DEFAULTS)

    expect(result.valid).toBe(true)
    expect(result.repairedArgs!.recursive).toBe(false)
  })

  // ---- Missing required field with default ----

  it('fills missing optional fields with defaults', () => {
    const args = { path: '/src/file.ts' }
    const result = validateAndRepairToolArgs(args, SCHEMA_WITH_DEFAULTS)

    expect(result.valid).toBe(true)
    expect(result.repairedArgs!.lines).toBe(100)
    expect(result.repairedArgs!.recursive).toBe(false)
  })

  it('fails when required field is missing with no default', () => {
    const args = { lines: 50 }
    const result = validateAndRepairToolArgs(args, SCHEMA_WITH_DEFAULTS)

    expect(result.valid).toBe(false)
    expect(result.errors).toContain('Missing required field "path"')
  })

  // ---- Extra fields removed ----

  it('removes extra fields not in schema when autoRepair is enabled', () => {
    const args = {
      path: '/src/index.ts',
      lines: 50,
      hallucinated_field: 'should be removed',
      another_extra: 123,
    }
    const result = validateAndRepairToolArgs(args, SCHEMA_WITH_DEFAULTS)

    expect(result.valid).toBe(true)
    expect(result.repairedArgs).not.toHaveProperty('hallucinated_field')
    expect(result.repairedArgs).not.toHaveProperty('another_extra')
    expect(result.repairedArgs!.path).toBe('/src/index.ts')
  })

  it('reports extra fields as errors when autoRepair is disabled', () => {
    const args = { path: '/src/index.ts', extra: 'field' }
    const result = validateAndRepairToolArgs(args, SCHEMA_WITH_DEFAULTS, {
      autoRepair: false,
    })

    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('Unexpected field "extra"'))).toBe(true)
  })

  // ---- Array wrapping for single values ----

  it('wraps single value in array when schema expects array', () => {
    const args = { tags: 'typescript', name: 'my-project' }
    const result = validateAndRepairToolArgs(args, SCHEMA_ARRAY)

    expect(result.valid).toBe(true)
    expect(result.repairedArgs!.tags).toEqual(['typescript'])
  })

  it('passes arrays through unchanged', () => {
    const args = { tags: ['ts', 'node'], name: 'my-project' }
    const result = validateAndRepairToolArgs(args, SCHEMA_ARRAY)

    expect(result.valid).toBe(true)
    expect(result.repairedArgs!.tags).toEqual(['ts', 'node'])
  })

  // ---- Invalid after repair returns errors ----

  it('returns invalid when args is null and no defaults available', () => {
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    }
    const result = validateAndRepairToolArgs(null, schema)

    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('returns invalid when args is a non-object type', () => {
    const result = validateAndRepairToolArgs('just a string', SCHEMA_WITH_DEFAULTS)

    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('Expected args to be an object')
  })

  it('returns invalid for array args', () => {
    const result = validateAndRepairToolArgs([1, 2, 3], SCHEMA_WITH_DEFAULTS)

    expect(result.valid).toBe(false)
  })

  // ---- Null/undefined replaced with defaults ----

  it('replaces null values with schema defaults', () => {
    const args = { path: '/src', lines: null }
    const result = validateAndRepairToolArgs(args, SCHEMA_WITH_DEFAULTS)

    expect(result.valid).toBe(true)
    expect(result.repairedArgs!.lines).toBe(100)
  })

  it('replaces undefined values with schema defaults', () => {
    const args = { path: '/src', lines: undefined }
    const result = validateAndRepairToolArgs(args, SCHEMA_WITH_DEFAULTS)

    expect(result.valid).toBe(true)
    expect(result.repairedArgs!.lines).toBe(100)
  })

  // ---- Integer coercion ----

  it('rounds floats to integers when schema expects integer', () => {
    const schema = {
      type: 'object',
      properties: { count: { type: 'integer' } },
      required: ['count'],
    }
    const result = validateAndRepairToolArgs({ count: 3.7 }, schema)

    expect(result.valid).toBe(true)
    expect(result.repairedArgs!.count).toBe(4)
  })

  // ---- autoRepair=false strict mode ----

  it('does not coerce types when autoRepair is false', () => {
    const args = { path: '/src', lines: '42' }
    const result = validateAndRepairToolArgs(args, SCHEMA_WITH_DEFAULTS, {
      autoRepair: false,
    })

    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('Expected number'))).toBe(true)
  })

  // ---- null args with all-defaulted schema ----

  it('builds from defaults when args is null and all fields have defaults', () => {
    const schema = {
      type: 'object',
      properties: {
        limit: { type: 'number', default: 10 },
        verbose: { type: 'boolean', default: false },
      },
    }
    const result = validateAndRepairToolArgs(null, schema)

    expect(result.valid).toBe(true)
    expect(result.repairedArgs).toEqual({ limit: 10, verbose: false })
  })

  // ---- Empty schema (no properties) ----

  it('accepts any object when schema has no properties defined', () => {
    const result = validateAndRepairToolArgs({ foo: 'bar' }, { type: 'object' })

    expect(result.valid).toBe(true)
  })
})

describe('formatSchemaHint', () => {
  it('formats schema hint with types and required markers', () => {
    const hint = formatSchemaHint(SCHEMA_WITH_DEFAULTS)

    expect(hint).toContain('Expected arguments:')
    expect(hint).toContain('path: string (required)')
    expect(hint).toContain('lines: number')
    expect(hint).toContain('[default: 100]')
    expect(hint).toContain('recursive: boolean')
  })
})
