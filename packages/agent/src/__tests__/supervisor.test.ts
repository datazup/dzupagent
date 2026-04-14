/**
 * Tests for the supervisor orchestration pattern.
 *
 * Uses a mock chat model that simulates LLM function calling
 * so we can verify the full tool-wiring flow without a real LLM.
 */
import { describe, it, expect, vi } from 'vitest'
import { AIMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseMessage } from '@langchain/core/messages'
import { DzupAgent } from '../agent/dzip-agent.js'
import { AgentOrchestrator } from '../orchestration/orchestrator.js'
import { OrchestrationError } from '../orchestration/orchestration-error.js'

/**
 * Create a mock BaseChatModel that returns a sequence of AIMessage responses.
 * Each response can optionally include tool_calls to simulate function calling.
 */
function createMockModel(
  responses: Array<{ content: string; tool_calls?: Array<{ id: string; name: string; args: Record<string, unknown> }> }>,
): BaseChatModel {
  let callIndex = 0
  const invoke = vi.fn(async (_messages: BaseMessage[]) => {
    const resp = responses[callIndex] ?? responses[responses.length - 1]!
    callIndex++
    const msg = new AIMessage({
      content: resp.content,
      tool_calls: resp.tool_calls?.map(tc => ({
        id: tc.id,
        name: tc.name,
        args: tc.args,
        type: 'tool_call' as const,
      })),
      response_metadata: {},
    })
    return msg
  })

  // Minimal mock shape that satisfies what DzupAgent needs
  return {
    invoke,
    bindTools: vi.fn(function (this: BaseChatModel, _tools: unknown[]) {
      // Return self -- tools are tracked but the mock controls responses
      return this
    }),
    // Required by BaseChatModel duck-typing in our code
    _modelType: () => 'base_chat_model',
    _llmType: () => 'mock',
  } as unknown as BaseChatModel
}

function createAgent(id: string, description: string, model: BaseChatModel): DzupAgent {
  return new DzupAgent({
    id,
    description,
    instructions: `You are ${id}.`,
    model,
  })
}

