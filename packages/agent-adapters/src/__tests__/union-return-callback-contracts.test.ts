/**
 * Locks the callback-return contract of every supplied-callback position in
 * this package.
 *
 * Each of these positions used to be declared `=> void | Promise<void>`.
 * TypeScript's void-returning-function leniency lets a callback that returns a
 * value satisfy a `=> void` position, but that leniency does NOT survive a
 * union: under `=> void | Promise<void>` an expression-bodied arrow such as
 * `(e) => seen.push(e)` is rejected with TS2322 ("Type 'number' is not
 * assignable to type 'void | Promise<void>'"). So the union that reads as the
 * more permissive signature was in fact the stricter one for every caller —
 * which is why commit e8e2ddb4 had to rewrite 16 suites with block bodies.
 *
 * Every callback supplied below therefore uses an EXPRESSION body returning a
 * value. Those are compile-time locks: they are enforced by
 * `tsconfig.flipcheck.json` via `scripts/check-test-typecheck.mjs`, not by
 * vitest (vitest does not typecheck). Restoring any union makes this file fail
 * to typecheck.
 *
 * A type-only lock cannot catch a dropped `await`, so the positions whose
 * runtime awaits their result additionally carry a runtime lock below.
 */
import { describe, expect, it, vi } from 'vitest'

import { CleanupRegistry, type CleanupAction } from '../cli-runtime/cleanup-registry.js'
import type { PreparedCliRun } from '../base/prepared-cli-run.js'
import type { AdapterPluginInstance } from '../plugin/adapter-plugin.js'
import {
  prepareAgentExecutionRunner,
  runPreparedAgentExecution,
} from '../integration/run-agent-execution.js'
import type { AgentExecutionRequest } from '../integration/run-agent-execution.js'
import {
  createNodeProbeRunnerForTesting,
  type NodeProbeRunnerPorts,
  type ProbeCapture,
  type ResolvedProbeExecutable,
} from '../introspection/node-probe-runner.js'
import type {
  AdapterCapabilityProfile,
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
} from '../types.js'

const adapterFactories = vi.hoisted(() => ({
  createClaudeBackendAdapter: vi.fn(),
  createCodexBackendAdapter: vi.fn(),
}))

vi.mock('../codex/codex-backend.js', () => ({
  createCodexBackendAdapter: adapterFactories.createCodexBackendAdapter,
}))

vi.mock('../claude/claude-backend.js', () => ({
  createClaudeBackendAdapter: adapterFactories.createClaudeBackendAdapter,
}))

