import { describe, it, expect } from 'vitest'

import {
  RunRequestSchema,
  SupervisorRequestSchema,
  ParallelRequestSchema,
  BidRequestSchema,
  ApproveRequestSchema,
} from '../http/request-schemas.js'

describe('RunRequestSchema', () => {
  it('accepts a valid request', () => {
    const result = RunRequestSchema.safeParse({
      prompt: 'Hello world',
      tags: ['test'],
      preferredProvider: 'claude',
      stream: true,
    })
    expect(result.success).toBe(true)
  })

  it('accepts a minimal valid request', () => {
    const result = RunRequestSchema.safeParse({ prompt: 'Hi' })
    expect(result.success).toBe(true)
  })

  it('rejects missing prompt', () => {
    const result = RunRequestSchema.safeParse({ tags: ['test'] })
    expect(result.success).toBe(false)
  })

  it('rejects prompt of wrong type', () => {
    const result = RunRequestSchema.safeParse({ prompt: 42 })
    expect(result.success).toBe(false)
  })

  it('rejects empty prompt', () => {
    const result = RunRequestSchema.safeParse({ prompt: '' })
    expect(result.success).toBe(false)
  })

  it('rejects prompt that is too long', () => {
    const result = RunRequestSchema.safeParse({ prompt: 'x'.repeat(100_001) })
    expect(result.success).toBe(false)
  })

  it('rejects invalid preferredProvider', () => {
    const result = RunRequestSchema.safeParse({
      prompt: 'Hello',
      preferredProvider: 'invalid-provider',
    })
    expect(result.success).toBe(false)
  })

  it('rejects maxTurns exceeding limit', () => {
    const result = RunRequestSchema.safeParse({
      prompt: 'Hello',
      maxTurns: 1001,
    })
    expect(result.success).toBe(false)
  })
})

describe('SupervisorRequestSchema', () => {
  it('accepts a valid request', () => {
    const result = SupervisorRequestSchema.safeParse({
      goal: 'Build a feature',
      maxConcurrency: 5,
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing goal', () => {
    const result = SupervisorRequestSchema.safeParse({ maxConcurrency: 5 })
    expect(result.success).toBe(false)
  })

  it('rejects empty goal', () => {
    const result = SupervisorRequestSchema.safeParse({ goal: '' })
    expect(result.success).toBe(false)
  })
})

describe('ParallelRequestSchema', () => {
  it('accepts a valid request', () => {
    const result = ParallelRequestSchema.safeParse({
      prompt: 'Hello',
      providers: ['claude', 'gemini'],
      strategy: 'first-wins',
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty providers array', () => {
    const result = ParallelRequestSchema.safeParse({
      prompt: 'Hello',
      providers: [],
    })
    expect(result.success).toBe(false)
  })

  it('rejects missing providers', () => {
    const result = ParallelRequestSchema.safeParse({ prompt: 'Hello' })
    expect(result.success).toBe(false)
  })

  it('rejects invalid strategy', () => {
    const result = ParallelRequestSchema.safeParse({
      prompt: 'Hello',
      providers: ['claude'],
      strategy: 'invalid-strategy',
    })
    expect(result.success).toBe(false)
  })

  it('rejects too many providers', () => {
    const result = ParallelRequestSchema.safeParse({
      prompt: 'Hello',
      providers: [
        'claude', 'codex', 'gemini', 'qwen', 'crush',
        'claude', 'codex', 'gemini', 'qwen', 'crush',
        'claude',
      ],
    })
    expect(result.success).toBe(false)
  })
})

describe('BidRequestSchema', () => {
  it('accepts a valid request', () => {
    const result = BidRequestSchema.safeParse({ prompt: 'Hello' })
    expect(result.success).toBe(true)
  })

  it('accepts a request with criteria', () => {
    const result = BidRequestSchema.safeParse({
      prompt: 'Hello',
      criteria: 'lowest-cost',
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing prompt', () => {
    const result = BidRequestSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it('rejects invalid criteria', () => {
    const result = BidRequestSchema.safeParse({
      prompt: 'Hello',
      criteria: 'invalid',
    })
    expect(result.success).toBe(false)
  })
})

describe('ApproveRequestSchema', () => {
  it('accepts a valid approval', () => {
    const result = ApproveRequestSchema.safeParse({
      approved: true,
      reason: 'Looks good',
    })
    expect(result.success).toBe(true)
  })

  it('accepts a valid rejection', () => {
    const result = ApproveRequestSchema.safeParse({ approved: false })
    expect(result.success).toBe(true)
  })

  it('rejects missing approved field', () => {
    const result = ApproveRequestSchema.safeParse({ reason: 'No reason' })
    expect(result.success).toBe(false)
  })

  it('rejects wrong type for approved', () => {
    const result = ApproveRequestSchema.safeParse({ approved: 'yes' })
    expect(result.success).toBe(false)
  })

  it('rejects reason that is too long', () => {
    const result = ApproveRequestSchema.safeParse({
      approved: true,
      reason: 'x'.repeat(10_001),
    })
    expect(result.success).toBe(false)
  })
})
