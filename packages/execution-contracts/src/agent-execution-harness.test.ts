import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  computeAgentExecutionReadStamp,
  createAgentExecutionHarnessProfileV1,
  runAgentExecutionHarness,
  toModelHarnessToolVisibility,
  validateAgentExecutionHarnessProfileV1,
  type AgentExecutionHarnessChild,
  type AgentExecutionHarnessPorts,
  type AgentExecutionHarnessProfileV1,
} from './agent-execution-harness.js'

const roots: string[] = []

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

function fixture(): { root: string; profile: AgentExecutionHarnessProfileV1; events: Array<Record<string, unknown>>; ports: AgentExecutionHarnessPorts } {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-execution-harness-'))
  roots.push(root)
  writeFileSync(path.join(root, 'seed.txt'), 'seed\n')
  const events: Array<Record<string, unknown>> = []
  const profile = createAgentExecutionHarnessProfileV1({
    profileId: 'collision-control-fixture',
    taskId: 'task-a',
    attemptId: 'attempt-001',
    workRoot: root,
    visibleTools: ['fs.read', 'fs.write', 'process.spawn', 'agent.output', 'agent.progress', 'agent.compact'],
    allowedRelativePaths: ['seed.txt', 'src/**'],
    allowedCommandRefs: ['fixture-child'],
    limits: { maxDurationMs: 60_000, maxIterations: 20, maxOutputBytes: 1_024, maxChildProcesses: 2 },
    progress: { heartbeatIntervalMs: 1_000, maxSilenceMs: 10_000 },
  })
  const ports: AgentExecutionHarnessPorts = {
    readFile: (filePath) => readFileSync(filePath),
    writeFile: (filePath, content) => writeFileSync(filePath, content),
    spawnChild: async () => ({ id: 'child-1', terminate() {}, wait() {} }),
    emitEvidence: (event) => events.push(event),
    now: () => 1_000,
  }
  return { root, profile, events, ports }
}

