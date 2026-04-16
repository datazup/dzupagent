import { describe, expect, it, beforeEach } from 'vitest'
import { createEventBus, type DzupEvent, type DzupEventBus } from '@dzupagent/core'
import type {
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  AdapterConfig,
  AdapterCapabilityProfile,
  HealthStatus,
} from '@dzupagent/adapter-types'
import { CodegenRunEngine } from '../generation/codegen-run-engine.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal mock adapter that yields a pre-configured sequence of events.
 */
class MockAdapter implements AgentCLIAdapter {
  readonly providerId = 'claude' as const
  lastInput: AgentInput | undefined

  constructor(private readonly events: AgentEvent[]) {}

  async *execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
    this.lastInput = input
    for (const event of this.events) {
      yield event
    }
  }

  async *resumeSession(
    _sessionId: string,
    _input: AgentInput,
  ): AsyncGenerator<AgentEvent, void, undefined> {
    for (const event of this.events) {
      yield event
    }
  }

  interrupt(): void {
    // no-op
  }

  async healthCheck(): Promise<HealthStatus> {
    return { healthy: true, providerId: 'claude', sdkInstalled: true, cliAvailable: true }
  }

  configure(_opts: Partial<AdapterConfig>): void {
    // no-op
  }

  getCapabilities(): AdapterCapabilityProfile {
    return {
      supportsResume: false,
      supportsFork: false,
      supportsToolCalls: true,
      supportsStreaming: true,
      supportsCostUsage: false,
    }
  }
}

const SESSION_ID = 'sess-abc-123'
const PROVIDER = 'claude' as const

function now(): number {
  return Date.now()
}

function startedEvent(sessionId = SESSION_ID): AgentEvent {
  return {
    type: 'adapter:started',
    providerId: PROVIDER,
    sessionId,
    timestamp: now(),
  }
}

function streamDeltaEvent(content: string): AgentEvent {
  return {
    type: 'adapter:stream_delta',
    providerId: PROVIDER,
    content,
    timestamp: now(),
  }
}

function toolCallEvent(toolName: string, input: unknown): AgentEvent {
  return {
    type: 'adapter:tool_call',
    providerId: PROVIDER,
    toolName,
    input,
    timestamp: now(),
  }
}

function toolResultEvent(toolName: string, output: string, durationMs = 10): AgentEvent {
  return {
    type: 'adapter:tool_result',
    providerId: PROVIDER,
    toolName,
    output,
    durationMs,
    timestamp: now(),
  }
}

function completedEvent(
  result: string,
  sessionId = SESSION_ID,
  durationMs = 100,
): AgentEvent {
  return {
    type: 'adapter:completed',
    providerId: PROVIDER,
    sessionId,
    result,
    durationMs,
    timestamp: now(),
    usage: { inputTokens: 50, outputTokens: 30 },
  }
}

function failedEvent(error: string, sessionId?: string): AgentEvent {
  return {
    type: 'adapter:failed',
    providerId: PROVIDER,
    sessionId,
    error,
    timestamp: now(),
  }
}

