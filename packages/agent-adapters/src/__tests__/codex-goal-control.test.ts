import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import {
  PROVIDER_SESSION_ATTEMPT_BINDING_SCHEMA,
  PROVIDER_SESSION_CAPABILITIES,
  PROVIDER_SESSION_CAPABILITY_DESCRIPTOR_SCHEMA,
  PROVIDER_SESSION_EFFECTS,
  PROVIDER_SESSION_OPERATION_SCHEMA,
  PROVIDER_SESSION_REFERENCE_SCHEMA,
  type ProviderSessionAttemptBinding,
} from '@dzupagent/runtime-contracts/provider-session'
import { describe, expect, it, vi } from 'vitest'

import { createCodexGoalControlAdapter } from '../codex/codex-goal-control.js'

interface RpcCall {
  method: string
  params: Record<string, unknown>
}

const ARTIFACT_DIGEST = `sha256:${'b'.repeat(64)}`

const EXECUTABLE = {
  name: 'codex',
  path: '/fixture/codex',
  realPath: '/fixture/codex',
  artifactDigest: ARTIFACT_DIGEST,
} as const

function appServerDependencies(
  spawn: () => ChildProcess,
  digestArtifact: (path: string) => Promise<string> = async () => ARTIFACT_DIGEST,
) {
  return {
    spawn,
    realpath: async (path: string) => path,
    stat: async () => ({ isFile: () => true }),
    access: async () => undefined,
    digestArtifact,
  }
}

function binding(nativeGoalControl = true): ProviderSessionAttemptBinding {
  return {
    schema: PROVIDER_SESSION_ATTEMPT_BINDING_SCHEMA,
    bindingId: 'binding-goal-control',
    executionAttemptId: 'attempt-goal-control',
    authSourceRef: 'auth-source://test/codex',
    descriptor: {
      schema: PROVIDER_SESSION_CAPABILITY_DESCRIPTOR_SCHEMA,
      descriptorId: 'descriptor-goal-control',
      providerId: 'codex',
      backend: {
        id: 'codex-app-server',
        kind: 'app-server',
        version: '0.147.0',
        protocolSchemaRef: 'codex-app-server://generated-json-schema/0.147.0',
        protocolSchemaDigest: `sha256:${'a'.repeat(64)}`,
        artifactDigest: ARTIFACT_DIGEST,
      },
      capabilities: Object.fromEntries(PROVIDER_SESSION_CAPABILITIES.map((capability) => [
        capability,
        capability === 'goal-control' && nativeGoalControl
          ? { status: 'native', emulation: 'forbidden' }
          : {
              status: 'unsupported',
              emulation: 'forbidden',
              reason: 'Not exposed by this focused fixture.',
            },
      ])) as ProviderSessionAttemptBinding['descriptor']['capabilities'],
      observedAt: '2026-08-13T00:00:00.000Z',
    },
    effectAuthorities: Object.fromEntries(PROVIDER_SESSION_EFFECTS.map((effect) => [
      effect,
      {
        effect,
        retryAuthorityId: 'io/provider-effect-retry',
        fallbackAuthorityId: 'io/provider-route-fallback',
        maxRetries: 0,
        fallback: 'none',
      },
    ])) as ProviderSessionAttemptBinding['effectAuthorities'],
    boundAt: '2026-08-13T00:00:00.000Z',
  }
}

function requestBase<K extends 'goal-get' | 'goal-set' | 'goal-clear'>(kind: K) {
  return {
    schema: PROVIDER_SESSION_OPERATION_SCHEMA,
    operationId: `operation-${kind}`,
    attemptBindingId: 'binding-goal-control',
    kind,
    thread: {
      schema: PROVIDER_SESSION_REFERENCE_SCHEMA,
      kind: 'thread',
      opaqueId: 'thread-1',
    },
  } as const
}