describe('AgentExecutionHarnessProfileV1', () => {
  it('is sealed separately from the existing model HarnessProfile and projects tool visibility only', () => {
    const f = fixture()
    expect(validateAgentExecutionHarnessProfileV1(f.profile)).toEqual({ valid: true, errors: [] })
    expect(toModelHarnessToolVisibility(f.profile)).toEqual({ include: f.profile.visibleTools })
    expect(f.profile.schemaVersion).toBe('dzupagent.agentExecutionHarnessProfile/v1')
    expect(f.profile.mutationPolicy.refOperations).toBe('deny_all')
    expect(f.profile.retention).toEqual({
      retainRawPrompt: false,
      retainToolArguments: false,
      retainRawPaths: false,
      retainSecrets: false,
    })
    const forged = { ...f.profile, visibleTools: [...f.profile.visibleTools, 'git.update-ref'] }
    expect(validateAgentExecutionHarnessProfileV1(forged).valid).toBe(false)
  })

  it('permits an exact stamped in-root write and retains hashes rather than prompt, path, or content', async () => {
    const f = fixture()
    const stamp = computeAgentExecutionReadStamp(readFileSync(path.join(f.root, 'seed.txt')))
    const result = await runAgentExecutionHarness({
      profile: f.profile,
      rawPrompt: 'credential-like-fixture-must-not-be-retained',
      ports: f.ports,
      actions: [
        { kind: 'read', tool: 'fs.read', path: 'seed.txt' },
        { kind: 'write', tool: 'fs.write', path: 'seed.txt', content: 'updated\n', expectedReadStamp: stamp },
        { kind: 'progress', tool: 'agent.progress', phase: 'candidate-ready' },
        { kind: 'output', tool: 'agent.output', byteLength: 16 },
      ],
    })
    expect(result.status).toBe('completed')
    expect(result.activeChildProcesses).toBe(0)
    expect(result.childCleanupVerified).toBe(true)
    expect(result.rawPromptRetained).toBe(false)
    expect(result.rawToolArgumentsRetained).toBe(false)
    expect(readFileSync(path.join(f.root, 'seed.txt'), 'utf8')).toBe('updated\n')
    const retained = JSON.stringify({ result, events: f.events })
    expect(retained).not.toContain('seed.txt')
    expect(retained).not.toContain('updated')
    expect(retained).not.toContain('credential-like-fixture')
  })

  it.each([
    ['outside root', { kind: 'write', tool: 'fs.write', path: '../escape.txt', content: 'escape' } as const, 'HARNESS_PATH_OUTSIDE_ROOT'],
    ['forbidden ref', { kind: 'ref', tool: 'fs.write', operation: 'update-ref' } as const, 'HARNESS_REF_OPERATION_FORBIDDEN'],
    ['hidden tool', { kind: 'output', tool: 'not-visible', byteLength: 1 } as const, 'HARNESS_TOOL_HIDDEN'],
    ['unsealed command', { kind: 'spawn', tool: 'process.spawn', commandRef: 'not-admitted' } as const, 'HARNESS_COMMAND_REF_FORBIDDEN'],
  ])('rejects hostile %s operations', async (_label, action, reason) => {
    const f = fixture()
    const result = await runAgentExecutionHarness({ profile: f.profile, ports: f.ports, actions: [action] })
    expect(result.status).toBe('rejected')
    expect(result.reasonCodes).toEqual([reason])
  })

  it('rejects symlink traversal and stale/read-stamp reuse after compaction', async () => {
    const f = fixture()
    const outside = mkdtempSync(path.join(tmpdir(), 'agent-execution-outside-'))
    roots.push(outside)
    writeFileSync(path.join(outside, 'outside.txt'), 'outside')
    symlinkSync(outside, path.join(f.root, 'link'))
    const symlinked = await runAgentExecutionHarness({
      profile: f.profile,
      ports: f.ports,
      actions: [{ kind: 'read', tool: 'fs.read', path: 'link/outside.txt' }],
    })
    expect(symlinked.reasonCodes).toEqual(['HARNESS_SYMLINK_REJECTED'])

    const stamp = computeAgentExecutionReadStamp(readFileSync(path.join(f.root, 'seed.txt')))
    const compacted = await runAgentExecutionHarness({
      profile: f.profile,
      ports: f.ports,
      actions: [
        { kind: 'read', tool: 'fs.read', path: 'seed.txt' },
        { kind: 'compact', tool: 'agent.compact' },
        { kind: 'write', tool: 'fs.write', path: 'seed.txt', content: 'changed', expectedReadStamp: stamp },
      ],
    })
    expect(compacted.reasonCodes).toEqual(['HARNESS_READ_STAMP_REQUIRED'])
    expect(readFileSync(path.join(f.root, 'seed.txt'), 'utf8')).toBe('seed\n')
  })

  // PCC_FAULT_PROOF:agent_execution_validation:before
  it('terminates and waits for every child when cancellation arrives', async () => {
    const f = fixture()
    const controller = new AbortController()
    const lifecycle: string[] = []
    const ports: AgentExecutionHarnessPorts = {
      ...f.ports,
      spawnChild: async () => {
        controller.abort('fixture cancellation')
        return {
          id: 'child-cancelled',
          terminate: () => { lifecycle.push('terminate') },
          wait: () => { lifecycle.push('wait') },
        }
      },
    }
    const result = await runAgentExecutionHarness({
      profile: f.profile,
      ports,
      signal: controller.signal,
      actions: [
        { kind: 'spawn', tool: 'process.spawn', commandRef: 'fixture-child' },
        { kind: 'output', tool: 'agent.output', byteLength: 1 },
      ],
    })
    expect(result.status).toBe('cancelled')
    expect(result.reasonCodes).toEqual(['HARNESS_CANCELLED'])
    expect(result.activeChildProcesses).toBe(0)
    expect(lifecycle).toEqual(['terminate', 'wait'])
  })

  // PCC_FAULT_PROOF:agent_execution_validation:after
  it('attempts both terminate and wait and reports failed cleanup without claiming success', async () => {
    const f = fixture()
    const lifecycle: string[] = []
    const result = await runAgentExecutionHarness({
      profile: f.profile,
      ports: {
        ...f.ports,
        spawnChild: async () => ({
          id: 'child-cleanup-failure',
          terminate: () => { lifecycle.push('terminate'); throw new Error('terminate failed') },
          wait: () => { lifecycle.push('wait') },
        }),
      },
      actions: [{ kind: 'spawn', tool: 'process.spawn', commandRef: 'fixture-child' }],
    })
    expect(result.status).toBe('failed')
    expect(result.reasonCodes).toEqual(['HARNESS_CHILD_CLEANUP_FAILED'])
    expect(result.childCleanupVerified).toBe(false)
    expect(result.activeChildProcesses).toBe(1)
    expect(lifecycle).toEqual(['terminate', 'wait'])
  })

  it('rejects duplicate child identities, cleans the duplicate, and retains the original for final cleanup', async () => {
    const f = fixture()
    const lifecycle: string[] = []
    const result = await runAgentExecutionHarness({
      profile: f.profile,
      ports: {
        ...f.ports,
        spawnChild: async () => ({
          id: 'duplicate-child',
          terminate: () => { lifecycle.push('terminate') },
          wait: () => { lifecycle.push('wait') },
        }),
      },
      actions: [
        { kind: 'spawn', tool: 'process.spawn', commandRef: 'fixture-child' },
        { kind: 'spawn', tool: 'process.spawn', commandRef: 'fixture-child' },
      ],
    })
    expect(result.status).toBe('rejected')
    expect(result.reasonCodes).toEqual(['HARNESS_PORT_FAILED'])
    expect(result.childCleanupVerified).toBe(true)
    expect(result.activeChildProcesses).toBe(0)
    expect(lifecycle).toEqual(['terminate', 'wait', 'terminate', 'wait'])
  })

  it('rejects a write port that does not materialize the exact requested bytes', async () => {
    const f = fixture()
    const stamp = computeAgentExecutionReadStamp(readFileSync(path.join(f.root, 'seed.txt')))
    const result = await runAgentExecutionHarness({
      profile: f.profile,
      ports: { ...f.ports, writeFile: () => {} },
      actions: [
        { kind: 'read', tool: 'fs.read', path: 'seed.txt' },
        { kind: 'write', tool: 'fs.write', path: 'seed.txt', content: 'not-materialized', expectedReadStamp: stamp },
      ],
    })
    expect(result.status).toBe('rejected')
    expect(result.reasonCodes).toEqual(['HARNESS_PORT_FAILED'])
    expect(readFileSync(path.join(f.root, 'seed.txt'), 'utf8')).toBe('seed\n')
  })

  it('rejects semantically duplicated profiles with non-canonical tool or command ordering', () => {
    const f = fixture()
    const tools = { ...f.profile, visibleTools: [...f.profile.visibleTools].reverse() }
    expect(validateAgentExecutionHarnessProfileV1(tools).valid).toBe(false)
    const commands = {
      ...f.profile,
      mutationPolicy: { ...f.profile.mutationPolicy, allowedCommandRefs: ['z-command', 'a-command'] },
    }
    expect(validateAgentExecutionHarnessProfileV1(commands).valid).toBe(false)
  })

  it('enforces output, iteration, duration, and progress-silence bounds', async () => {
    const f = fixture()
    const output = await runAgentExecutionHarness({
      profile: f.profile,
      ports: f.ports,
      actions: [{ kind: 'output', tool: 'agent.output', byteLength: 1_025 }],
    })
    expect(output.reasonCodes).toEqual(['HARNESS_OUTPUT_LIMIT'])

    let clock = 0
    const stalled = await runAgentExecutionHarness({
      profile: f.profile,
      ports: { ...f.ports, now: () => { clock += 11_000; return clock } },
      actions: [{ kind: 'output', tool: 'agent.output', byteLength: 1 }],
    })
    expect(stalled.reasonCodes[0]).toMatch(/HARNESS_(DURATION_EXCEEDED|PROGRESS_STALLED)/)
  })
})

