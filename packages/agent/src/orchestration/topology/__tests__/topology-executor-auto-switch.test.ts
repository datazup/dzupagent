import { AIMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseMessage } from '@langchain/core/messages'
import { describe, expect, it, vi } from 'vitest'
import { DzupAgent } from '../../../agent/dzip-agent.js'
import { TopologyExecutor } from '../topology-executor.js'
import type { TopologyType } from '../topology-types.js'

function createAgent(id: string, content: string): DzupAgent {
  const model = {
    invoke: vi.fn(async (_messages: BaseMessage[]) => (
      new AIMessage({ content, response_metadata: {} })
    )),
    bindTools: vi.fn(function (this: BaseChatModel) {
      return this
    }),
    _modelType: () => 'base_chat_model',
    _llmType: () => 'mock',
  } as unknown as BaseChatModel

  return new DzupAgent({
    id,
    description: `Agent ${id}`,
    instructions: `You are ${id}.`,
    model,
  })
}

function createFailOnceAgent(id: string, failure: string, content: string): {
  agent: DzupAgent
  invoke: ReturnType<typeof vi.fn>
} {
  let callCount = 0
  const invoke = vi.fn(async (_messages: BaseMessage[]) => {
    callCount++
    if (callCount === 1) {
      throw new Error(failure)
    }

    return new AIMessage({ content, response_metadata: {} })
  })

  const model = {
    invoke,
    bindTools: vi.fn(function (this: BaseChatModel) {
      return this
    }),
    _modelType: () => 'base_chat_model',
    _llmType: () => 'mock',
  } as unknown as BaseChatModel

  return {
    agent: new DzupAgent({
      id,
      description: `Fail-once agent ${id}`,
      instructions: `You are ${id}.`,
      model,
    }),
    invoke,
  }
}

function createAlwaysFailAgent(id: string, failure: string): DzupAgent {
  const model = {
    invoke: vi.fn(async () => {
      throw new Error(failure)
    }),
    bindTools: vi.fn(function (this: BaseChatModel) {
      return this
    }),
    _modelType: () => 'base_chat_model',
    _llmType: () => 'mock',
  } as unknown as BaseChatModel

  return new DzupAgent({
    id,
    description: `Always failing agent ${id}`,
    instructions: `You are ${id}.`,
    model,
  })
}

describe('TopologyExecutor auto-switch thrown topology failures', () => {
  const thrownTopologies = [
    ['pipeline', 'star'],
    ['star', 'mesh'],
    ['hierarchical', 'star'],
  ] as const satisfies ReadonlyArray<readonly [TopologyType, TopologyType]>

  it.each(thrownTopologies)(
    'retries a recommended alternate topology after %s throws with auto-switch enabled',
    async (topology, expectedRetryTopology) => {
      const failing = createFailOnceAgent(
        'fails-once',
        `${topology} exploded`,
        `${topology} recovered`,
      )
      const agents = [
        failing.agent,
        createAgent('stable', 'stable output'),
      ]

      const { result, metrics } = await TopologyExecutor.execute({
        agents,
        task: `Run ${topology}`,
        topology,
        autoSwitch: true,
        errorThreshold: 0.5,
      })

      expect(failing.invoke).toHaveBeenCalledTimes(2)
      expect(metrics.topology).toBe(expectedRetryTopology)
      expect(metrics.switchedFrom).toBe(topology)
      expect(metrics.errorCount).toBe(0)
      expect(String(result)).toContain(topology === 'star' ? 'stable output' : `${topology} recovered`)
    },
  )

  it.each(thrownTopologies)(
    'surfaces the original %s thrown error when auto-switch is disabled',
    async (topology) => {
      const agents = [
        createAlwaysFailAgent('fails', `${topology} original failure`),
        createAgent('stable', 'stable output'),
      ]

      await expect(
        TopologyExecutor.execute({
          agents,
          task: `Run ${topology}`,
          topology,
          autoSwitch: false,
        }),
      ).rejects.toThrow(`${topology} original failure`)
    },
  )
})
