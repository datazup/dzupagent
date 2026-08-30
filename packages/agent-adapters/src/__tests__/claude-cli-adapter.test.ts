import { access, readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { ForgeError } from '@dzupagent/core/events'
import { ClaudeCliAdapter } from '../claude/claude-cli-adapter.js'
import { createClaudeBackendAdapter } from '../claude/claude-backend.js'
import { ClaudeAgentAdapter } from '../claude/claude-adapter.js'
import { spawnAndStreamJsonl } from '../utils/process-helpers.js'
import type { PreparedCliRun } from '../base/base-cli-adapter.js'
import type { ThreadStartResult } from '../base/stream-runner.js'
import type {
  AdapterExecutionControlAdmission,
  AdapterExecutionControlRequirement,
  AgentEvent,
  AgentInput,
  AgentStreamEvent,
} from '../types.js'

vi.mock('../utils/process-helpers.js', () => ({
  isBinaryAvailable: vi.fn(),
  spawnAndStreamJsonl: vi.fn(),
}))

const mockSpawnAndStreamJsonl = vi.mocked(spawnAndStreamJsonl)

class InspectableClaudeCliAdapter extends ClaudeCliAdapter {
  environmentPreparations = 0
  args(input: AgentInput): string[] { return this.buildArgs(input) }
  prepare(input: AgentInput): Promise<PreparedCliRun> { return this.prepareCliRun(input) }
  map(record: Record<string, unknown>, sessionId = 'fallback'): AgentEvent | AgentEvent[] | undefined { return this.mapProviderEvent(record, sessionId) }
  startsImmediately(): boolean { return this.shouldEmitStartedImmediately() }
  threadStart(record: Record<string, unknown>): ThreadStartResult | null { return this.detectProviderThreadStart(record) }
  protected override async prepareCliRun(input: AgentInput): Promise<PreparedCliRun> {
    this.environmentPreparations += 1
    return super.prepareCliRun(input)
  }
}

const ZERO_TOOL_REQUIREMENT: AdapterExecutionControlRequirement = {
  schema: 'dzupagent/adapter-execution-control-requirement/v1',
  tools: { mode: 'none' },
}

const ZERO_TOOL_REJECTION: AdapterExecutionControlAdmission = {
  schema: 'dzupagent/adapter-execution-control-admission/v1',
  status: 'rejected',
  providerId: 'claude',
  requirementSha256: 'sha256:e367236e0d9802cbfd0f42190c9173d577c12ad4cbdd8b258721900eb78e5731',
  tools: { mode: 'none', enforcement: 'unsupported' },
  blockers: ['zero_tool_dispatch_unsupported'],
  effects: {
    credentialReads: 0,
    networkAttempts: 0,
    providerDispatches: 0,
    providerSpendUsd: 0,
  },
}

const ZERO_TOOL_DIRECT_DENIAL: AdapterExecutionControlAdmission = {
  ...ZERO_TOOL_REJECTION,
  blockers: ['zero_tool_dispatch_capability_missing'],
}

function zeroToolInput(): AgentInput {
  return {
    prompt: 'bounded Claude CLI prompt',
    executionControlRequirement: ZERO_TOOL_REQUIREMENT,
    policyContext: {
      activePolicy: {
        toolPolicy: 'strict',
        allowedTools: [],
        blockedTools: [],
      },
      conformanceMode: 'strict',
    },
  }
}

interface CliEffectSnapshot {
  readonly clockReads: number
  readonly environmentPreparations: number
  readonly events: number
  readonly spawns: number
}

const ZERO_CLI_EFFECTS: CliEffectSnapshot = {
  clockReads: 0,
  environmentPreparations: 0,
  events: 0,
  spawns: 0,
}

async function observeCliRun(
  run: (
    adapter: InspectableClaudeCliAdapter,
  ) => AsyncGenerator<AgentEvent | AgentStreamEvent, void, undefined>,
): Promise<{
    readonly adapter: InspectableClaudeCliAdapter
    readonly effects: CliEffectSnapshot
    readonly failure: unknown
  }> {
  mockSpawnAndStreamJsonl.mockClear()
  mockSpawnAndStreamJsonl.mockImplementation(async function* () {
    yield { type: 'system', subtype: 'init', session_id: 'unexpected-session' }
    yield {
      type: 'result',
      subtype: 'success',
      session_id: 'unexpected-session',
      result: 'unexpected dispatch',
    }
  })
  const adapter = new InspectableClaudeCliAdapter()
  const dateNow = vi.spyOn(Date, 'now').mockReturnValue(1_000)
  const events: Array<AgentEvent | AgentStreamEvent> = []
  let failure: unknown
  try {
    for await (const event of run(adapter)) events.push(event)
  } catch (error) {
    failure = error
  }
  const effects = {
    clockReads: dateNow.mock.calls.length,
    environmentPreparations: adapter.environmentPreparations,
    events: events.length,
    spawns: mockSpawnAndStreamJsonl.mock.calls.length,
  }
  dateNow.mockRestore()
  return { adapter, effects, failure }
}

describe('Claude local CLI backend', () => {
  it('materializes exactly one explicitly selected backend', () => {
    const cli = createClaudeBackendAdapter({ backend: 'cli' })
    const sdk = createClaudeBackendAdapter({ backend: 'sdk' })
    expect(cli).toBeInstanceOf(ClaudeCliAdapter)
    expect(sdk).toBeInstanceOf(ClaudeAgentAdapter)
    expect(cli.getCapabilities().supportsZeroToolDispatch).toBe(false)
    expect(sdk.getCapabilities().supportsZeroToolDispatch).toBe(true)
  })

  it('returns stable unsupported zero-tool evidence from the selected CLI instance', () => {
    const adapter = new ClaudeCliAdapter()

    expect(adapter.getCapabilities().supportsZeroToolDispatch).toBe(false)
    expect(adapter.admitExecutionControls?.(zeroToolInput(), ZERO_TOOL_REQUIREMENT))
      .toEqual(ZERO_TOOL_REJECTION)
    expect(adapter.admitExecutionControls?.(zeroToolInput(), ZERO_TOOL_REQUIREMENT))
      .toEqual(ZERO_TOOL_REJECTION)
  })

  it.each([
    ['execute', (adapter: InspectableClaudeCliAdapter) => adapter.execute(zeroToolInput())],
    ['executeWithRaw', (adapter: InspectableClaudeCliAdapter) => adapter.executeWithRaw(zeroToolInput())],
    ['resumeSession', (adapter: InspectableClaudeCliAdapter) => adapter.resumeSession('resume-zero-tool', zeroToolInput())],
  ] as const)(
    'rejects direct %s before clocks, environment preparation, events, or spawn',
    async (_entrypoint, run) => {
      const { effects, failure } = await observeCliRun(run)

      expect(effects).toEqual(ZERO_CLI_EFFECTS)
      expect(failure).toBeInstanceOf(ForgeError)
      expect(failure).toMatchObject({
        code: 'CAPABILITY_DENIED',
        recoverable: false,
        context: { admission: ZERO_TOOL_DIRECT_DENIAL },
      })
    },
  )

  it('rejects accessor-backed resume requirements before spread or CLI effects', async () => {
    const input = zeroToolInput()
    let getterReads = 0
    Object.defineProperty(input, 'executionControlRequirement', {
      configurable: true,
      enumerable: true,
      get() {
        getterReads += 1
        throw new Error('execution-control getter must remain unread')
      },
    })

    const { effects, failure } = await observeCliRun((adapter) =>
      adapter.resumeSession('resume-accessor', input))

    expect(getterReads).toBe(0)
    expect(effects).toEqual(ZERO_CLI_EFFECTS)
    expect(failure).toBeInstanceOf(ForgeError)
    expect(failure).toMatchObject({
      code: 'CAPABILITY_DENIED',
      recoverable: false,
      context: {
        admission: {
          ...ZERO_TOOL_REJECTION,
          blockers: ['execution_control_requirement_invalid'],
        },
      },
    })
  })
  it('uses the verified read-only denylist and stream-json output', () => {
    const args = new InspectableClaudeCliAdapter().args({ prompt: 'inspect', workingDirectory: '/tmp' })
    expect(args).toEqual(expect.arrayContaining(['--print', '--output-format', 'stream-json', '--disallowedTools', 'Write', 'Edit', 'Bash', 'NotebookEdit']))
    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(args.slice(-2)).toEqual(['--', 'inspect'])
  })

  it('auto-approves only explicitly projected read-only tools', () => {
    const args = new InspectableClaudeCliAdapter().args({
      prompt: 'inspect',
      policyContext: {
        conformanceMode: 'warn-only',
        activePolicy: {
          sandboxMode: 'read-only',
          allowedTools: ['mcp__execution_gateway__*'],
        },
      },
    })
    expect(args).toEqual(expect.arrayContaining([
      '--allowedTools',
      'mcp__execution_gateway__*',
      '--disallowedTools',
      'Write',
      'Edit',
      'Bash',
      'NotebookEdit',
    ]))
  })

  it('rejects strict workspace-write allowlist projection', () => {
    expect(() => new InspectableClaudeCliAdapter().args({
      prompt: 'edit',
      policyContext: { conformanceMode: 'strict', activePolicy: { sandboxMode: 'workspace-write', allowedTools: ['Edit'] } },
    })).toThrow('does not enforce a strict allowlist')
  })

  it('enforces the complement blocklist for warn-only workspace-write projection', () => {
    const args = new InspectableClaudeCliAdapter().args({
      prompt: 'edit',
      policyContext: {
        conformanceMode: 'warn-only',
        activePolicy: {
          sandboxMode: 'workspace-write',
          allowedTools: ['Edit', 'Read'],
          blockedTools: ['Bash', 'WebFetch', 'WebSearch'],
        },
      },
    })
    expect(args).toEqual(expect.arrayContaining([
      '--allowedTools',
      'Edit',
      'Read',
      '--disallowedTools',
      'Bash',
      'WebFetch',
      'WebSearch',
    ]))
  })

  it('rejects unsupported max-turn projection instead of ignoring it', () => {
    expect(() => new InspectableClaudeCliAdapter().args({ prompt: 'bounded', maxTurns: 2 })).toThrow('max-turns')
  })

  it('projects the execution-request model without mutating shared adapter state', () => {
    const adapter = new InspectableClaudeCliAdapter({ model: 'configured-model' })
    expect(adapter.args({ prompt: 'configured' })).toEqual(expect.arrayContaining(['--model', 'configured-model']))
    expect(adapter.args({ prompt: 'selected', options: { model: 'request-model' } }))
      .toEqual(expect.arrayContaining(['--model', 'request-model']))
    expect(adapter.args({ prompt: 'configured-again' }))
      .toEqual(expect.arrayContaining(['--model', 'configured-model']))
  })

  it('projects MCP references into distinct private files and cleans each run', async () => {
    const adapter = new InspectableClaudeCliAdapter()
    const input: AgentInput = {
      prompt: 'use tools',
      options: {
        mcpServers: [{ id: 'local', transport: { kind: 'stdio', command: 'node', args: ['server.js'], envRefs: { AUTH: 'local-auth' } }, disabledTools: ['delete'] }],
        mcpReferenceValues: { 'local-auth': 'secret-value' },
      },
    }
    const [first, second] = await Promise.all([adapter.prepare(input), adapter.prepare(input)])
    const firstPath = first.args[first.args.indexOf('--mcp-config') + 1]!
    const secondPath = second.args[second.args.indexOf('--mcp-config') + 1]!
    expect(firstPath).not.toBe(secondPath)
    expect(first.args).toContain('mcp__local__delete')
    expect(first.args.indexOf('--mcp-config')).toBeLessThan(first.args.indexOf('--'))
    expect(JSON.parse(await readFile(firstPath, 'utf8'))).toEqual({ mcpServers: { local: { type: 'stdio', command: 'node', args: ['server.js'], env: { AUTH: 'secret-value' } } } })
    await Promise.all([first.cleanup?.(), second.cleanup?.()])
    await expect(access(firstPath)).rejects.toBeDefined()
    await expect(access(secondPath)).rejects.toBeDefined()
  })

  it('projects neutral bearer-token references into an HTTP Authorization header', async () => {
    const adapter = new InspectableClaudeCliAdapter()
    const prepared = await adapter.prepare({
      prompt: 'use http tools',
      options: {
        mcpServers: [{
          id: 'worker',
          transport: {
            kind: 'http',
            url: 'http://127.0.0.1:7821',
            bearerTokenEnv: { envVar: 'CODEV_MCP_TOKEN', tokenRef: 'worker-token' },
          },
        }],
        mcpReferenceValues: { 'worker-token': 'raw-token' },
      },
    })
    const configPath = prepared.args[prepared.args.indexOf('--mcp-config') + 1]!
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      mcpServers: {
        worker: {
          type: 'http',
          url: 'http://127.0.0.1:7821',
          headers: { Authorization: 'Bearer raw-token' },
        },
      },
    })
    await prepared.cleanup?.()
  })

  it('maps Claude stream, tool, usage, structured output, and session records', () => {
    const adapter = new InspectableClaudeCliAdapter()
    expect(adapter.map({ type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'hi' } } })).toMatchObject({ type: 'adapter:stream_delta', content: 'hi' })
    expect(adapter.map({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file: 'a' } }] } })).toEqual([expect.objectContaining({ type: 'adapter:tool_call', toolName: 'Read', toolCallId: 't1' })])
    expect(adapter.map({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } })).toEqual([
      expect.objectContaining({ type: 'adapter:tool_result', toolName: 'Read', toolCallId: 't1', output: 'ok' }),
    ])
    expect(adapter.map({ type: 'result', subtype: 'success', session_id: 's1', structured_output: { ok: true }, usage: { input_tokens: 2, output_tokens: 3 }, duration_ms: 4 })).toMatchObject({ type: 'adapter:completed', sessionId: 's1', result: '{"ok":true}', usage: { inputTokens: 2, outputTokens: 3 } })
  })

  it('uses the native init session as the first started identity', () => {
    const adapter = new InspectableClaudeCliAdapter()
    expect(adapter.startsImmediately()).toBe(false)
    expect(adapter.threadStart({ type: 'system', subtype: 'init', session_id: 'native-session-1' }))
      .toEqual({ threadId: 'native-session-1' })
    expect(adapter.threadStart({ type: 'assistant', session_id: 'native-session-1' })).toBeNull()
  })
})
