import { describe, expect, it } from 'vitest'
import { createEventBus, type DzupEvent } from '@dzupagent/core'
import type {
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  HealthStatus,
} from '@dzupagent/adapter-types'
import { CodegenRunEngine } from '../generation/codegen-run-engine.js'

class MockAdapter implements AgentCLIAdapter {
  readonly providerId = 'claude' as const

  constructor(private readonly events: AgentEvent[]) {}

  async *execute(_input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
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

  interrupt(): void {}

  async healthCheck(): Promise<HealthStatus> {
    return {
      healthy: true,
      providerId: 'claude',
      sdkInstalled: true,
      cliAvailable: true,
    }
  }
}

describe('CodegenRunEngine correlation', () => {
  it('emits tool lifecycle events with executionRunId', async () => {
    const bus = createEventBus()
    const emitted: DzupEvent[] = []
    bus.onAny((event) => emitted.push(event))

    const adapter = new MockAdapter([
      {
        type: 'adapter:started',
        providerId: 'claude',
        sessionId: 'exec-42',
        timestamp: 1,
      },
      {
        type: 'adapter:tool_call',
        providerId: 'claude',
        toolName: 'read_file',
        input: { path: '/tmp/demo.ts' },
        timestamp: 2,
      },
      {
        type: 'adapter:tool_result',
        providerId: 'claude',
        toolName: 'read_file',
        output: 'ok',
        durationMs: 12,
        timestamp: 3,
      },
      {
        type: 'adapter:completed',
        providerId: 'claude',
        sessionId: 'exec-42',
        result: '```ts\nexport const demo = true\n```',
        durationMs: 20,
        timestamp: 4,
      },
    ])

    const engine = new CodegenRunEngine({
      adapter,
      eventBus: bus,
    })

    const result = await engine.generateFile(
      { filePath: 'src/demo.ts', purpose: 'demo' },
      'You are a code generator.',
    )

    const toolCalled = emitted.find((event) => event.type === 'tool:called') as
      | Extract<DzupEvent, { type: 'tool:called' }>
      | undefined
    const toolResult = emitted.find((event) => event.type === 'tool:result') as
      | Extract<DzupEvent, { type: 'tool:result' }>
      | undefined

    expect(result.content).toContain('demo = true')
    expect(toolCalled?.executionRunId).toBe('exec-42')
    expect(toolResult?.executionRunId).toBe('exec-42')
  })

  it('throws when adapter terminal tool events cannot resolve executionRunId', async () => {
    const bus = createEventBus()
    const adapter = new MockAdapter([
      {
        type: 'adapter:tool_result',
        providerId: 'claude',
        toolName: 'read_file',
        output: 'ok',
        durationMs: 12,
        timestamp: 1,
      },
      {
        type: 'adapter:completed',
        providerId: 'claude',
        sessionId: 'exec-42',
        result: '```ts\nexport const demo = true\n```',
        durationMs: 20,
        timestamp: 2,
      },
    ])

    const engine = new CodegenRunEngine({
      adapter,
      eventBus: bus,
    })

    await expect(
      engine.generateFile(
        { filePath: 'src/demo.ts', purpose: 'demo' },
        'You are a code generator.',
      ),
    ).rejects.toThrow('Missing executionRunId for tool:result (read_file).')
  })

  it('emits tool:error with executionRunId when adapter fails mid-tool', async () => {
    const bus = createEventBus()
    const emitted: DzupEvent[] = []
    bus.onAny((event) => emitted.push(event))

    const adapter = new MockAdapter([
      {
        type: 'adapter:started',
        providerId: 'claude',
        sessionId: 'exec-99',
        timestamp: 1,
      },
      {
        type: 'adapter:tool_call',
        providerId: 'claude',
        toolName: 'write_file',
        input: { path: '/tmp/demo.ts' },
        timestamp: 2,
      },
      {
        type: 'adapter:failed',
        providerId: 'claude',
        sessionId: 'exec-99',
        error: 'write denied',
        timestamp: 3,
      },
    ])

    const engine = new CodegenRunEngine({
      adapter,
      eventBus: bus,
    })

    await expect(
      engine.generateFile(
        { filePath: 'src/demo.ts', purpose: 'demo' },
        'You are a code generator.',
      ),
    ).rejects.toThrow('Adapter generation failed (claude): write denied')

    const toolError = emitted.find((event) => event.type === 'tool:error') as
      | Extract<DzupEvent, { type: 'tool:error' }>
      | undefined

    expect(toolError?.toolName).toBe('write_file')
    expect(toolError?.errorCode).toBe('TOOL_EXECUTION_FAILED')
    expect(toolError?.executionRunId).toBe('exec-99')
  })

  it('throws when adapter tool:error cannot resolve executionRunId', async () => {
    const bus = createEventBus()
    const adapter = new MockAdapter([
      {
        type: 'adapter:tool_call',
        providerId: 'claude',
        toolName: 'write_file',
        input: { path: '/tmp/demo.ts' },
        timestamp: 1,
      },
      {
        type: 'adapter:failed',
        providerId: 'claude',
        error: 'write denied',
        timestamp: 2,
      },
    ])

    const engine = new CodegenRunEngine({
      adapter,
      eventBus: bus,
    })

    await expect(
      engine.generateFile(
        { filePath: 'src/demo.ts', purpose: 'demo' },
        'You are a code generator.',
      ),
    ).rejects.toThrow('Missing executionRunId for tool:error (write_file).')
  })
})