function createAppServer(
  calls: RpcCall[],
  respond: (call: RpcCall) => unknown,
): ChildProcess {
  const child = new EventEmitter() as ChildProcess
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    kill: vi.fn(() => {
      queueMicrotask(() => child.emit('exit', 0, null))
      return true
    }),
  })
  let buffer = ''
  stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    for (;;) {
      const boundary = buffer.indexOf('\n')
      if (boundary < 0) break
      const message = JSON.parse(buffer.slice(0, boundary)) as {
        id?: number
        method?: string
        params?: Record<string, unknown>
      }
      buffer = buffer.slice(boundary + 1)
      if (message.method === 'initialize' && message.id !== undefined) {
        stdout.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            codexHome: '/fixture/codex-home',
            platformFamily: 'unix',
            platformOs: 'linux',
            userAgent: 'codex_cli_rs/0.147.0',
          },
        })}\n`)
      } else if (message.id !== undefined && message.method) {
        const call = { method: message.method, params: message.params ?? {} }
        calls.push(call)
        stdout.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: respond(call),
        })}\n`)
      }
    }
  })
  return child
}

function goal(objective = 'Implement the admitted plan') {
  return {
    threadId: 'thread-1',
    objective,
    status: 'usageLimited',
    tokenBudget: 50_000,
    tokensUsed: 1_200,
    timeUsedSeconds: 12.5,
    createdAt: 1,
    updatedAt: 2,
  }
}

