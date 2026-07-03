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
import type {
  AdapterRuntimeToolOrchestrator,
} from '../runtime-tool-bridge.js'

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
          model: 'claude-sonnet',
          reasoning: 'high',
          promptPrep: 'compress',
          tools: true,
          outputSchema: {
            type: 'object',
            properties: { accepted: { type: 'boolean' } },
          },
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
    expect(inputs[0]?.options).toEqual({
      model: 'claude-sonnet',
      reasoning: 'high',
      promptPrep: 'compress',
      tools: true,
    })
    expect(inputs[0]?.outputSchema).toEqual({
      type: 'object',
      properties: { accepted: { type: 'boolean' } },
    })
    expect(result.nodeResults.get('adapter_0')?.output).toMatchObject({
      result: 'accepted',
      providerId: 'claude',
    })
    expect(result.nodeResults.get('adapter_0')?.providerSessionRefs).toEqual([
      {
        provider: 'claude',
        sessionId: 'sess-claude',
        label: 'adapter.run',
      },
    ])
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
    expect(parallel.nodeResults.get('parallel_0')?.providerSessionRefs).toEqual(
      expect.arrayContaining([
        {
          provider: 'claude',
          sessionId: 'sess-claude',
          label: 'adapter.parallel',
        },
        {
          provider: 'codex',
          sessionId: 'sess-codex',
          label: 'adapter.parallel',
        },
      ]),
    )
  })

  it('executes adapter.supervisor runtime nodes through facade orchestration', async () => {
    const orchestrator: AdapterRuntimeToolOrchestrator = {
      async run() {
        throw new Error('run should not be used')
      },
      async race() {
        throw new Error('race should not be used')
      },
      async parallel() {
        throw new Error('parallel should not be used')
      },
      async supervisor(goal, options) {
        return {
          goal,
          subtaskResults: [
            {
              subtask: {
                description: 'Review architecture',
                tags: ['architecture'],
              },
              providerId: 'claude',
              result: 'approved',
              success: true,
              durationMs: 5,
              sessionId: 'sess-supervisor',
            },
          ],
          totalDurationMs: 5,
          contextSeen: options?.context,
        } as Awaited<ReturnType<AdapterRuntimeToolOrchestrator['supervisor']>> & {
          contextSeen?: string
        }
      },
    }

    const runtime = new PipelineRuntime({
      definition: runtimeToolDefinition({
        id: 'supervisor_0',
        toolName: 'dzup.runtime.adapter.supervisor',
        arguments: {
          goal: 'Coordinate review.',
          specialists: ['architect'],
          input: { pullRequest: 42 },
          output: 'supervisorResult',
        },
      }),
      nodeExecutor: unexpectedFallback,
      runtimeToolHandlers: createAdapterRuntimeToolHandlers({ orchestrator }),
    })

    const result = await runtime.execute()

    expect(result.state).toBe('completed')
    expect(result.nodeResults.get('supervisor_0')?.output).toMatchObject({
      goal: 'Coordinate review.',
      subtaskResults: [
        expect.objectContaining({
          providerId: 'claude',
          result: 'approved',
          sessionId: 'sess-supervisor',
        }),
      ],
      contextSeen: expect.stringContaining('"pullRequest": 42'),
    })
    expect(result.nodeResults.get('supervisor_0')?.providerSessionRefs).toEqual([
      {
        provider: 'claude',
        sessionId: 'sess-supervisor',
        label: 'adapter.supervisor',
      },
    ])
  })

  it('propagates rich runtime options into race, parallel, and supervisor facade APIs', async () => {
    const calls: Array<{ method: string; options: unknown; signal?: AbortSignal }> = []
    const orchestrator: AdapterRuntimeToolOrchestrator = {
      async run() {
        throw new Error('run should not be used')
      },
      async race(_prompt, options, signal) {
        calls.push({ method: 'race', options, signal })
        return {
          providerId: 'claude',
          result: 'race ok',
          success: true,
          durationMs: 1,
          events: [],
          sessionId: 'sess-race',
        }
      },
      async parallel(_prompt, options) {
        calls.push({ method: 'parallel', options })
        return {
          selectedResult: {
            providerId: 'claude',
            result: 'parallel ok',
            success: true,
            durationMs: 1,
            events: [],
            sessionId: 'sess-parallel',
          },
          allResults: [],
          strategy: 'best-of-n',
          totalDurationMs: 1,
        }
      },
      async supervisor(_goal, options) {
        calls.push({ method: 'supervisor', options })
        return {
          goal: 'Coordinate review.',
          subtaskResults: [
            {
              subtask: { description: 'Review architecture', tags: [] },
              providerId: 'claude',
              result: 'supervisor ok',
              success: true,
              durationMs: 1,
              sessionId: 'sess-supervisor',
            },
          ],
          totalDurationMs: 1,
        }
      },
    }
    const handlers = createAdapterRuntimeToolHandlers({ orchestrator })
    const commonArgs = {
      providers: ['claude', 'codex'],
      model: 'claude-sonnet',
      systemPrompt: 'Use system guidance.',
      persona: 'architect',
      reasoning: 'high',
      promptPrep: 'compress',
      policy: { allowTools: false },
      outputSchema: {
        type: 'object',
        properties: { accepted: { type: 'boolean' } },
      },
    }

    await new PipelineRuntime({
      definition: runtimeToolDefinition({
        id: 'race_options',
        toolName: 'dzup.runtime.adapter.race',
        arguments: {
          ...commonArgs,
          instructions: 'Race.',
          output: 'raceResult',
        },
      }),
      nodeExecutor: unexpectedFallback,
      runtimeToolHandlers: handlers,
    }).execute()
    await new PipelineRuntime({
      definition: runtimeToolDefinition({
        id: 'parallel_options',
        toolName: 'dzup.runtime.adapter.parallel',
        arguments: {
          ...commonArgs,
          merge: 'best-of-n',
          instructions: 'Parallel.',
          output: 'parallelResult',
        },
      }),
      nodeExecutor: unexpectedFallback,
      runtimeToolHandlers: handlers,
    }).execute()
    await new PipelineRuntime({
      definition: runtimeToolDefinition({
        id: 'supervisor_options',
        toolName: 'dzup.runtime.adapter.supervisor',
        arguments: {
          ...commonArgs,
          goal: 'Coordinate review.',
          specialists: ['architect'],
          output: 'supervisorResult',
        },
      }),
      nodeExecutor: unexpectedFallback,
      runtimeToolHandlers: handlers,
    }).execute()

    expect(calls).toEqual([
      {
        method: 'race',
        options: expect.objectContaining({
          model: 'claude-sonnet',
          systemPrompt: 'Use system guidance.',
          personaId: 'architect',
          reasoning: 'high',
          promptPrep: 'compress',
          policy: { allowTools: false },
          outputSchema: commonArgs.outputSchema,
        }),
        signal: undefined,
      },
      {
        method: 'parallel',
        options: expect.objectContaining({
          providers: ['claude', 'codex'],
          mergeStrategy: 'best-of-n',
          model: 'claude-sonnet',
          systemPrompt: 'Use system guidance.',
          personaId: 'architect',
          reasoning: 'high',
          promptPrep: 'compress',
          policy: { allowTools: false },
          outputSchema: commonArgs.outputSchema,
        }),
      },
      {
        method: 'supervisor',
        options: expect.objectContaining({
          model: 'claude-sonnet',
          systemPrompt: 'Use system guidance.',
          personaId: 'architect',
          reasoning: 'high',
          promptPrep: 'compress',
          policy: { allowTools: false },
          outputSchema: commonArgs.outputSchema,
          context: expect.stringContaining('"architect"'),
        }),
      },
    ])
  })

  it('maps failed and cancelled adapter orchestration results to runtime node errors', async () => {
    const orchestrator: AdapterRuntimeToolOrchestrator = {
      async run() {
        return {
          result: '',
          providerId: 'claude',
          durationMs: 1,
          error: 'run failed',
          sessionId: 'sess-run-fail',
        }
      },
      async race() {
        return {
          providerId: 'claude',
          result: '',
          success: false,
          durationMs: 1,
          error: 'race failed',
          events: [],
          sessionId: 'sess-race-fail',
        }
      },
      async parallel() {
        return {
          selectedResult: {
            providerId: 'claude',
            result: '',
            success: false,
            durationMs: 1,
            error: 'parallel cancelled',
            cancelled: true,
            events: [],
            sessionId: 'sess-parallel-cancelled',
          },
          allResults: [],
          strategy: 'all',
          totalDurationMs: 1,
          cancelled: true,
        }
      },
      async supervisor() {
        return {
          goal: 'g',
          subtaskResults: [
            {
              subtask: { description: 'd', tags: [] },
              providerId: 'claude',
              result: '',
              success: false,
              durationMs: 1,
              cancelled: true,
              error: 'supervisor cancelled',
              sessionId: 'sess-supervisor-cancelled',
            },
          ],
          totalDurationMs: 1,
          cancelled: true,
        }
      },
    }
    const handlers = createAdapterRuntimeToolHandlers({ orchestrator })

    const run = await new PipelineRuntime({
      definition: runtimeToolDefinition({
        id: 'run_0',
        toolName: 'dzup.runtime.adapter.run',
        arguments: { instructions: 'Run.', output: 'runResult' },
      }),
      nodeExecutor: unexpectedFallback,
      runtimeToolHandlers: handlers,
    }).execute()
    const race = await new PipelineRuntime({
      definition: runtimeToolDefinition({
        id: 'race_0',
        toolName: 'dzup.runtime.adapter.race',
        arguments: { providers: ['claude'], instructions: 'Race.', output: 'raceResult' },
      }),
      nodeExecutor: unexpectedFallback,
      runtimeToolHandlers: handlers,
    }).execute()
    const parallel = await new PipelineRuntime({
      definition: runtimeToolDefinition({
        id: 'parallel_0',
        toolName: 'dzup.runtime.adapter.parallel',
        arguments: { providers: ['claude'], instructions: 'Parallel.', output: 'parallelResult' },
      }),
      nodeExecutor: unexpectedFallback,
      runtimeToolHandlers: handlers,
    }).execute()
    const supervisor = await new PipelineRuntime({
      definition: runtimeToolDefinition({
        id: 'supervisor_0',
        toolName: 'dzup.runtime.adapter.supervisor',
        arguments: { goal: 'Supervise.', output: 'supervisorResult' },
      }),
      nodeExecutor: unexpectedFallback,
      runtimeToolHandlers: handlers,
    }).execute()

    expect(run.state).toBe('failed')
    expect(run.nodeResults.get('run_0')?.errorMetadata).toMatchObject({
      code: 'ADAPTER_RUNTIME_FAILED',
      providerId: 'claude',
    })
    expect(run.nodeResults.get('run_0')?.providerSessionRefs).toEqual([
      { provider: 'claude', sessionId: 'sess-run-fail', label: 'adapter.run' },
    ])

    expect(race.state).toBe('failed')
    expect(race.nodeResults.get('race_0')?.error).toBe('race failed')
    expect(race.nodeResults.get('race_0')?.providerSessionRefs).toEqual([
      { provider: 'claude', sessionId: 'sess-race-fail', label: 'adapter.race' },
    ])

    expect(parallel.state).toBe('failed')
    expect(parallel.nodeResults.get('parallel_0')?.errorMetadata).toMatchObject({
      code: 'ADAPTER_RUNTIME_CANCELLED',
      retryable: false,
      providerId: 'claude',
    })
    expect(parallel.nodeResults.get('parallel_0')?.providerSessionRefs).toEqual([
      { provider: 'claude', sessionId: 'sess-parallel-cancelled', label: 'adapter.parallel' },
    ])

    expect(supervisor.state).toBe('failed')
    expect(supervisor.nodeResults.get('supervisor_0')?.errorMetadata).toMatchObject({
      code: 'ADAPTER_RUNTIME_CANCELLED',
      retryable: false,
    })
    expect(supervisor.nodeResults.get('supervisor_0')?.providerSessionRefs).toEqual([
      { provider: 'claude', sessionId: 'sess-supervisor-cancelled', label: 'adapter.supervisor' },
    ])
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