const CODE_BLOCK = '```typescript\nexport const answer = 42\n```'
const DEFAULT_PARAMS = { filePath: 'src/answer.ts', purpose: 'export a constant' }
const DEFAULT_SYSTEM = 'You are a code generator.'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CodegenRunEngine', () => {
  let bus: DzupEventBus
  let emitted: DzupEvent[]

  beforeEach(() => {
    bus = createEventBus()
    emitted = []
    bus.onAny((event) => emitted.push(event))
  })

  // -----------------------------------------------------------------------
  // Construction
  // -----------------------------------------------------------------------

  describe('constructor', () => {
    it('throws when neither adapter nor registry provided', () => {
      expect(() => new CodegenRunEngine({})).toThrow(
        'CodegenRunEngine requires either an adapter or a registry',
      )
    })

    it('usesAdapter returns true when adapter is provided', () => {
      const adapter = new MockAdapter([])
      const engine = new CodegenRunEngine({ adapter })
      expect(engine.usesAdapter).toBe(true)
    })

    it('usesAdapter returns false when only registry is provided', () => {
      // Provide a minimal mock registry to avoid the "requires either" error
      const mockRegistry = {
        getModel: () => ({
          invoke: async () => ({ content: CODE_BLOCK }),
        }),
      }
      const engine = new CodegenRunEngine({
        registry: mockRegistry as never,
      })
      expect(engine.usesAdapter).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // Event forwarding: adapter:started -> agent:started
  // -----------------------------------------------------------------------

  describe('adapter:started -> agent:started', () => {
    it('emits agent:started with correct runId from sessionId', async () => {
      const adapter = new MockAdapter([
        startedEvent('my-session-42'),
        completedEvent(CODE_BLOCK, 'my-session-42'),
      ])
      const engine = new CodegenRunEngine({ adapter, eventBus: bus })

      await engine.generateFile(DEFAULT_PARAMS, DEFAULT_SYSTEM)

      const started = emitted.find((e) => e.type === 'agent:started') as
        | Extract<DzupEvent, { type: 'agent:started' }>
        | undefined

      expect(started).toBeDefined()
      expect(started!.runId).toBe('my-session-42')
      expect(started!.agentId).toBe('codegen:claude')
    })
  })

  // -----------------------------------------------------------------------
  // Event forwarding: adapter:stream_delta -> agent:stream_delta
  // -----------------------------------------------------------------------

  describe('adapter:stream_delta -> agent:stream_delta', () => {
    it('uses adapter session ID as runId (not hardcoded "codegen")', async () => {
      const adapter = new MockAdapter([
        startedEvent('stream-session-7'),
        streamDeltaEvent('export const '),
        streamDeltaEvent('x = 1'),
        completedEvent(CODE_BLOCK, 'stream-session-7'),
      ])
      const engine = new CodegenRunEngine({ adapter, eventBus: bus })

      await engine.generateFile(DEFAULT_PARAMS, DEFAULT_SYSTEM)

      const deltas = emitted.filter((e) => e.type === 'agent:stream_delta') as Array<
        Extract<DzupEvent, { type: 'agent:stream_delta' }>
      >

      expect(deltas).toHaveLength(2)
      for (const delta of deltas) {
        expect(delta.runId).toBe('stream-session-7')
        expect(delta.agentId).toBe('codegen:claude')
      }
    })

    it('forwards content correctly', async () => {
      const adapter = new MockAdapter([
        startedEvent(),
        streamDeltaEvent('hello '),
        streamDeltaEvent('world'),
        completedEvent(CODE_BLOCK),
      ])
      const engine = new CodegenRunEngine({ adapter, eventBus: bus })

      await engine.generateFile(DEFAULT_PARAMS, DEFAULT_SYSTEM)

      const deltas = emitted.filter((e) => e.type === 'agent:stream_delta') as Array<
        Extract<DzupEvent, { type: 'agent:stream_delta' }>
      >

      expect(deltas[0]!.content).toBe('hello ')
      expect(deltas[1]!.content).toBe('world')
    })

    it('falls back to "codegen" when no started event precedes delta', async () => {
      // Edge case: stream_delta before adapter:started (no session ID known)
      const adapter = new MockAdapter([
        streamDeltaEvent('early content'),
        startedEvent(),
        completedEvent(CODE_BLOCK),
      ])
      const engine = new CodegenRunEngine({ adapter, eventBus: bus })

      await engine.generateFile(DEFAULT_PARAMS, DEFAULT_SYSTEM)

      const deltas = emitted.filter((e) => e.type === 'agent:stream_delta') as Array<
        Extract<DzupEvent, { type: 'agent:stream_delta' }>
      >

      // First delta has no session yet, so falls back to 'codegen'
      expect(deltas[0]!.runId).toBe('codegen')
    })
  })

  // -----------------------------------------------------------------------
  // Event forwarding: adapter:completed -> agent:completed
  // -----------------------------------------------------------------------

  describe('adapter:completed -> agent:completed', () => {
    it('emits agent:completed with session ID and durationMs', async () => {
      const adapter = new MockAdapter([
        startedEvent(),
        completedEvent(CODE_BLOCK, SESSION_ID, 250),
      ])
      const engine = new CodegenRunEngine({ adapter, eventBus: bus })

      await engine.generateFile(DEFAULT_PARAMS, DEFAULT_SYSTEM)

      const completed = emitted.find((e) => e.type === 'agent:completed') as
        | Extract<DzupEvent, { type: 'agent:completed' }>
        | undefined

      expect(completed).toBeDefined()
      expect(completed!.runId).toBe(SESSION_ID)
      expect(completed!.durationMs).toBe(250)
      expect(completed!.agentId).toBe('codegen:claude')
    })
  })

  // -----------------------------------------------------------------------
  // Event forwarding: adapter:failed -> agent:failed
  // -----------------------------------------------------------------------

  describe('adapter:failed -> agent:failed', () => {
    it('emits agent:failed with correct fields', async () => {
      const adapter = new MockAdapter([
        startedEvent(),
        failedEvent('timeout exceeded', SESSION_ID),
      ])
      const engine = new CodegenRunEngine({ adapter, eventBus: bus })

      await expect(
        engine.generateFile(DEFAULT_PARAMS, DEFAULT_SYSTEM),
      ).rejects.toThrow('Adapter generation failed (claude): timeout exceeded')

      const failed = emitted.find((e) => e.type === 'agent:failed') as
        | Extract<DzupEvent, { type: 'agent:failed' }>
        | undefined

      expect(failed).toBeDefined()
      expect(failed!.runId).toBe(SESSION_ID)
      expect(failed!.message).toBe('timeout exceeded')
      expect(failed!.errorCode).toBe('PROVIDER_UNAVAILABLE')
    })

    it('uses "unknown" runId when sessionId is absent', async () => {
      const adapter = new MockAdapter([
        failedEvent('no session'),
      ])
      const engine = new CodegenRunEngine({ adapter, eventBus: bus })

      await expect(
        engine.generateFile(DEFAULT_PARAMS, DEFAULT_SYSTEM),
      ).rejects.toThrow('Adapter generation failed')

      const failed = emitted.find((e) => e.type === 'agent:failed') as
        | Extract<DzupEvent, { type: 'agent:failed' }>
        | undefined

      expect(failed).toBeDefined()
      expect(failed!.runId).toBe('unknown')
    })
  })

  // -----------------------------------------------------------------------
  // Event forwarding: adapter:tool_call -> tool:called
  // -----------------------------------------------------------------------

  describe('adapter:tool_call -> tool:called', () => {
    it('emits tool:called with correct fields', async () => {
      const adapter = new MockAdapter([
        startedEvent(),
        toolCallEvent('write_file', { path: '/tmp/x.ts', content: 'hi' }),
        toolResultEvent('write_file', 'ok'),
        completedEvent(CODE_BLOCK),
      ])
      const engine = new CodegenRunEngine({ adapter, eventBus: bus })

      await engine.generateFile(DEFAULT_PARAMS, DEFAULT_SYSTEM)

      const called = emitted.find((e) => e.type === 'tool:called') as
        | Extract<DzupEvent, { type: 'tool:called' }>
        | undefined

      expect(called).toBeDefined()
      expect(called!.toolName).toBe('write_file')
      expect(called!.input).toEqual({ path: '/tmp/x.ts', content: 'hi' })
      expect(called!.executionRunId).toBe(SESSION_ID)
    })
  })

  // -----------------------------------------------------------------------
  // Event forwarding: adapter:tool_result -> tool:result
  // -----------------------------------------------------------------------

  describe('adapter:tool_result -> tool:result', () => {
    it('emits tool:result with correct fields', async () => {
      const adapter = new MockAdapter([
        startedEvent(),
        toolCallEvent('read_file', { path: '/tmp/y.ts' }),
        toolResultEvent('read_file', 'file content', 15),
        completedEvent(CODE_BLOCK),
      ])
      const engine = new CodegenRunEngine({ adapter, eventBus: bus })

      await engine.generateFile(DEFAULT_PARAMS, DEFAULT_SYSTEM)

      const result = emitted.find((e) => e.type === 'tool:result') as
        | Extract<DzupEvent, { type: 'tool:result' }>
        | undefined

      expect(result).toBeDefined()
      expect(result!.toolName).toBe('read_file')
      expect(result!.durationMs).toBe(15)
      expect(result!.executionRunId).toBe(SESSION_ID)
    })
  })

  // -----------------------------------------------------------------------
  // Content extraction via extractLargestCodeBlock
  // -----------------------------------------------------------------------

  describe('content extraction', () => {
    it('extracts code from markdown code block', async () => {
      const adapter = new MockAdapter([
        startedEvent(),
        completedEvent('```typescript\nexport const foo = "bar"\n```'),
      ])
      const engine = new CodegenRunEngine({ adapter, eventBus: bus })

      const result = await engine.generateFile(DEFAULT_PARAMS, DEFAULT_SYSTEM)

      expect(result.content).toBe('export const foo = "bar"')
      expect(result.source).toBe('llm')
      expect(result.language).toBe('typescript')
    })

    it('extracts largest block when multiple are present', async () => {
      const multiBlock = [
        '```ts\nsmall\n```',
        '```typescript\nexport function biggerBlock() {\n  return 42\n}\n```',
      ].join('\n\n')

      const adapter = new MockAdapter([
        startedEvent(),
        completedEvent(multiBlock),
      ])
      const engine = new CodegenRunEngine({ adapter, eventBus: bus })

      const result = await engine.generateFile(DEFAULT_PARAMS, DEFAULT_SYSTEM)

      expect(result.content).toContain('biggerBlock')
    })

    it('returns full text when no code block present', async () => {
      const adapter = new MockAdapter([
        startedEvent(),
        completedEvent('export const raw = true'),
      ])
      const engine = new CodegenRunEngine({ adapter, eventBus: bus })

      const result = await engine.generateFile(DEFAULT_PARAMS, DEFAULT_SYSTEM)

      expect(result.content).toBe('export const raw = true')
    })

    it('includes token usage from completed event', async () => {
      const adapter = new MockAdapter([
        startedEvent(),
        completedEvent(CODE_BLOCK),
      ])
      const engine = new CodegenRunEngine({ adapter, eventBus: bus })

      const result = await engine.generateFile(DEFAULT_PARAMS, DEFAULT_SYSTEM)

      expect(result.tokensUsed).toEqual({
        model: 'adapter',
        inputTokens: 50,
        outputTokens: 30,
      })
    })
  })

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  describe('error handling', () => {
    it('throws when adapter emits adapter:failed', async () => {
      const adapter = new MockAdapter([
        startedEvent(),
        failedEvent('rate limit exceeded', SESSION_ID),
      ])
      const engine = new CodegenRunEngine({ adapter, eventBus: bus })

      await expect(
        engine.generateFile(DEFAULT_PARAMS, DEFAULT_SYSTEM),
      ).rejects.toThrow('Adapter generation failed (claude): rate limit exceeded')
    })

    it('throws when adapter finishes without completed event', async () => {
      const adapter = new MockAdapter([
        startedEvent(),
        // No completed or failed event
      ])
      const engine = new CodegenRunEngine({ adapter, eventBus: bus })

      await expect(
        engine.generateFile(DEFAULT_PARAMS, DEFAULT_SYSTEM),
      ).rejects.toThrow('finished without a completed event')
    })

    it('prefers failed event over missing completed event', async () => {
      const adapter = new MockAdapter([
        startedEvent(),
        failedEvent('explicit failure', SESSION_ID),
      ])
      const engine = new CodegenRunEngine({ adapter, eventBus: bus })

      await expect(
        engine.generateFile(DEFAULT_PARAMS, DEFAULT_SYSTEM),
      ).rejects.toThrow('Adapter generation failed (claude): explicit failure')
    })
  })

  // -----------------------------------------------------------------------
  // Event ordering
  // -----------------------------------------------------------------------

  describe('event ordering on DzupEventBus', () => {
    it('emits events in correct order for a full lifecycle', async () => {
      const adapter = new MockAdapter([
        startedEvent(),
        streamDeltaEvent('chunk1'),
        toolCallEvent('write_file', { path: 'x' }),
        toolResultEvent('write_file', 'done'),
        streamDeltaEvent('chunk2'),
        completedEvent(CODE_BLOCK),
      ])
      const engine = new CodegenRunEngine({ adapter, eventBus: bus })

      await engine.generateFile(DEFAULT_PARAMS, DEFAULT_SYSTEM)

      const types = emitted.map((e) => e.type)
      expect(types).toEqual([
        'agent:started',
        'agent:stream_delta',
        'tool:called',
        'tool:result',
        'agent:stream_delta',
        'agent:completed',
      ])
    })

    it('emits agent:failed after tool:error when failure during tool call', async () => {
      const adapter = new MockAdapter([
        startedEvent(),
        toolCallEvent('dangerous_op', {}),
        failedEvent('permission denied', SESSION_ID),
      ])
      const engine = new CodegenRunEngine({ adapter, eventBus: bus })

      await expect(
        engine.generateFile(DEFAULT_PARAMS, DEFAULT_SYSTEM),
      ).rejects.toThrow('permission denied')

      const types = emitted.map((e) => e.type)
      expect(types).toEqual([
        'agent:started',
        'tool:called',
        'tool:error',
        'agent:failed',
      ])
    })
  })

  // -----------------------------------------------------------------------
  // No event bus
  // -----------------------------------------------------------------------

  describe('without event bus', () => {
    it('generates successfully without emitting events', async () => {
      const adapter = new MockAdapter([
        startedEvent(),
        streamDeltaEvent('data'),
        completedEvent(CODE_BLOCK),
      ])
      const engine = new CodegenRunEngine({ adapter })

      const result = await engine.generateFile(DEFAULT_PARAMS, DEFAULT_SYSTEM)

      expect(result.content).toBe('export const answer = 42')
      expect(emitted).toHaveLength(0) // bus was not passed to engine
    })
  })

  // -----------------------------------------------------------------------
  // Adapter input forwarding
  // -----------------------------------------------------------------------

  describe('adapter input', () => {
    it('passes prompt and systemPrompt to adapter', async () => {
      const adapter = new MockAdapter([
        startedEvent(),
        completedEvent(CODE_BLOCK),
      ])
      const engine = new CodegenRunEngine({
        adapter,
        eventBus: bus,
        workingDirectory: '/workspace',
        maxTurns: 3,
      })

      await engine.generateFile(DEFAULT_PARAMS, DEFAULT_SYSTEM)

      expect(adapter.lastInput).toBeDefined()
      expect(adapter.lastInput!.systemPrompt).toBe(DEFAULT_SYSTEM)
      expect(adapter.lastInput!.prompt).toContain('src/answer.ts')
      expect(adapter.lastInput!.prompt).toContain('export a constant')
      expect(adapter.lastInput!.workingDirectory).toBe('/workspace')
      expect(adapter.lastInput!.maxTurns).toBe(3)
    })

    it('includes reference files in prompt', async () => {
      const adapter = new MockAdapter([
        startedEvent(),
        completedEvent(CODE_BLOCK),
      ])
      const engine = new CodegenRunEngine({ adapter })

      await engine.generateFile(
        {
          filePath: 'src/util.ts',
          purpose: 'utility',
          referenceFiles: { 'src/types.ts': 'export type Foo = string' },
        },
        DEFAULT_SYSTEM,
      )

      expect(adapter.lastInput!.prompt).toContain('Reference Files')
      expect(adapter.lastInput!.prompt).toContain('src/types.ts')
      expect(adapter.lastInput!.prompt).toContain('export type Foo = string')
    })

    it('includes context in prompt', async () => {
      const adapter = new MockAdapter([
        startedEvent(),
        completedEvent(CODE_BLOCK),
      ])
      const engine = new CodegenRunEngine({ adapter })

      await engine.generateFile(
        {
          filePath: 'src/config.ts',
          purpose: 'config',
          context: { framework: 'express', version: '4.x' },
        },
        DEFAULT_SYSTEM,
      )

      expect(adapter.lastInput!.prompt).toContain('Context')
      expect(adapter.lastInput!.prompt).toContain('framework: express')
      expect(adapter.lastInput!.prompt).toContain('version: 4.x')
    })

    it('defaults maxTurns to 1', async () => {
      const adapter = new MockAdapter([
        startedEvent(),
        completedEvent(CODE_BLOCK),
      ])
      const engine = new CodegenRunEngine({ adapter })

      await engine.generateFile(DEFAULT_PARAMS, DEFAULT_SYSTEM)

      expect(adapter.lastInput!.maxTurns).toBe(1)
    })
  })

  // -----------------------------------------------------------------------
  // Multiple stream deltas with session ID consistency
  // -----------------------------------------------------------------------

  describe('stream delta runId consistency', () => {
    it('all deltas after started use the same session ID', async () => {
      const adapter = new MockAdapter([
        startedEvent('unique-session'),
        streamDeltaEvent('a'),
        streamDeltaEvent('b'),
        streamDeltaEvent('c'),
        completedEvent(CODE_BLOCK, 'unique-session'),
      ])
      const engine = new CodegenRunEngine({ adapter, eventBus: bus })

      await engine.generateFile(DEFAULT_PARAMS, DEFAULT_SYSTEM)

      const deltas = emitted.filter((e) => e.type === 'agent:stream_delta') as Array<
        Extract<DzupEvent, { type: 'agent:stream_delta' }>
      >

      expect(deltas).toHaveLength(3)
      for (const delta of deltas) {
        expect(delta.runId).toBe('unique-session')
      }
    })
  })

  // -----------------------------------------------------------------------
  // Language detection
  // -----------------------------------------------------------------------

  describe('language detection', () => {
    it('detects typescript from .ts extension', async () => {
      const adapter = new MockAdapter([
        startedEvent(),
        completedEvent(CODE_BLOCK),
      ])
      const engine = new CodegenRunEngine({ adapter })

      const result = await engine.generateFile(
        { filePath: 'src/index.ts', purpose: 'entry' },
        DEFAULT_SYSTEM,
      )

      expect(result.language).toBe('typescript')
    })

    it('detects python from .py extension', async () => {
      const adapter = new MockAdapter([
        startedEvent(),
        completedEvent('```python\nprint("hello")\n```'),
      ])
      const engine = new CodegenRunEngine({ adapter })

      const result = await engine.generateFile(
        { filePath: 'src/main.py', purpose: 'entry' },
        DEFAULT_SYSTEM,
      )

      expect(result.language).toBe('python')
    })
  })

  // -----------------------------------------------------------------------
  // adapter:message and adapter:progress are ignored
  // -----------------------------------------------------------------------

  describe('ignored event types', () => {
    it('does not emit DzupEvents for adapter:message', async () => {
      const adapter = new MockAdapter([
        startedEvent(),
        {
          type: 'adapter:message' as const,
          providerId: PROVIDER,
          content: 'thinking...',
          role: 'assistant' as const,
          timestamp: now(),
        },
        completedEvent(CODE_BLOCK),
      ])
      const engine = new CodegenRunEngine({ adapter, eventBus: bus })

      await engine.generateFile(DEFAULT_PARAMS, DEFAULT_SYSTEM)

      const types = emitted.map((e) => e.type)
      expect(types).not.toContain('adapter:message')
      expect(types).toEqual(['agent:started', 'agent:completed'])
    })

    it('does not emit DzupEvents for adapter:progress', async () => {
      const adapter = new MockAdapter([
        startedEvent(),
        {
          type: 'adapter:progress' as const,
          providerId: PROVIDER,
          timestamp: now(),
          phase: 'generating',
          percentage: 50,
        },
        completedEvent(CODE_BLOCK),
      ])
      const engine = new CodegenRunEngine({ adapter, eventBus: bus })

      await engine.generateFile(DEFAULT_PARAMS, DEFAULT_SYSTEM)

      const types = emitted.map((e) => e.type)
      expect(types).toEqual(['agent:started', 'agent:completed'])
    })
  })
})