describe('Codex App Server goal control', () => {
  it('rejects non-Codex, non-App-Server, and unqualified protocol bindings before RPC', () => {
    const spawn = vi.fn(() => createAppServer([], () => ({})))
    const accepted = binding()
    const backend = accepted.descriptor.backend
    const cases: readonly ProviderSessionAttemptBinding[] = [
      {
        ...accepted,
        descriptor: { ...accepted.descriptor, providerId: 'not-codex' },
      },
      {
        ...accepted,
        descriptor: {
          ...accepted.descriptor,
          backend: { ...backend, id: 'codex-sdk', kind: 'sdk' },
        },
      },
      {
        ...accepted,
        descriptor: {
          ...accepted.descriptor,
          backend: {
            id: backend.id,
            kind: backend.kind,
            protocolSchemaRef: backend.protocolSchemaRef,
            protocolSchemaDigest: backend.protocolSchemaDigest,
          },
        },
      },
      {
        ...accepted,
        descriptor: {
          ...accepted.descriptor,
          backend: {
            id: backend.id,
            kind: backend.kind,
            version: backend.version,
            protocolSchemaDigest: backend.protocolSchemaDigest,
          },
        },
      },
      {
        ...accepted,
        descriptor: {
          ...accepted.descriptor,
          backend: {
            id: backend.id,
            kind: backend.kind,
            version: backend.version,
            protocolSchemaRef: backend.protocolSchemaRef,
          },
        },
      },
      {
        ...accepted,
        descriptor: {
          ...accepted.descriptor,
          backend: { ...backend, version: 'x'.repeat(129) },
        },
      },
      {
        ...accepted,
        descriptor: {
          ...accepted.descriptor,
          backend: { ...backend, protocolSchemaRef: ' ' },
        },
      },
      {
        ...accepted,
        descriptor: {
          ...accepted.descriptor,
          backend: { ...backend, protocolSchemaDigest: 'sha256:not-a-digest' },
        },
      },
    ]

    for (const attemptBinding of cases) {
      expect(() => createCodexGoalControlAdapter({
        attemptBinding,
        executable: EXECUTABLE,
        dependencies: appServerDependencies(spawn),
      })).toThrow(/admitted exact goal-control binding/u)
    }
    expect(spawn).not.toHaveBeenCalled()
  })

  it('rejects a descriptor/executable artifact mismatch before constructing control', () => {
    const spawn = vi.fn(() => createAppServer([], () => ({})))

    expect(() => createCodexGoalControlAdapter({
      attemptBinding: binding(),
      executable: {
        ...EXECUTABLE,
        artifactDigest: `sha256:${'c'.repeat(64)}`,
      },
      dependencies: appServerDependencies(spawn),
    })).toThrow(/resolved qualified executable identity/u)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('rejects changed artifact bytes before a goal-control process spawn', async () => {
    const spawn = vi.fn(() => createAppServer([], () => ({})))
    const adapter = createCodexGoalControlAdapter({
      attemptBinding: binding(),
      executable: EXECUTABLE,
      dependencies: appServerDependencies(
        spawn,
        async () => `sha256:${'c'.repeat(64)}`,
      ),
    })

    await expect(adapter.getGoal(requestBase('goal-get'))).rejects.toMatchObject({
      code: 'CODEX_APP_SERVER_EXECUTABLE_INVALID',
    })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('reads a sanitized durable-goal projection without exposing its objective', async () => {
    const calls: RpcCall[] = []
    const adapter = createCodexGoalControlAdapter({
      attemptBinding: binding(),
      executable: EXECUTABLE,
      dependencies: appServerDependencies(
        () => createAppServer(calls, () => ({ goal: goal('private objective') })),
      ),
    })

    const result = await adapter.getGoal(requestBase('goal-get'))

    expect(calls).toEqual([{
      method: 'thread/goal/get',
      params: { threadId: 'thread-1' },
    }])
    expect(result).toEqual({
      kind: 'goal-get',
      goal: {
        thread: requestBase('goal-get').thread,
        objectiveDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        status: 'usage-limited',
        tokenBudget: 50_000,
        tokensUsed: 1_200,
        timeUsedSeconds: 12.5,
      },
    })
    expect(JSON.stringify(result)).not.toContain('private objective')
  })

  it('maps provider-neutral status and finite budget updates to goal/set', async () => {
    const calls: RpcCall[] = []
    const adapter = createCodexGoalControlAdapter({
      attemptBinding: binding(),
      executable: EXECUTABLE,
      dependencies: appServerDependencies(
        () => createAppServer(calls, () => ({
          goal: { ...goal(), status: 'budgetLimited', tokenBudget: null },
        })),
      ),
    })

    const result = await adapter.setGoal({
      ...requestBase('goal-set'),
      objective: 'Implement the admitted plan',
      status: 'budget-limited',
      tokenBudget: null,
    })

    expect(calls).toEqual([{
      method: 'thread/goal/set',
      params: {
        threadId: 'thread-1',
        objective: 'Implement the admitted plan',
        status: 'budgetLimited',
        tokenBudget: null,
      },
    }])
    expect(result.goal.status).toBe('budget-limited')
    expect(result.goal.tokenBudget).toBeNull()
    expect(result.goal).not.toHaveProperty('objective')
  })

  it('clears a goal without treating provider completion as IO completion', async () => {
    const calls: RpcCall[] = []
    const adapter = createCodexGoalControlAdapter({
      attemptBinding: binding(),
      executable: EXECUTABLE,
      dependencies: appServerDependencies(
        () => createAppServer(calls, () => ({ cleared: true })),
      ),
    })

    await expect(adapter.clearGoal(requestBase('goal-clear'))).resolves.toEqual({
      kind: 'goal-clear',
      cleared: true,
    })
    expect(calls[0]?.method).toBe('thread/goal/clear')
  })

  it('rejects unsupported bindings and malformed goal mutations before RPC', async () => {
    expect(() => createCodexGoalControlAdapter({
      attemptBinding: binding(false),
      executable: EXECUTABLE,
    })).toThrow(/admitted exact goal-control binding/u)

    expect(() => createCodexGoalControlAdapter({
      attemptBinding: binding(),
    } as never)).toThrow(/resolved qualified executable identity/u)
    expect(() => createCodexGoalControlAdapter({
      attemptBinding: binding(),
      executable: { ...EXECUTABLE, path: 'codex', realPath: 'codex' },
    })).toThrow(/resolved qualified executable identity/u)

    const spawn = vi.fn(() => createAppServer([], () => ({})))
    const adapter = createCodexGoalControlAdapter({
      attemptBinding: binding(),
      executable: EXECUTABLE,
      dependencies: appServerDependencies(spawn),
    })
    await expect(adapter.setGoal({
      ...requestBase('goal-set'),
      objective: 'x'.repeat(4_001),
    })).rejects.toThrow(/1 to 4000 characters/u)
    expect(spawn).not.toHaveBeenCalled()
  })
})
