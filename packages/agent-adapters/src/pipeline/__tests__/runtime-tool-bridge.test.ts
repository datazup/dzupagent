import { describe, expect, it } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import type { PipelineDefinition } from '@dzupagent/core/pipeline'
import { PipelineRuntime } from '@dzupagent/agent/pipeline'

import { createOrchestrator } from '../../facade/orchestrator-facade.js'
import { createAdapterRuntimeToolHandlers } from '../runtime-tool-bridge.js'
import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
} from '../../types.js'

describe('adapter runtime tool bridge', () => {
  it('executes prompt runtime nodes through OrchestratorFacade.run', async () => {
    const { adapter, inputs } = createCapturingAdapter('codex', 'requirements')
    const orchestrator = createOrchestrator({
      adapters: [adapter],
      eventBus: createEventBus(),
    })

    const runtime = new PipelineRuntime({
      definition: runtimeToolDefinition({
        id: 'prompt_0',
        toolName: 'dzup.runtime.prompt',
        arguments: {
          userPrompt: 'Collect requirements.',
          systemPrompt: 'Be concise.',
          provider: 'codex',
          outputKey: 'requirements',
        },
      }),
      nodeExecutor: unexpectedFallback,
      runtimeToolHandlers: createAdapterRuntimeToolHandlers({ orchestrator }),
    })

    const result = await runtime.execute()

    expect(result.state).toBe('completed')
    expect(inputs).toEqual([
      expect.objectContaining({
        prompt: 'Collect requirements.',
        systemPrompt: 'Be concise.',
      }),
    ])
    expect(result.nodeResults.get('prompt_0')?.output).toEqual({
      text: 'requirements',
      providerId: 'codex',
      durationMs: expect.any(Number),
      usage: { inputTokens: 10, outputTokens: 5 },
    })
  })

  it('executes worker.dispatch runtime nodes through OrchestratorFacade.run', async () => {
    const { adapter, inputs } = createCapturingAdapter('codex', 'review accepted')
    const orchestrator = createOrchestrator({
      adapters: [adapter],
      eventBus: createEventBus(),
    })

    const runtime = new PipelineRuntime({
      definition: runtimeToolDefinition({
        id: 'worker_0',
        toolName: 'dzup.runtime.worker.dispatch',
        arguments: {
          dispatchId: 'review-change',
          provider: 'codex',
          systemPrompt: 'Review only.',
          instructions: 'Review the current diff.',
          input: { pullRequest: 42 },
          outputKey: 'workerReview',
        },
      }),
      nodeExecutor: unexpectedFallback,
      runtimeToolHandlers: createAdapterRuntimeToolHandlers({ orchestrator }),
    })

    const result = await runtime.execute()

    expect(result.state).toBe('completed')
    expect(inputs[0]?.prompt).toContain('Review the current diff.')
    expect(inputs[0]?.prompt).toContain('"pullRequest": 42')
    expect(inputs[0]?.systemPrompt).toBe('Review only.')
    expect(result.nodeResults.get('worker_0')?.output).toMatchObject({
      dispatchId: 'review-change',
      result: 'review accepted',
      providerId: 'codex',
    })
  })

  it('executes adapter.run runtime nodes through OrchestratorFacade.run', async () => {
    const { adapter, inputs } = createCapturingAdapter('claude', 'accepted')
    const orchestrator = createOrchestrator({
      adapters: [adapter],
      eventBus: createEventBus(),
    })

    const runtime = new PipelineRuntime({
      definition: runtimeToolDefinition({
        id: 'adapter_0',
        toolName: 'dzup.runtime.adapter.run',
        arguments: {
          provider: 'claude',
          instructions: 'Discuss the architecture.',
          input: { topic: 'runtime bridge' },
          output: 'adapterResult',
        },
      }),
      nodeExecutor: unexpectedFallback,
      runtimeToolHandlers: createAdapterRuntimeToolHandlers({ orchestrator }),
    })

    const result = await runtime.execute()

    expect(result.state).toBe('completed')
    expect(inputs[0]?.prompt).toContain('Discuss the architecture.')
    expect(inputs[0]?.prompt).toContain('"topic": "runtime bridge"')
    expect(result.nodeResults.get('adapter_0')?.output).toMatchObject({
      result: 'accepted',
      providerId: 'claude',
    })
  })

  it('executes race and parallel adapter runtime nodes through facade orchestration', async () => {
    const claude = createCapturingAdapter('claude', 'claude result')
    const codex = createCapturingAdapter('codex', 'codex result')
    const orchestrator = createOrchestrator({
      adapters: [claude.adapter, codex.adapter],
      eventBus: createEventBus(),
    })
    const handlers = createAdapterRuntimeToolHandlers({ orchestrator })

    const raceRuntime = new PipelineRuntime({
      definition: runtimeToolDefinition({
        id: 'race_0',
        toolName: 'dzup.runtime.adapter.race',
        arguments: {
          providers: ['claude', 'codex'],
          instructions: 'Pick the faster answer.',
          output: 'raceResult',
        },
      }),
      nodeExecutor: unexpectedFallback,
      runtimeToolHandlers: handlers,
    })
    const parallelRuntime = new PipelineRuntime({
      definition: runtimeToolDefinition({
        id: 'parallel_0',
        toolName: 'dzup.runtime.adapter.parallel',
        arguments: {
          providers: ['claude', 'codex'],
          merge: 'all',
          instructions: 'Compare approaches.',
          output: 'parallelResult',
        },
      }),
      nodeExecutor: unexpectedFallback,
      runtimeToolHandlers: handlers,
    })

    const race = await raceRuntime.execute()
    const parallel = await parallelRuntime.execute()

    expect(race.state).toBe('completed')
    expect(race.nodeResults.get('race_0')?.output).toMatchObject({
      success: true,
      result: expect.any(String),
    })
    expect(parallel.state).toBe('completed')
    expect(parallel.nodeResults.get('parallel_0')?.output).toMatchObject({
      strategy: 'all',
      allResults: expect.arrayContaining([
        expect.objectContaining({ providerId: 'claude', result: 'claude result' }),
        expect.objectContaining({ providerId: 'codex', result: 'codex result' }),
      ]),
    })
  })
})

