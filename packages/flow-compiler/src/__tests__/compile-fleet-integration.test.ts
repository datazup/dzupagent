import type { ResolvedTool, ToolResolver } from '@dzupagent/flow-ast'
import type { SkillChain } from '@dzupagent/core/pipeline'
import { InMemoryDomainToolRegistry } from '@dzupagent/app-tools'
import { describe, expect, it } from 'vitest'

import { createFlowCompiler } from '../index.js'
import type { LoweredFleetStep } from '../lower/lower-fleet-nodes.js'

const FLEET_SUPERVISOR_FACTORY =
  '@dzupagent/agent/orchestration#FleetSupervisor'
const KNOWLEDGE_STORE_FACTORY = '@dzupagent/agent/orchestration#KnowledgeStore'

type ScriptHandler = (payload: unknown) => unknown | Promise<unknown>

class ScriptedExecutor {
  private readonly calls: Array<{
    factory: string
    handler: string
    payload: unknown
  }> = []

  constructor(private readonly handlers: Record<string, ScriptHandler>) {}

  async run(steps: LoweredFleetStep[]): Promise<unknown[]> {
    const outputs: unknown[] = []
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]
      if (step === undefined) continue

      this.calls.push({
        factory: step.factory,
        handler: step.handler,
        payload: step.payload,
      })

      const key = `${step.factory}#${step.handler}`
      const handler = this.handlers[key]
      if (handler === undefined) {
        throw new Error(`missing scripted handler for ${key}`)
      }

      outputs.push(await handler(step.payload))
    }
    return outputs
  }

  getCalls(): Array<{ factory: string; handler: string; payload: unknown }> {
    return [...this.calls]
  }
}

function makeResolver(toolRefs: string[]): ToolResolver {
  const registry = new InMemoryDomainToolRegistry()
  for (const name of toolRefs) {
    const namespace = name.split('.')[0] ?? name
    registry.register({
      name,
      description: `test skill ${name}`,
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      permissionLevel: 'read',
      sideEffects: [],
      namespace,
    })
  }

  return {
    resolve(ref: string): ResolvedTool | null {
      const def = registry.get(ref)
      if (def === undefined) return null
      return {
        ref,
        kind: 'skill',
        inputSchema: def.inputSchema,
        handle: def,
      }
    },
    listAvailable: () => registry.list().map((tool) => tool.name),
  }
}

describe('compile pipeline fleet/knowledge lowering integration', () => {
  it('attaches lowered fleetSteps with normalized payload and executable handlers', async () => {
    const compiler = createFlowCompiler({ toolResolver: makeResolver(['tasks.run']) })

    const result = await compiler.compileDocument({
      dsl: 'dzupflow/v1',
      id: 'fleet_flow',
      version: 1,
      root: {
        type: 'sequence',
        id: 'root',
        nodes: [
          {
            type: 'action',
            id: 'start',
            toolRef: 'tasks.run',
            input: { stage: 'start' },
          },
          {
            type: 'fleet.dispatch',
            id: 'dispatch-1',
            mode: 'contract-net',
            repos: ['repo-a', 'repo-b'],
            task: { goal: 'Review pull request' },
            on_contract_change: 'reroute',
            output: 'dispatch_result',
          },
          {
            type: 'fleet.gather',
            id: 'gather-1',
            source: 'dispatch_result',
            strategy: 'merge',
            output: 'gathered_result',
          },
          {
            type: 'knowledge.write',
            id: 'knowledge-1',
            scope: 'run:fleet_flow',
            entry: {
              kind: 'summary',
              text: 'fleet dispatch completed',
            },
          },
          {
            type: 'action',
            id: 'finish',
            toolRef: 'tasks.run',
            input: { stage: 'finish' },
          },
        ],
      },
    })

    expect('errors' in result).toBe(false)
    if ('errors' in result) {
      throw new Error('expected compile success')
    }

    expect(result.target).toBe('skill-chain')

    const chain = result.artifact as SkillChain
    expect(chain.steps).toHaveLength(2)

    const artifactRecord = result.artifact as Record<string, unknown>
    const fleetStepsRaw = artifactRecord['fleetSteps']
    expect(Array.isArray(fleetStepsRaw)).toBe(true)
    if (!Array.isArray(fleetStepsRaw)) {
      throw new Error('expected artifact.fleetSteps array')
    }

    const fleetSteps = fleetStepsRaw as LoweredFleetStep[]
    expect(fleetSteps).toHaveLength(3)

    const dispatch = fleetSteps[0]
    const gather = fleetSteps[1]
    const knowledgeWrite = fleetSteps[2]
    if (dispatch === undefined || gather === undefined || knowledgeWrite === undefined) {
      throw new Error('expected dispatch, gather, and knowledge.write steps')
    }

    expect(dispatch).toEqual({
      id: 'dispatch-1',
      kind: 'fleet.dispatch',
      factory: FLEET_SUPERVISOR_FACTORY,
      handler: 'run',
      payload: {
        type: 'fleet.dispatch',
        mode: 'contract-net',
        policy: 'contract-net',
        repos: ['repo-a', 'repo-b'],
        task: { goal: 'Review pull request' },
        onContractChange: 'reroute',
        output: 'dispatch_result',
      },
    })

    expect(gather).toEqual({
      id: 'gather-1',
      kind: 'fleet.gather',
      factory: FLEET_SUPERVISOR_FACTORY,
      handler: 'gather',
      payload: {
        type: 'fleet.gather',
        source: 'dispatch_result',
        strategy: 'merge',
        output: 'gathered_result',
      },
    })

    expect(knowledgeWrite).toEqual({
      id: 'knowledge-1',
      kind: 'knowledge.write',
      factory: KNOWLEDGE_STORE_FACTORY,
      handler: 'append',
      payload: {
        type: 'knowledge.write',
        scope: 'run:fleet_flow',
        entry: {
          kind: 'summary',
          text: 'fleet dispatch completed',
        },
      },
    })

    const executor = new ScriptedExecutor({
      [`${FLEET_SUPERVISOR_FACTORY}#run`]: (payload) => ({ event: 'dispatched', payload }),
      [`${FLEET_SUPERVISOR_FACTORY}#gather`]: (payload) => ({ event: 'gathered', payload }),
      [`${KNOWLEDGE_STORE_FACTORY}#append`]: (payload) => ({ event: 'written', payload }),
    })

    const executionResults = await executor.run(fleetSteps)
    expect(executionResults).toEqual([
      {
        event: 'dispatched',
        payload: dispatch.payload,
      },
      {
        event: 'gathered',
        payload: gather.payload,
      },
      {
        event: 'written',
        payload: knowledgeWrite.payload,
      },
    ])

    expect(executor.getCalls()).toEqual([
      {
        factory: FLEET_SUPERVISOR_FACTORY,
        handler: 'run',
        payload: dispatch.payload,
      },
      {
        factory: FLEET_SUPERVISOR_FACTORY,
        handler: 'gather',
        payload: gather.payload,
      },
      {
        factory: KNOWLEDGE_STORE_FACTORY,
        handler: 'append',
        payload: knowledgeWrite.payload,
      },
    ])
  })
})
