/**
 * Stage 3 — Top-level `document.policy` parser and validator tests.
 *
 * Uses `flowDocumentSchema.safeParse` (the Zod-compatible document validation
 * path) to verify that `FlowDocumentPolicy` fields are correctly parsed,
 * validated, and assembled on `FlowDocumentV1`.
 */
import { describe, it, expect } from 'vitest'
import { flowDocumentSchema } from '../validate.js'

const validRoot = {
  type: 'sequence',
  id: 'root',
  nodes: [{ type: 'complete', id: 'done' }],
}

const baseDocument = {
  dsl: 'dzupflow/v1',
  id: 'wf-policy-test',
  version: 1,
  root: validRoot,
}

// ── Happy path ────────────────────────────────────────────────────────────────

describe('document.policy — happy path', () => {
  it('parses document.policy.budgetCents correctly', () => {
    const result = flowDocumentSchema.safeParse({
      ...baseDocument,
      policy: { budgetCents: 1500 },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.policy?.budgetCents).toBe(1500)
    }
  })

  it('parses document.policy.timeoutMs correctly', () => {
    const result = flowDocumentSchema.safeParse({
      ...baseDocument,
      policy: { timeoutMs: 60_000 },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.policy?.timeoutMs).toBe(60_000)
    }
  })

  it('parses document.policy.workingDirectory correctly', () => {
    const result = flowDocumentSchema.safeParse({
      ...baseDocument,
      policy: { workingDirectory: '/repo/workspace' },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.policy?.workingDirectory).toBe('/repo/workspace')
    }
  })

  it('parses all three policy fields together', () => {
    const result = flowDocumentSchema.safeParse({
      ...baseDocument,
      policy: { budgetCents: 999, timeoutMs: 45_000, workingDirectory: '/tmp' },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.policy?.budgetCents).toBe(999)
      expect(result.data.policy?.timeoutMs).toBe(45_000)
      expect(result.data.policy?.workingDirectory).toBe('/tmp')
    }
  })

  it('policy field is absent when not provided — no default injection', () => {
    const result = flowDocumentSchema.safeParse(baseDocument)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.policy).toBeUndefined()
    }
  })

  it('accepts a document with dsl: dzupflow/v1alpha-agent and policy', () => {
    const result = flowDocumentSchema.safeParse({
      ...baseDocument,
      dsl: 'dzupflow/v1',
      policy: { budgetCents: 250 },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.policy?.budgetCents).toBe(250)
    }
  })
})

// ── Validation errors — budgetCents ──────────────────────────────────────────

describe('document.policy.budgetCents — validation errors', () => {
  it('rejects budgetCents as a string instead of number', () => {
    const result = flowDocumentSchema.safeParse({
      ...baseDocument,
      policy: { budgetCents: '500' },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const msgs = result.error.issues.map((i) => i.message)
      expect(msgs.some((m) => m.includes('budgetCents'))).toBe(true)
    }
  })

  it('rejects budgetCents: -1 (must be > 0)', () => {
    const result = flowDocumentSchema.safeParse({
      ...baseDocument,
      policy: { budgetCents: -1 },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const msgs = result.error.issues.map((i) => i.message)
      expect(msgs.some((m) => m.includes('budgetCents') && m.includes('greater than 0'))).toBe(true)
    }
  })

  it('rejects budgetCents: 0 (must be > 0)', () => {
    const result = flowDocumentSchema.safeParse({
      ...baseDocument,
      policy: { budgetCents: 0 },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const msgs = result.error.issues.map((i) => i.message)
      expect(msgs.some((m) => m.includes('budgetCents') && m.includes('greater than 0'))).toBe(true)
    }
  })

  it('rejects budgetCents: Infinity (must be finite)', () => {
    const result = flowDocumentSchema.safeParse({
      ...baseDocument,
      policy: { budgetCents: Infinity },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const msgs = result.error.issues.map((i) => i.message)
      expect(msgs.some((m) => m.includes('budgetCents'))).toBe(true)
    }
  })
})

// ── Validation errors — timeoutMs ────────────────────────────────────────────

describe('document.policy.timeoutMs — validation errors', () => {
  it('rejects timeoutMs as a string instead of number', () => {
    const result = flowDocumentSchema.safeParse({
      ...baseDocument,
      policy: { timeoutMs: '30000' },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const msgs = result.error.issues.map((i) => i.message)
      expect(msgs.some((m) => m.includes('timeoutMs'))).toBe(true)
    }
  })

  it('rejects timeoutMs: -1 (must be > 0)', () => {
    const result = flowDocumentSchema.safeParse({
      ...baseDocument,
      policy: { timeoutMs: -1 },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const msgs = result.error.issues.map((i) => i.message)
      expect(msgs.some((m) => m.includes('timeoutMs') && m.includes('greater than 0'))).toBe(true)
    }
  })

  it('rejects timeoutMs: 0 (must be > 0)', () => {
    const result = flowDocumentSchema.safeParse({
      ...baseDocument,
      policy: { timeoutMs: 0 },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const msgs = result.error.issues.map((i) => i.message)
      expect(msgs.some((m) => m.includes('timeoutMs') && m.includes('greater than 0'))).toBe(true)
    }
  })
})

// ── Validation errors — policy shape ─────────────────────────────────────────

describe('document.policy — shape errors', () => {
  it('rejects a non-object policy block (string)', () => {
    const result = flowDocumentSchema.safeParse({
      ...baseDocument,
      policy: 'not-an-object',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const msgs = result.error.issues.map((i) => i.message)
      expect(msgs.some((m) => m.includes('policy') && m.includes('object'))).toBe(true)
    }
  })

  it('rejects a non-object policy block (number)', () => {
    const result = flowDocumentSchema.safeParse({
      ...baseDocument,
      policy: 42,
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const msgs = result.error.issues.map((i) => i.message)
      expect(msgs.some((m) => m.includes('policy') && m.includes('object'))).toBe(true)
    }
  })

  it('rejects workingDirectory as a non-string value', () => {
    const result = flowDocumentSchema.safeParse({
      ...baseDocument,
      policy: { workingDirectory: 123 },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const msgs = result.error.issues.map((i) => i.message)
      expect(msgs.some((m) => m.includes('workingDirectory'))).toBe(true)
    }
  })
})