/**
 * These pin the `=> void` return declarations on `AgentExecutionHarnessChild`
 * and `AgentExecutionHarnessPorts.writeFile`.
 *
 * The first test is a TYPE-level lock: every port below uses an
 * expression-bodied arrow returning a value, which was TS2322 under the former
 * `=> void | Promise<void>`. This file is inside `tsconfig.json`'s `include`,
 * so `yarn workspace @dzupagent/execution-contracts typecheck` enforces it.
 *
 * The rest are RUNTIME locks. Narrowing to `void` removes any type-level hint
 * that these results are awaited — though the union did not provide one either,
 * since deleting `await` from `child.wait()` type-checks under both. So the
 * awaits in `cleanupChild` and at the write site are pinned by observable
 * behaviour instead: an async rejection must be caught, terminate must settle
 * before wait is called, and an async write must land before the read-back.
 */
describe('AgentExecutionHarness port return types', () => {
  it('accepts expression-bodied recorder ports through the public surface', async () => {
    const f = fixture()
    const lifecycle: string[] = []
    const writes: Array<[string, string | Uint8Array]> = []
    const stamp = computeAgentExecutionReadStamp(readFileSync(path.join(f.root, 'seed.txt')))
    // Returns `number`, so the arrow below has a value-typed expression body.
    const recordWrite = (filePath: string, content: string | Uint8Array): number => {
      writeFileSync(filePath, content)
      return writes.push([filePath, content])
    }

    const result = await runAgentExecutionHarness({
      profile: f.profile,
      ports: {
        ...f.ports,
        // Expression bodies on purpose: `Array.prototype.push` returns `number`.
        writeFile: (filePath, content) => recordWrite(filePath, content),
        spawnChild: () => ({
          id: 'child-expression-bodied',
          terminate: () => lifecycle.push('terminate'),
          wait: () => lifecycle.push('wait'),
        }),
      },
      actions: [
        { kind: 'spawn', tool: 'process.spawn', commandRef: 'fixture-child' },
        { kind: 'read', tool: 'fs.read', path: 'seed.txt' },
        { kind: 'write', tool: 'fs.write', path: 'seed.txt', content: 'recorded', expectedReadStamp: stamp },
      ],
    })

    expect(result.status).toBe('completed')
    expect(result.childCleanupVerified).toBe(true)
    // Assert the fixtures actually fired, so the type lock is not vacuous.
    expect(lifecycle).toEqual(['terminate', 'wait'])
    expect(writes).toEqual([[path.join(f.root, 'seed.txt'), 'recorded']])
  })

  it('accepts the canonical Node child shape, which the former union rejected', async () => {
    // `ChildProcess.kill()` returns boolean and `events.once()` returns
    // Promise<unknown[]>. Neither is assignable to `void | Promise<void>`, so
    // the union rejected the most natural real implementation of this port.
    const proc = { kill: (): boolean => true, exited: Promise.resolve<unknown[]>(['exit', 0]) }
    const nodeShaped: AgentExecutionHarnessChild = {
      id: 'child-node-shaped',
      terminate: () => proc.kill(),
      wait: () => proc.exited,
    }

    const f = fixture()
    const result = await runAgentExecutionHarness({
      profile: f.profile,
      ports: { ...f.ports, spawnChild: () => nodeShaped },
      actions: [{ kind: 'spawn', tool: 'process.spawn', commandRef: 'fixture-child' }],
    })

    expect(result.status).toBe('completed')
    expect(result.childCleanupVerified).toBe(true)
    expect(await proc.exited).toEqual(['exit', 0])
  })

  it('awaits an asynchronously rejecting wait() rather than claiming cleanup succeeded', async () => {
    // The pre-existing cleanup-failure test throws SYNCHRONOUSLY, which is
    // caught with or without the await. This rejects on a later turn, so it
    // fails if the await in `cleanupChild` is dropped.
    const f = fixture()
    const lifecycle: string[] = []
    const result = await runAgentExecutionHarness({
      profile: f.profile,
      ports: {
        ...f.ports,
        spawnChild: async () => ({
          id: 'child-async-reject',
          terminate: () => { lifecycle.push('terminate') },
          wait: () => new Promise<void>((_resolve, reject) => {
            lifecycle.push('wait')
            setTimeout(() => reject(new Error('async wait failure')), 0)
          }),
        }),
      },
      actions: [{ kind: 'spawn', tool: 'process.spawn', commandRef: 'fixture-child' }],
    })

    expect(lifecycle).toEqual(['terminate', 'wait'])
    expect(result.childCleanupVerified).toBe(false)
    expect(result.status).toBe('failed')
    expect(result.reasonCodes).toEqual(['HARNESS_CHILD_CLEANUP_FAILED'])
    expect(result.activeChildProcesses).toBe(1)
  })

  it('settles terminate() before it calls wait()', async () => {
    const f = fixture()
    const lifecycle: string[] = []
    const result = await runAgentExecutionHarness({
      profile: f.profile,
      ports: {
        ...f.ports,
        spawnChild: async () => ({
          id: 'child-ordered-cleanup',
          terminate: () => new Promise<void>((resolve) => {
            lifecycle.push('terminate:called')
            setTimeout(() => { lifecycle.push('terminate:settled'); resolve() }, 0)
          }),
          wait: () => { lifecycle.push('wait:called') },
        }),
      },
      actions: [{ kind: 'spawn', tool: 'process.spawn', commandRef: 'fixture-child' }],
    })

    expect(result.childCleanupVerified).toBe(true)
    // Dropping the terminate await reorders this to
    // ['terminate:called', 'wait:called', 'terminate:settled'].
    expect(lifecycle).toEqual(['terminate:called', 'terminate:settled', 'wait:called'])
  })

  it('settles an asynchronous writeFile before it verifies the written bytes', async () => {
    const f = fixture()
    const target = path.join(f.root, 'seed.txt')
    const stamp = computeAgentExecutionReadStamp(readFileSync(target))
    const result = await runAgentExecutionHarness({
      profile: f.profile,
      ports: {
        ...f.ports,
        writeFile: (filePath, content) => new Promise<void>((resolve) => {
          setTimeout(() => { writeFileSync(filePath, content); resolve() }, 0)
        }),
      },
      actions: [
        { kind: 'read', tool: 'fs.read', path: 'seed.txt' },
        { kind: 'write', tool: 'fs.write', path: 'seed.txt', content: 'async-written', expectedReadStamp: stamp },
      ],
    })

    // Without the await the read-back sees the stale bytes and the harness
    // rejects the action with HARNESS_PORT_FAILED.
    expect(result.status).toBe('completed')
    expect(readFileSync(target, 'utf8')).toBe('async-written')
  })
})