/** Lets pending microtasks and the timer phase drain before asserting. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

// ---------------------------------------------------------------------------
// cli-runtime/cleanup-registry.ts:1 — CleanupAction
// ---------------------------------------------------------------------------

describe('CleanupAction — supplied-callback contract', () => {
  it('accepts an expression-bodied action that returns a value', async () => {
    const registry = new CleanupRegistry()
    const calls: string[] = []

    // TYPE LOCK: `push` returns number. Rejected under `=> void | Promise<void>`.
    registry.add(() => calls.push('expression-bodied'))

    // The declared public type must also be usable directly by consumers.
    const action: CleanupAction = () => calls.push('via-CleanupAction-alias')
    registry.add(action)

    await registry.cleanup()

    // LIFO, and both actually ran — the arrows are not merely well-typed.
    expect(calls).toEqual(['via-CleanupAction-alias', 'expression-bodied'])
  })

  it('awaits an async action before cleanup() resolves', async () => {
    const registry = new CleanupRegistry()
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    registry.add(async () => {
      await gate
      order.push('action-finished')
    })

    let cleanupResolved = false
    const pending = registry.cleanup().then(() => {
      cleanupResolved = true
      order.push('cleanup-resolved')
    })

    await flush()
    // RUNTIME LOCK: drop the `await action()` and cleanup() resolves here.
    expect(order).toEqual([])
    expect(cleanupResolved).toBe(false)

    release()
    await pending
    expect(order).toEqual(['action-finished', 'cleanup-resolved'])
  })

  it('still surfaces a rejected async action as an AggregateError', async () => {
    const registry = new CleanupRegistry()
    registry.add(async () => {
      await Promise.resolve()
      throw new Error('unlink failed')
    })

    // Only reachable if the rejection is awaited inside the try block.
    await expect(registry.cleanup()).rejects.toThrow(AggregateError)
  })
})

// ---------------------------------------------------------------------------
// base/prepared-cli-run.ts:11 — PreparedCliRun.cleanup
// (runtime await lock lives in prepared-cli-run-cleanup-await.test.ts)
// ---------------------------------------------------------------------------

describe('PreparedCliRun.cleanup — supplied-callback contract', () => {
  it('accepts an expression-bodied cleanup that returns a value', async () => {
    const removed: string[] = []

    // TYPE LOCK: rejected under `=> void | Promise<void>`.
    const prepared: PreparedCliRun = {
      args: ['--print'],
      env: {},
      cleanup: () => removed.push('/tmp/run-scratch'),
    }

    await prepared.cleanup?.()
    expect(removed).toEqual(['/tmp/run-scratch'])
  })

  it('still accepts the Promise-returning form the CLI adapters supply', async () => {
    const removed: string[] = []
    const projection = { cleanup: async (): Promise<void> => void removed.push('projection') }

    // qwen/goose/crush all write exactly this shape.
    const prepared: PreparedCliRun = {
      args: [],
      env: {},
      cleanup: () => projection.cleanup(),
    }

    await prepared.cleanup?.()
    expect(removed).toEqual(['projection'])
  })
})

// ---------------------------------------------------------------------------
// plugin/adapter-plugin.ts:64 — AdapterPluginInstance.eventHandlers
// ---------------------------------------------------------------------------

describe('AdapterPluginInstance.eventHandlers — supplied-callback contract', () => {
  it('accepts an expression-bodied handler that returns a value', () => {
    const seen: unknown[] = []

    // TYPE LOCK: rejected under `=> void | Promise<void>`.
    const handlers: AdapterPluginInstance['eventHandlers'] = {
      'agent:failed': (event) => seen.push(event),
    }

    handlers['agent:failed']?.({ type: 'agent:failed' })
    expect(seen).toEqual([{ type: 'agent:failed' }])
  })
})

// ---------------------------------------------------------------------------
// introspection/node-probe-runner.ts:61 — NodeProbeRunnerPorts.capture
// ---------------------------------------------------------------------------

const ARTIFACT_DIGEST = `sha256:${'a'.repeat(64)}`

function fakeIdentity(name: string, path: string): ResolvedProbeExecutable {
  return { name, path, realPath: path, artifactDigest: ARTIFACT_DIGEST }
}

/**
 * Drives the runner down the identity-mismatch path, which reaches
 * `captureResult` without spawning a process.
 *
 * The parameter is typed via `NodeProbeRunnerPorts['capture']` on purpose. An
 * independently written `(capture: ProbeCapture) => void` annotation here would
 * decouple this fixture from the port under test, and the lock below would keep
 * passing even if the port regressed to `=> void | Promise<void>`.
 */
function probeRunnerWithCapture(capture: NonNullable<NodeProbeRunnerPorts['capture']>) {
  return createNodeProbeRunnerForTesting({
    executables: [fakeIdentity('cli', '/trusted/cli')],
    managedHome: '/managed/probe-home',
    cwd: process.cwd(),
    ports: { realpath: async () => '/replaced/cli', capture },
  })
}

