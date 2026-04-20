import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { LlmRecorder } from '../llm-recorder.js'
import type { MiddlewareContext } from '@dzupagent/core'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXED_FIXTURE_DIR = join(import.meta.dirname, '__fixtures__/llm')
const TMP_DIR = join(import.meta.dirname, '__fixtures__/llm-tmp')

function makeCtx(overrides: Partial<MiddlewareContext> = {}): MiddlewareContext {
  return {
    messages: [{ role: 'user', content: 'What is 2 + 2?' }],
    model: 'claude-haiku-4-5-20251001',
    provider: 'anthropic',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Demo test — replay mode using committed fixture
// ---------------------------------------------------------------------------

describe('LlmRecorder — replay mode (demo)', () => {
  it('returns the saved response without hitting the network', async () => {
    const recorder = new LlmRecorder({ fixtureDir: FIXED_FIXTURE_DIR, mode: 'replay' })
    const ctx = makeCtx()

    const result = await recorder.beforeInvoke(ctx)

    expect(result.cached).toBe(true)
    expect(result.response).toBe('2 + 2 = 4')
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 9 })
  })

  it('exposes hasFixture() for test assertions', () => {
    const recorder = new LlmRecorder({ fixtureDir: FIXED_FIXTURE_DIR, mode: 'replay' })
    expect(recorder.hasFixture(makeCtx())).toBe(true)
    expect(recorder.hasFixture(makeCtx({ messages: [{ role: 'user', content: 'different' }] }))).toBe(false)
  })

  it('getFixturePath() returns expected file path', () => {
    const recorder = new LlmRecorder({ fixtureDir: FIXED_FIXTURE_DIR, mode: 'replay' })
    const path = recorder.getFixturePath(makeCtx())
    expect(path).toMatch(/979e216412bab6ce\.json$/)
  })
})

// ---------------------------------------------------------------------------
// Unit tests — replay strict mode
// ---------------------------------------------------------------------------

