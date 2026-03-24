import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { SubAgentSpawner } from '../subagent/subagent-spawner.js'
import { REACT_DEFAULTS } from '../subagent/subagent-types.js'
import type { SubAgentConfig } from '../subagent/subagent-types.js'
import type { ModelRegistry } from '../llm/model-registry.js'

// ---------------------------------------------------------------------------
// Helpers to create mock objects
// ---------------------------------------------------------------------------

function createMockRegistry(model: BaseChatModel): ModelRegistry {
  return {
    getModel: vi.fn().mockReturnValue(model),
  } as unknown as ModelRegistry
}

function createMockModel(responses: AIMessage[]): BaseChatModel & { bindTools: ReturnType<typeof vi.fn> } {
  let callIdx = 0
  const invoke = vi.fn().mockImplementation(async () => {
    const resp = responses[callIdx] ?? responses[responses.length - 1]!
    callIdx++
    return resp
  })

  const boundModel = { invoke, model: 'test-model' } as unknown as BaseChatModel
  const bindTools = vi.fn().mockReturnValue(boundModel)

  return Object.assign(boundModel, { invoke, bindTools, model: 'test-model' }) as unknown as BaseChatModel & { bindTools: ReturnType<typeof vi.fn> }
}

function createMockTool(name: string, resultOrFn: string | ((args: Record<string, unknown>) => string | Promise<string>)): StructuredToolInterface {
  return {
    name,
    invoke: vi.fn().mockImplementation(async (args: Record<string, unknown>) => {
      if (typeof resultOrFn === 'function') return resultOrFn(args)
      return resultOrFn
    }),
  } as unknown as StructuredToolInterface
}

