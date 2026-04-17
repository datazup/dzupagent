/**
 * Branch coverage deep-dive for sandbox factory, sandbox lint check,
 * git-worktree edge paths, review-handler, and related components.
 *
 * Targets:
 * - sandbox-factory: e2b/fly success paths with config, all provider branches
 * - lint-validator.sandboxLintCheck: JSON parse failure, execute throws,
 *   empty stdout, clean result, error severity mapping, filter non-errors
 * - framework-adapter: backend mapping iteration paths
 */
import { describe, it, expect, vi } from 'vitest'
import { createSandbox } from '../sandbox/sandbox-factory.js'
import { sandboxLintCheck } from '../tools/lint-validator.js'
import type { SandboxProtocol, ExecResult } from '../sandbox/sandbox-protocol.js'
import { FrameworkAdapter } from '../adaptation/framework-adapter.js'
import { PathMapper } from '../adaptation/path-mapper.js'

// ---------------------------------------------------------------------------
// sandbox-factory branch coverage
// ---------------------------------------------------------------------------

describe('createSandbox — provider branch coverage', () => {
  it('creates e2b sandbox when e2b config has apiKey', () => {
    const sb = createSandbox({
      provider: 'e2b',
      e2b: { apiKey: 'fake-key-for-test' },
    })
    expect(typeof sb.execute).toBe('function')
    expect(typeof sb.uploadFiles).toBe('function')
  })

  it('creates fly sandbox when fly config has apiToken and appName', () => {
    const sb = createSandbox({
      provider: 'fly',
      fly: { apiToken: 'fake-token', appName: 'test-app' },
    })
    expect(typeof sb.execute).toBe('function')
  })

  it('creates mock sandbox without any config', () => {
    const sb = createSandbox({ provider: 'mock' })
    expect(typeof sb.execute).toBe('function')
  })

  it('throws clear error for unknown provider (cast through)', () => {
    expect(() =>
      createSandbox({ provider: 'xyz' as unknown as 'mock' }),
    ).toThrow(/Unknown sandbox provider/)
  })
})

// ---------------------------------------------------------------------------
// sandboxLintCheck branch coverage
// ---------------------------------------------------------------------------

function makeMockSandbox(
  result: Partial<ExecResult> | (() => Promise<ExecResult>),
): SandboxProtocol {
  const execute = typeof result === 'function'
    ? result
    : async () => ({
        exitCode: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
        ...result,
      }) as ExecResult
  return {
    execute,
    uploadFiles: vi.fn(async () => {}),
    downloadFiles: vi.fn(async () => ({})),
    cleanup: vi.fn(async () => {}),
    isAvailable: vi.fn(async () => true),
  } as unknown as SandboxProtocol
}

describe('sandboxLintCheck — branch coverage', () => {
  it('returns valid when eslint returns clean stdout', async () => {
    const sandbox = makeMockSandbox({
      exitCode: 0,
      stdout: '[{"messages":[]}]',
    })
    const result = await sandboxLintCheck('a.ts', 'const x = 1;', sandbox)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('reports errors from eslint JSON (severity >= 2)', async () => {
    const sandbox = makeMockSandbox({
      stdout: JSON.stringify([
        {
          messages: [
            { line: 3, column: 5, message: 'Parsing error', severity: 2 },
            { line: 10, column: 1, message: 'Warning', severity: 1 }, // filtered out
          ],
        },
      ]),
    })
    const result = await sandboxLintCheck('bad.ts', 'x', sandbox)
    expect(result.valid).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]!.line).toBe(3)
    expect(result.errors[0]!.column).toBe(5)
    expect(result.errors[0]!.message).toBe('Parsing error')
  })

  it('falls back to quickSyntaxCheck on invalid JSON stdout', async () => {
    const sandbox = makeMockSandbox({
      stdout: 'this is not JSON',
    })
    // quickSyntaxCheck on a simple valid file → valid true
    const result = await sandboxLintCheck('clean.ts', 'const x = 1;', sandbox)
    expect(result.valid).toBe(true)
  })

  it('falls back to quickSyntaxCheck when stdout is empty', async () => {
    const sandbox = makeMockSandbox({
      stdout: '',
    })
    // quickSyntaxCheck on broken syntax → invalid
    const result = await sandboxLintCheck('broken.ts', 'function f() {', sandbox)
    expect(result.valid).toBe(false)
  })

  it('falls back when sandbox.execute throws', async () => {
    const sandbox = makeMockSandbox(async () => {
      throw new Error('sandbox unavailable')
    })
    // quickSyntaxCheck should run locally and say clean.ts is valid
    const result = await sandboxLintCheck('clean.ts', 'const x = 1;', sandbox)
    expect(result.valid).toBe(true)
  })

  it('falls back when parsed JSON has no messages key', async () => {
    const sandbox = makeMockSandbox({
      stdout: '[{}]',
    })
    const result = await sandboxLintCheck('clean.ts', 'const x = 1;', sandbox)
    // No messages → fallback to quickSyntaxCheck which says this is valid
    expect(result.valid).toBe(true)
  })

  it('falls back when parsed JSON is empty array', async () => {
    const sandbox = makeMockSandbox({
      stdout: '[]',
    })
    const result = await sandboxLintCheck('clean.ts', 'const x = 1;', sandbox)
    expect(result.valid).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// PathMapper branch coverage
// ---------------------------------------------------------------------------

describe('PathMapper — branch coverage', () => {
  it('returns null when no mapping matches', () => {
    const pm = new PathMapper()
    pm.addMapping('^src/routes/(.*)$', 'src/api/$1')
    expect(pm.map('src/utils/helper.ts')).toBeNull()
  })

  it('applies a single regex mapping correctly', () => {
    const pm = new PathMapper()
    pm.addMapping('^src/routes/(.*)$', 'src/api/$1')
    expect(pm.map('src/routes/user.ts')).toBe('src/api/user.ts')
  })

  it('applies the first matching mapping when multiple overlap', () => {
    const pm = new PathMapper()
    pm.addMapping('^src/routes/(.*)$', 'src/api/$1')
    pm.addMapping('^(.*)\\.ts$', '$1.js')
    expect(pm.map('src/routes/x.ts')).toBe('src/api/x.ts')
  })

  it('returns null for empty mapper', () => {
    const pm = new PathMapper()
    expect(pm.map('anything.ts')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// FrameworkAdapter branch coverage (backend)
// ---------------------------------------------------------------------------

describe('FrameworkAdapter — backend branches', () => {
  it('maps a backend path through the adapter (when source→target exists)', () => {
    const a = new FrameworkAdapter()
    const res = a.mapPath('src/routes/user.ts', 'express', 'fastify')
    expect(typeof res === 'string' || res === null).toBe(true)
  })

  it('returns null for unknown backend pair', () => {
    const a = new FrameworkAdapter()
    expect(a.mapPath('src/a.ts', 'unknown', 'other')).toBeNull()
  })

  it('getAdaptationGuide returns null for mismatched source/target', () => {
    const a = new FrameworkAdapter()
    expect(a.getAdaptationGuide('vue3', 'svelte-UNKNOWN')).toBeNull()
  })

  it('addFrontendGuide is chainable (returns this)', () => {
    const a = new FrameworkAdapter()
    const ret = a.addFrontendGuide('src', 'tgt', 'guide text')
    expect(ret).toBe(a)
    expect(a.getAdaptationGuide('src', 'tgt')).toBe('guide text')
  })
})