function runtimeToolDefinition(node: {
  id: string
  toolName: string
  arguments: Record<string, unknown>
}): PipelineDefinition {
  return {
    id: `${node.id}-pipeline`,
    name: 'Runtime Tool Bridge Test',
    version: '1.0.0',
    schemaVersion: '1.0.0',
    entryNodeId: node.id,
    nodes: [{ type: 'tool', ...node }],
    edges: [],
  }
}

async function unexpectedFallback(nodeId: string) {
  return {
    nodeId,
    output: undefined,
    durationMs: 1,
    error: `unexpected fallback for ${nodeId}`,
  }
}

function createCapturingAdapter(
  providerId: AdapterProviderId,
  result: string,
): { adapter: AgentCLIAdapter; inputs: AgentInput[] } {
  const inputs: AgentInput[] = []
  return {
    inputs,
    adapter: {
      providerId,
      async *execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
        inputs.push(input)
        yield {
          type: 'adapter:started',
          providerId,
          sessionId: `sess-${providerId}`,
          timestamp: Date.now(),
        }
        yield {
          type: 'adapter:completed',
          providerId,
          sessionId: `sess-${providerId}`,
          result,
          usage: { inputTokens: 10, outputTokens: 5 },
          durationMs: 5,
          timestamp: Date.now(),
        }
      },
      async *resumeSession(): AsyncGenerator<AgentEvent, void, undefined> {},
      interrupt() {},
      async healthCheck() {
        return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
      },
      configure() {},
    },
  }
}