describe('AgentOrchestrator.supervisor', () => {
  it('delegates to specialists via tool calling and returns synthesized result', async () => {
    // Manager model: first call invokes specialist tool, second call returns final answer
    const managerModel = createMockModel([
      {
        content: '',
        tool_calls: [{ id: 'call_1', name: 'agent-db-specialist', args: { task: 'Design the schema' } }],
      },
      {
        content: 'Final answer: the schema is designed with users and posts tables.',
      },
    ])

    // Specialist model: returns a result when invoked
    const dbModel = createMockModel([
      { content: 'Schema: users(id, name), posts(id, user_id, content)' },
    ])

    const manager = createAgent('manager', 'Orchestrates work', managerModel)
    const dbSpecialist = createAgent('db-specialist', 'Database schema expert', dbModel)

    const result = await AgentOrchestrator.supervisor({
      manager,
      specialists: [dbSpecialist],
      task: 'Build a blog platform',
    })

    expect(result.content).toContain('schema is designed')
    expect(result.availableSpecialists).toEqual(['db-specialist'])
    expect(result.filteredSpecialists).toEqual([])

    // Verify the manager model had bindTools called with the specialist tool
    expect(managerModel.bindTools).toHaveBeenCalled()
    const boundTools = (managerModel.bindTools as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Array<{ name: string }>
    const toolNames = boundTools.map(t => t.name)
    expect(toolNames).toContain('agent-db-specialist')
  })

  it('supports multiple specialists', async () => {
    const managerModel = createMockModel([
      {
        content: '',
        tool_calls: [
          { id: 'call_1', name: 'agent-frontend', args: { task: 'Build UI' } },
        ],
      },
      {
        content: '',
        tool_calls: [
          { id: 'call_2', name: 'agent-backend', args: { task: 'Build API' } },
        ],
      },
      {
        content: 'Complete: UI and API built.',
      },
    ])

    const feModel = createMockModel([{ content: 'React components ready' }])
    const beModel = createMockModel([{ content: 'Express routes ready' }])

    const manager = createAgent('supervisor', 'Manages team', managerModel)
    const frontend = createAgent('frontend', 'Frontend developer', feModel)
    const backend = createAgent('backend', 'Backend developer', beModel)

    const result = await AgentOrchestrator.supervisor({
      manager,
      specialists: [frontend, backend],
      task: 'Build a dashboard',
    })

    expect(result.content).toContain('UI and API built')
    expect(result.availableSpecialists).toEqual(['frontend', 'backend'])
  })

  it('throws OrchestrationError on empty specialists array', async () => {
    const model = createMockModel([{ content: 'hello' }])
    const manager = createAgent('mgr', 'Manager', model)

    await expect(
      AgentOrchestrator.supervisor({
        manager,
        specialists: [],
        task: 'Do something',
      }),
    ).rejects.toThrow(OrchestrationError)

    try {
      await AgentOrchestrator.supervisor({
        manager,
        specialists: [],
        task: 'Do something',
      })
    } catch (err) {
      expect(err).toBeInstanceOf(OrchestrationError)
      expect((err as OrchestrationError).pattern).toBe('supervisor')
    }
  })

  it('respects abort signal', async () => {
    const model = createMockModel([{ content: 'hello' }])
    const manager = createAgent('mgr', 'Manager', model)
    const specialist = createAgent('spec', 'Specialist', model)

    const controller = new AbortController()
    controller.abort()

    await expect(
      AgentOrchestrator.supervisor({
        manager,
        specialists: [specialist],
        task: 'Do something',
        signal: controller.signal,
      }),
    ).rejects.toThrow(OrchestrationError)
  })

  it('filters unresponsive specialists with healthCheck enabled', async () => {
    const managerModel = createMockModel([
      { content: 'Done with healthy specialist only.' },
    ])
    const healthyModel = createMockModel([{ content: 'I am healthy' }])

    const manager = createAgent('mgr', 'Manager', managerModel)
    const healthy = createAgent('healthy-agent', 'Healthy specialist', healthyModel)

    // Create a broken agent whose asTool() will throw
    const brokenAgent = createAgent('broken-agent', 'Broken specialist', healthyModel)
    // Override asTool to simulate failure
    vi.spyOn(brokenAgent, 'asTool').mockRejectedValue(new Error('agent unhealthy'))

    const result = await AgentOrchestrator.supervisor({
      manager,
      specialists: [healthy, brokenAgent],
      task: 'Do something',
      healthCheck: true,
    })

    expect(result.availableSpecialists).toEqual(['healthy-agent'])
    expect(result.filteredSpecialists).toEqual(['broken-agent'])
  })

  it('throws when all specialists fail health check', async () => {
    const managerModel = createMockModel([{ content: 'hello' }])
    const manager = createAgent('mgr', 'Manager', managerModel)

    const brokenModel = createMockModel([{ content: 'ok' }])
    const broken = createAgent('broken', 'Broken specialist', brokenModel)
    vi.spyOn(broken, 'asTool').mockRejectedValue(new Error('unhealthy'))

    await expect(
      AgentOrchestrator.supervisor({
        manager,
        specialists: [broken],
        task: 'Do something',
        healthCheck: true,
      }),
    ).rejects.toThrow('All specialists failed health check')
  })

  it('supports legacy positional arguments (backward compat)', async () => {
    const managerModel = createMockModel([
      { content: 'Legacy result' },
    ])
    const specModel = createMockModel([{ content: 'spec output' }])

    const manager = createAgent('mgr', 'Manager', managerModel)
    const specialist = createAgent('spec', 'Specialist', specModel)

    // Legacy signature: supervisor(manager, specialists, task) => string
    const result = await AgentOrchestrator.supervisor(manager, [specialist], 'Do stuff')
    expect(typeof result).toBe('string')
    expect(result).toBe('Legacy result')
  })
})

describe('OrchestrationError', () => {
  it('captures pattern and context', () => {
    const err = new OrchestrationError('test error', 'supervisor', { foo: 'bar' })
    expect(err.name).toBe('OrchestrationError')
    expect(err.message).toBe('test error')
    expect(err.pattern).toBe('supervisor')
    expect(err.context).toEqual({ foo: 'bar' })
    expect(err).toBeInstanceOf(Error)
  })
})