describe('LlmRecorder — strict replay (no fixture)', () => {
  it('throws when fixture is missing and strict=true', async () => {
    const recorder = new LlmRecorder({
      fixtureDir: FIXED_FIXTURE_DIR,
      mode: 'replay',
      strict: true,
    })
    const ctx = makeCtx({ messages: [{ role: 'user', content: 'no fixture for this' }] })

    await expect(recorder.beforeInvoke(ctx)).rejects.toThrow('[LlmRecorder] No fixture found')
  })

  it('returns { cached: false } when fixture is missing and strict=false', async () => {
    const recorder = new LlmRecorder({
      fixtureDir: FIXED_FIXTURE_DIR,
      mode: 'replay',
      strict: false,
    })
    const ctx = makeCtx({ messages: [{ role: 'user', content: 'no fixture here either' }] })

    const result = await recorder.beforeInvoke(ctx)
    expect(result.cached).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Unit tests — record mode
// ---------------------------------------------------------------------------

describe('LlmRecorder — record mode', () => {
  beforeEach(() => mkdirSync(TMP_DIR, { recursive: true }))
  afterEach(() => rmSync(TMP_DIR, { recursive: true, force: true }))

  it('passes through (cached=false) in beforeInvoke', async () => {
    const recorder = new LlmRecorder({ fixtureDir: TMP_DIR, mode: 'record' })
    const result = await recorder.beforeInvoke(makeCtx())
    expect(result.cached).toBe(false)
  })

  it('writes a fixture file after afterInvoke', async () => {
    const recorder = new LlmRecorder({ fixtureDir: TMP_DIR, mode: 'record' })
    const ctx = makeCtx()

    await recorder.afterInvoke(ctx, 'the answer is 4', { inputTokens: 10, outputTokens: 5, totalTokens: 15 })

    expect(existsSync(recorder.getFixturePath(ctx))).toBe(true)
  })

  it('written fixture round-trips correctly in replay mode', async () => {
    const recorder = new LlmRecorder({ fixtureDir: TMP_DIR, mode: 'record' })
    const ctx = makeCtx()

    await recorder.afterInvoke(ctx, 'the answer is 4', { inputTokens: 10, outputTokens: 5, totalTokens: 15 })

    // Switch to replay
    const replayer = new LlmRecorder({ fixtureDir: TMP_DIR, mode: 'replay' })
    const result = await replayer.beforeInvoke(ctx)

    expect(result.cached).toBe(true)
    expect(result.response).toBe('the answer is 4')
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
  })

  it('does not write a fixture in replay mode', async () => {
    const recorder = new LlmRecorder({ fixtureDir: TMP_DIR, mode: 'replay', strict: false })
    const ctx = makeCtx()

    await recorder.afterInvoke(ctx, 'should not be written')

    expect(existsSync(recorder.getFixturePath(ctx))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Unit tests — seedFixture helper
// ---------------------------------------------------------------------------

describe('LlmRecorder — seedFixture', () => {
  beforeEach(() => mkdirSync(TMP_DIR, { recursive: true }))
  afterEach(() => rmSync(TMP_DIR, { recursive: true, force: true }))

  it('seeds a fixture that replay picks up', async () => {
    const recorder = new LlmRecorder({ fixtureDir: TMP_DIR, mode: 'replay' })
    const ctx = makeCtx({ messages: [{ role: 'user', content: 'seeded question' }] })

    recorder.seedFixture(ctx, 'seeded answer', { inputTokens: 5, outputTokens: 3 })

    const result = await recorder.beforeInvoke(ctx)
    expect(result.cached).toBe(true)
    expect(result.response).toBe('seeded answer')
  })

  it('overwrites an existing fixture', async () => {
    const recorder = new LlmRecorder({ fixtureDir: TMP_DIR, mode: 'replay' })
    const ctx = makeCtx({ messages: [{ role: 'user', content: 'overwrite me' }] })

    recorder.seedFixture(ctx, 'first answer')
    recorder.seedFixture(ctx, 'second answer')

    const result = await recorder.beforeInvoke(ctx)
    expect(result.response).toBe('second answer')
  })
})

// ---------------------------------------------------------------------------
// Unit tests — hash stability
// ---------------------------------------------------------------------------

describe('LlmRecorder — hash stability', () => {
  it('same context always resolves to the same fixture path', () => {
    const r1 = new LlmRecorder({ fixtureDir: '/tmp/a', mode: 'replay', strict: false })
    const r2 = new LlmRecorder({ fixtureDir: '/tmp/a', mode: 'replay', strict: false })
    const ctx = makeCtx()
    expect(r1.getFixturePath(ctx)).toBe(r2.getFixturePath(ctx))
  })

  it('different messages produce different fixture paths', () => {
    const recorder = new LlmRecorder({ fixtureDir: '/tmp/a', mode: 'replay', strict: false })
    const p1 = recorder.getFixturePath(makeCtx({ messages: [{ role: 'user', content: 'a' }] }))
    const p2 = recorder.getFixturePath(makeCtx({ messages: [{ role: 'user', content: 'b' }] }))
    expect(p1).not.toBe(p2)
  })

  it('different providers produce different fixture paths', () => {
    const recorder = new LlmRecorder({ fixtureDir: '/tmp/a', mode: 'replay', strict: false })
    const p1 = recorder.getFixturePath(makeCtx({ provider: 'anthropic' }))
    const p2 = recorder.getFixturePath(makeCtx({ provider: 'openai' }))
    expect(p1).not.toBe(p2)
  })
})

// ---------------------------------------------------------------------------
// Middleware name
// ---------------------------------------------------------------------------

describe('LlmRecorder — RegistryMiddleware contract', () => {
  it('exposes name = "llm-recorder"', () => {
    const recorder = new LlmRecorder({ fixtureDir: '/tmp', mode: 'replay', strict: false })
    expect(recorder.name).toBe('llm-recorder')
  })
})