function baseConfig(overrides?: Partial<SubAgentConfig>): SubAgentConfig {
  return {
    name: 'test-agent',
    description: 'A test sub-agent',
    systemPrompt: 'You are a test agent.',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SubAgentSpawner', () => {
  describe('spawn() — single-turn (backwards compat)', () => {
    it('invokes model once and returns result', async () => {
      const aiMsg = new AIMessage({ content: 'Hello world' })
      const model = createMockModel([aiMsg])
      const registry = createMockRegistry(model)
      const spawner = new SubAgentSpawner(registry)

      const result = await spawner.spawn(baseConfig(), 'Do something')

      expect(result.messages).toHaveLength(1)
      expect(result.messages[0]).toBe(aiMsg)
      expect(result.metadata['agentName']).toBe('test-agent')
    })

    it('passes parent files as context', async () => {
      const aiMsg = new AIMessage({ content: 'Done' })
      const model = createMockModel([aiMsg])
      const registry = createMockRegistry(model)
      const spawner = new SubAgentSpawner(registry)

      await spawner.spawn(baseConfig(), 'Read files', { 'src/main.ts': 'console.log("hi")' })

      const invokeCall = (model.invoke as ReturnType<typeof vi.fn>).mock.calls[0]!
      const humanMsg = invokeCall[0][1] as HumanMessage
      expect(typeof humanMsg.content === 'string' && humanMsg.content.includes('src/main.ts')).toBe(true)
    })
  })

  describe('spawnReAct() — tool-calling loop', () => {
    it('runs a basic loop: tool call then final answer', async () => {
      const toolCallMsg = new AIMessage({
        content: '',
        tool_calls: [{ id: 'call_1', name: 'search', args: { query: 'foo' } }],
      })
      const finalMsg = new AIMessage({ content: 'Found it!' })
      const model = createMockModel([toolCallMsg, finalMsg])
      const registry = createMockRegistry(model)

      const searchTool = createMockTool('search', 'result: bar')

      const spawner = new SubAgentSpawner(registry)
      const result = await spawner.spawnReAct(
        baseConfig({ tools: [searchTool] }),
        'Find something',
      )

      // Messages: system, human, AI(tool_call), ToolMessage, AI(final)
      expect(result.messages).toHaveLength(5)
      expect(result.messages[2]).toBe(toolCallMsg)
      expect(result.messages[3]).toBeInstanceOf(ToolMessage)
      expect(result.messages[4]).toBe(finalMsg)
      expect(result.usage?.llmCalls).toBe(2)
      expect(result.hitIterationLimit).toBe(false)
    })

    it('stops at maxIterations and sets hitIterationLimit', async () => {
      // Model always returns a tool call — never a final answer
      const toolCallMsg = new AIMessage({
        content: '',
        tool_calls: [{ id: 'call_loop', name: 'search', args: { q: 'x' } }],
      })
      const model = createMockModel([toolCallMsg])
      const registry = createMockRegistry(model)
      const searchTool = createMockTool('search', 'still looking...')

      const spawner = new SubAgentSpawner(registry)
      const result = await spawner.spawnReAct(
        baseConfig({ tools: [searchTool], maxIterations: 3 }),
        'Search forever',
      )

      expect(result.usage?.llmCalls).toBe(3)
      expect(result.hitIterationLimit).toBe(true)
    })

    it('handles tool not found gracefully', async () => {
      const toolCallMsg = new AIMessage({
        content: '',
        tool_calls: [{ id: 'call_missing', name: 'nonexistent', args: {} }],
      })
      const finalMsg = new AIMessage({ content: 'Sorry, could not find tool' })
      const model = createMockModel([toolCallMsg, finalMsg])
      const registry = createMockRegistry(model)

      const spawner = new SubAgentSpawner(registry)
      const result = await spawner.spawnReAct(
        baseConfig({ tools: [] }),
        'Try missing tool',
      )

      const toolMsg = result.messages.find(m => m instanceof ToolMessage) as ToolMessage
      expect(toolMsg).toBeDefined()
      expect(typeof toolMsg.content === 'string' && toolMsg.content.includes('not found')).toBe(true)
    })

    it('handles tool execution errors non-fatally', async () => {
      const toolCallMsg = new AIMessage({
        content: '',
        tool_calls: [{ id: 'call_err', name: 'buggy', args: {} }],
      })
      const finalMsg = new AIMessage({ content: 'Handled the error' })
      const model = createMockModel([toolCallMsg, finalMsg])
      const registry = createMockRegistry(model)

      const buggyTool = createMockTool('buggy', () => {
        throw new Error('Tool exploded')
      })

      const spawner = new SubAgentSpawner(registry)
      const result = await spawner.spawnReAct(
        baseConfig({ tools: [buggyTool] }),
        'Run buggy tool',
      )

      const toolMsg = result.messages.find(m => m instanceof ToolMessage) as ToolMessage
      expect(typeof toolMsg.content === 'string' && toolMsg.content.includes('Tool exploded')).toBe(true)
      // Should still get the final response
      expect(result.messages[result.messages.length - 1]).toBe(finalMsg)
    })

    it('extracts files from write_file tool calls', async () => {
      const toolCallMsg = new AIMessage({
        content: '',
        tool_calls: [{
          id: 'call_write',
          name: 'write_file',
          args: { path: '/src/index.ts', content: 'export {}' },
        }],
      })
      const finalMsg = new AIMessage({ content: 'File written' })
      const model = createMockModel([toolCallMsg, finalMsg])
      const registry = createMockRegistry(model)

      const writeTool = createMockTool('write_file', 'OK')

      const spawner = new SubAgentSpawner(registry)
      const result = await spawner.spawnReAct(
        baseConfig({ tools: [writeTool] }),
        'Write a file',
      )

      expect(result.files['/src/index.ts']).toBe('export {}')
    })

    it('respects max depth to prevent infinite recursion', async () => {
      const model = createMockModel([new AIMessage({ content: 'ok' })])
      const registry = createMockRegistry(model)

      const spawner = new SubAgentSpawner(registry, { maxDepth: 2 })
      const result = await spawner.spawnReAct(
        baseConfig({ _depth: 2 }),
        'Should be blocked',
      )

      expect(result.metadata['stoppedReason']).toBe('max_depth')
      expect(result.usage).toBeUndefined()
    })

    it('uses default maxDepth of 3 from REACT_DEFAULTS', () => {
      expect(REACT_DEFAULTS.maxDepth).toBe(3)
      expect(REACT_DEFAULTS.maxIterations).toBe(10)
      expect(REACT_DEFAULTS.timeoutMs).toBe(120_000)
    })

    it('tracks cumulative token usage across iterations', async () => {
      const mkAiMsg = (toolCall: boolean): AIMessage => {
        const msg = toolCall
          ? new AIMessage({
              content: '',
              tool_calls: [{ id: `call_${Math.random()}`, name: 'search', args: {} }],
            })
          : new AIMessage({ content: 'done' })
        // Simulate response_metadata with usage
        ;(msg as AIMessage & { response_metadata: Record<string, unknown> }).response_metadata = {
          usage: { input_tokens: 100, output_tokens: 50 },
        }
        return msg
      }

      const model = createMockModel([mkAiMsg(true), mkAiMsg(false)])
      const registry = createMockRegistry(model)
      const searchTool = createMockTool('search', 'found')

      const spawner = new SubAgentSpawner(registry)
      const result = await spawner.spawnReAct(
        baseConfig({ tools: [searchTool] }),
        'Search',
      )

      expect(result.usage?.inputTokens).toBe(200)
      expect(result.usage?.outputTokens).toBe(100)
      expect(result.usage?.llmCalls).toBe(2)
    })
  })

  describe('spawnAndMerge()', () => {
    it('uses spawnReAct when tools are provided', async () => {
      const toolCallMsg = new AIMessage({
        content: '',
        tool_calls: [{
          id: 'call_w',
          name: 'write_file',
          args: { path: 'new.ts', content: 'new content' },
        }],
      })
      const finalMsg = new AIMessage({ content: 'done' })
      const model = createMockModel([toolCallMsg, finalMsg])
      const registry = createMockRegistry(model)
      const writeTool = createMockTool('write_file', 'OK')

      const spawner = new SubAgentSpawner(registry)
      const { result, mergedFiles } = await spawner.spawnAndMerge(
        baseConfig({ tools: [writeTool] }),
        'Create file',
        { 'existing.ts': 'old content' },
      )

      expect(result.files['new.ts']).toBe('new content')
      expect(mergedFiles['existing.ts']).toBe('old content')
      expect(mergedFiles['new.ts']).toBe('new content')
    })

    it('falls back to spawn when no tools provided', async () => {
      const aiMsg = new AIMessage({ content: 'Single turn response' })
      const model = createMockModel([aiMsg])
      const registry = createMockRegistry(model)

      const spawner = new SubAgentSpawner(registry)
      const { result } = await spawner.spawnAndMerge(
        baseConfig(),
        'Simple task',
        { 'existing.ts': 'content' },
      )

      expect(result.messages).toHaveLength(1)
      // No usage tracked in single-turn mode
      expect(result.usage).toBeUndefined()
    })
  })
})