describe('NodeProbeRunnerPorts.capture — supplied-callback contract', () => {
  it('accepts an expression-bodied capture port that returns a value', async () => {
    const captures: ProbeCapture[] = []

    // TYPE LOCK: `push` returns number. Rejected under `=> void | Promise<void>`.
    const runner = probeRunnerWithCapture((capture) => captures.push(capture))

    await runner({ command: 'cli', args: ['--help'] })

    expect(captures).toHaveLength(1)
    expect(captures[0]).toMatchObject({
      command: 'cli',
      failure: 'executable-identity-mismatch',
    })
  })

  it('classifies a rejected async capture as capture-error', async () => {
    // RUNTIME LOCK: only reachable because captureResult awaits the port
    // inside its try block. Drop the await and the rejection escapes as an
    // unhandled rejection while the original failure is returned unchanged.
    const runner = probeRunnerWithCapture(async () => {
      await Promise.resolve()
      throw new Error('capture sink unavailable')
    })

    await expect(runner({ command: 'cli', args: ['--help'] })).resolves.toMatchObject({
      failure: 'capture-error',
      stderr: '[probe:capture-error]',
    })
  })

  it('awaits a slow async capture before resolving the probe result', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let captureFinished = false

    const runner = probeRunnerWithCapture(async () => {
      await gate
      captureFinished = true
    })

    let runnerResolved = false
    const pending = runner({ command: 'cli', args: ['--help'] }).then((result) => {
      runnerResolved = true
      return result
    })

    await flush()
    // RUNTIME LOCK: drop the await and the probe resolves here.
    expect(runnerResolved).toBe(false)
    expect(captureFinished).toBe(false)

    release()
    await pending
    expect(captureFinished).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// integration/run-agent-execution.ts:85 and :90 — onEvent
// ---------------------------------------------------------------------------

const capabilities: AdapterCapabilityProfile = {
  supportsResume: true,
  supportsFork: false,
  supportsToolCalls: true,
  emitsToolCalls: true,
  executesToolLoop: true,
  supportsStreaming: true,
  supportsCostUsage: true,
}

function createFakeAdapter(providerId: AdapterProviderId): AgentCLIAdapter {
  return {
    providerId,
    async *execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      yield {
        type: 'adapter:started',
        providerId,
        sessionId: `session-${providerId}`,
        timestamp: 100,
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      }
      yield {
        type: 'adapter:completed',
        providerId,
        sessionId: `session-${providerId}`,
        result: `result:${providerId}`,
        durationMs: 12,
        timestamp: 112,
      }
    },
    async *resumeSession(): AsyncGenerator<AgentEvent, void, undefined> {},
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
    getCapabilities() {
      return capabilities
    },
  }
}

const codexRequest: AgentExecutionRequest = {
  providerId: 'codex',
  backend: 'cli',
  authMode: 'subscription_cli',
  profileRef: 'codex-test-profile',
  prompt: 'Implement this',
}

function prepareFakeRunner() {
  return prepareAgentExecutionRunner(codexRequest, {
    materializeAdapter: () => createFakeAdapter('codex'),
  })
}

describe('RunPreparedAgentExecutionOptions.onEvent — supplied-callback contract', () => {
  it('accepts an expression-bodied listener that returns a value', async () => {
    const events: AgentEvent[] = []

    // TYPE LOCK: `push` returns number. Rejected under `=> void | Promise<void>`.
    const result = await runPreparedAgentExecution(codexRequest, prepareFakeRunner(), {
      onEvent: (event) => events.push(event),
    })

    expect(result.ok).toBe(true)
    // The expression-bodied listener saw exactly what the run recorded.
    expect(events).toEqual(result.events)
    expect(events.map((event) => event.type)).toContain('adapter:started')
    expect(events.at(-1)?.type).toBe('adapter:completed')
  })

  it('awaits an async listener before pulling the next adapter event', async () => {
    const seen: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let gateUsed = false

    let settled = false
    const pending = runPreparedAgentExecution(codexRequest, prepareFakeRunner(), {
      onEvent: async (event) => {
        seen.push(event.type)
        if (!gateUsed) {
          gateUsed = true
          await gate
        }
      },
    }).then((result) => {
      settled = true
      return result
    })

    await flush()
    // RUNTIME LOCK: drop the `await onEvent?.(event)` and the whole run
    // completes here, with every event already recorded.
    expect(seen).toHaveLength(1)
    expect(settled).toBe(false)

    release()
    const result = await pending
    expect(result.ok).toBe(true)
    // Blocking the first listener call held back every later event.
    expect(seen.length).toBeGreaterThan(1)
    expect(seen).toEqual(result.events.map((event) => event.type))
    expect(seen.at(-1)).toBe('adapter:completed')
  })
})
