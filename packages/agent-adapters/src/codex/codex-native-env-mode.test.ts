import { EventEmitter } from 'node:events'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildNativeContextEnv, CodexCliAdapter } from './codex-cli-adapter.js'
import type { AgentStreamEvent } from '../types.js'

// WB-IMAGE-NATIVE-ENV-REPAIR-20261104-R1: native-context runs use a replacement environment.
const NATIVE_ID = '11111111-1111-1111-1111-111111111111'
const AMBIENT = 'VIPSHOME'
const AMBIENT_VALUE = 'ambient-value-must-not-leak'

type FakeChild = ChildProcess & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough }

function child(): FakeChild {
  const c = new EventEmitter() as FakeChild
  c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.stdin = new PassThrough()
  Object.assign(c, { exitCode: null, signalCode: null, pid: 4242, kill: vi.fn() })
  queueMicrotask(() => {
    c.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: NATIVE_ID }) + '\n')
    c.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\n')
    c.stdout.end(); c.stderr.end(); Object.assign(c, { exitCode: 0 }); c.emit('close', 0, null)
  })
  return c
}

async function collect(gen: AsyncGenerator<AgentStreamEvent, void, undefined>): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = []
  for await (const event of gen) events.push(event)
  return events
}

describe('buildNativeContextEnv', () => {
  it('returns only configured non-sensitive entries plus CODEX_HOME', () => {
    const env = buildNativeContextEnv({ PATH: '/bin', LANG: 'C', OPENAI_API_KEY: 'k', CODEX_ACCESS_TOKEN: 't' }, '/profile')
    expect(env).toEqual({ PATH: '/bin', LANG: 'C', CODEX_HOME: '/profile' })
  })

  it('never reads ambient process.env', () => {
    process.env[AMBIENT] = AMBIENT_VALUE
    try {
      expect(Object.keys(buildNativeContextEnv(undefined, '/profile'))).toEqual(['CODEX_HOME'])
      expect(buildNativeContextEnv({ PATH: '/bin' }, '/profile')).not.toHaveProperty(AMBIENT)
    } finally { delete process.env[AMBIENT] }
  })

  it('overrides a configured CODEX_HOME with the qualified profile root', () => {
    expect(buildNativeContextEnv({ CODEX_HOME: '/other' }, '/profile').CODEX_HOME).toBe('/profile')
  })

  it.each(['', undefined, 7, null])('rejects a missing profile root (%s) without naming any variable', (root) => {
    let caught: unknown
    try { buildNativeContextEnv({ PATH: '/bin', SECRET_THING: 'value-123' }, root as unknown as string) } catch (error) { caught = error }
    expect(caught).toMatchObject({ context: { reason: 'native_context_env_unqualified' } })
    const text = String((caught as Error).message) + JSON.stringify(caught)
    expect(text).not.toContain('SECRET_THING')
    expect(text).not.toContain('value-123')
  })
})

describe('native-context spawn environment', () => {
  const roots: string[] = []
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

  async function profile(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'codex-native-env-'))
    roots.push(root); await chmod(root, 0o700); await writeFile(join(root, 'sentinel'), 'unchanged')
    return root
  }

  it('spawns with only the configured environment even when an ambient variable appears after construction', async () => {
    const root = await profile()
    const seen: Array<Record<string, string | undefined>> = []
    const spawn = vi.fn((_command: string, _args: readonly string[], options: SpawnOptions) => {
      seen.push({ ...(options.env as Record<string, string | undefined>) }); return child()
    })
    const authorize = vi.fn(async (_input: unknown, candidate: { env?: Record<string, string | undefined> }) => {
      expect(candidate.env).not.toHaveProperty(AMBIENT)
    })
    const adapter = new CodexCliAdapter({ env: { PATH: '/usr/bin', LANG: 'C' }, nativeContext: { profileRoot: root, authorize: authorize as never },
      runtimeDependencies: { spawn: spawn as never } })
    process.env[AMBIENT] = AMBIENT_VALUE
    try {
      await collect(adapter.executeWithRaw({ prompt: 'bounded', options: { sandboxMode: 'read-only', approvalPolicy: 'never' } }))
    } finally { delete process.env[AMBIENT] }
    expect(spawn).toHaveBeenCalledOnce()
    expect(seen[0]).toEqual({ PATH: '/usr/bin', LANG: 'C', CODEX_HOME: root })
    expect(authorize).toHaveBeenCalledOnce()
  })

  it('keeps ordinary (non-native) behaviour: ambient environment still passes through', async () => {
    const spawn = vi.fn((_command: string, _args: readonly string[], options: SpawnOptions) => {
      expect((options.env as Record<string, string | undefined>)[AMBIENT]).toBe(AMBIENT_VALUE); return child()
    })
    const adapter = new CodexCliAdapter({ runtimeDependencies: { spawn: spawn as never } })
    process.env[AMBIENT] = AMBIENT_VALUE
    try {
      await collect(adapter.executeWithRaw({ prompt: 'ordinary', options: { sandboxMode: 'read-only', approvalPolicy: 'never' } }))
    } finally { delete process.env[AMBIENT] }
    expect(spawn).toHaveBeenCalledOnce()
  })
})
