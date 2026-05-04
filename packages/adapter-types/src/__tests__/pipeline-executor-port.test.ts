import { describe, it, expect } from 'vitest'
import type {
  PipelineExecutorConfig,
  PipelineExecutorEvent,
  PipelineExecutorFactory,
  PipelineExecutorNodeContext,
  PipelineExecutorNodeResult,
  PipelineExecutorPort,
  PipelineExecutorRunResult,
  PipelineExecutorState,
} from '../pipeline-executor-port.js'

// ---------------------------------------------------------------------------
// Compile-time + runtime checks confirming the port surface is implementable
// without depending on `@dzupagent/agent`.
// ---------------------------------------------------------------------------

describe('PipelineExecutorPort', () => {
  it('admits a structural in-memory implementation', async () => {
    interface FakeDefinition { id: string }
    interface FakeNode { id: string }

    const calls: string[] = []
    const factory: PipelineExecutorFactory<FakeDefinition, FakeNode> = (
      config: PipelineExecutorConfig<FakeDefinition, FakeNode>,
    ): PipelineExecutorPort => {
      return {
        async execute(initialState?: Record<string, unknown>): Promise<PipelineExecutorRunResult> {
          calls.push(`execute:${config.definition.id}`)
          const ctx: PipelineExecutorNodeContext = {
            state: { ...(initialState ?? {}) },
            previousResults: new Map<string, PipelineExecutorNodeResult>(),
          }
          const node: FakeNode = { id: 'n1' }
          const nodeResult = await config.nodeExecutor('n1', node, ctx)
          const event: PipelineExecutorEvent = {
            type: 'pipeline:completed',
            runId: 'run-1',
            totalDurationMs: nodeResult.durationMs,
          }
          config.onEvent?.(event)
          const state: PipelineExecutorState = 'completed'
          return {
            pipelineId: config.definition.id,
            runId: 'run-1',
            state,
            nodeResults: new Map([[nodeResult.nodeId, nodeResult]]),
            totalDurationMs: nodeResult.durationMs,
          }
        },
      }
    }

    const events: PipelineExecutorEvent[] = []
    const executor = factory({
      definition: { id: 'pipe-1' },
      nodeExecutor: async (nodeId, _node, ctx) => ({
        nodeId,
        output: { stateKeys: Object.keys(ctx.state) },
        durationMs: 5,
      }),
      onEvent: (event) => events.push(event),
    })

    const result = await executor.execute({ seed: 'value' })

    expect(calls).toEqual(['execute:pipe-1'])
    expect(result.state).toBe('completed')
    expect(result.nodeResults.get('n1')?.output).toEqual({ stateKeys: ['seed'] })
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('pipeline:completed')
  })

  it('respects optional fields on the config (no signal/predicates required)', () => {
    const factory: PipelineExecutorFactory = (
      config: PipelineExecutorConfig,
    ): PipelineExecutorPort => ({
      async execute() {
        return {
          pipelineId: 'p',
          runId: 'r',
          state: 'completed',
          nodeResults: new Map(),
          totalDurationMs: 0,
        }
      },
    })
    const executor = factory({
      definition: {},
      nodeExecutor: async (nodeId) => ({ nodeId, output: null, durationMs: 0 }),
    })
    expect(executor.execute).toBeTypeOf('function')
  })
})
