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
