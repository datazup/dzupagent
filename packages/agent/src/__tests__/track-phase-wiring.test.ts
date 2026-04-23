/**
 * Tests for Session S: `plugin.trackPhase()` wiring in @dzupagent/agent.
 *
 * Two phases are charged against the token lifecycle plugin so lifecycle
 * reports can distinguish prompt-build, LLM I/O, and tool-output ingestion:
 *
 *   - `'prompt'`       — charged once from `prepareRunState` after
 *                        messages are prepared (or rehydrated on resume).
 *   - `'tool-result'`  — charged from `executeGenerateRun` (via the
 *                        `onToolResult` hook) and from the streaming path
 *                        in `DzupAgent.stream()` as tool results accumulate.
 *
 * The tests below verify:
 *   1. `trackPhase('prompt', …)` fires during `prepareRunState` with the
 *      estimated token count of the final prepared transcript.
 *   2. `trackPhase('tool-result', …)` fires during `executeGenerateRun`
 *      for every tool result surfaced by the tool loop.
 *   3. The plugin's underlying manager reflects both phases in its
 *      per-phase breakdown report.
 */
import { describe, it, expect, vi } from 'vitest'
import { AIMessage, HumanMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseMessage } from '@langchain/core/messages'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { TokenLifecycleManager, createTokenBudget } from '@dzupagent/context'
import type { DzupAgentConfig, GenerateOptions } from '../agent/agent-types.js'
import type { ToolLoopResult, StopReason } from '../agent/tool-loop.js'
import type { AgentLoopPlugin } from '../token-lifecycle-wiring.js'

// ---------------------------------------------------------------------------
// Mock runToolLoop so we can drive `onToolResult` synthetically and avoid
// exercising the real LLM/tool-loop machinery inside these unit tests.
// ---------------------------------------------------------------------------

const { mockRunToolLoop } = vi.hoisted(() => ({
  mockRunToolLoop: vi.fn(),
}))

vi.mock('../agent/tool-loop.js', () => ({
  runToolLoop: mockRunToolLoop,
}))

// Import AFTER mocks are installed.
import {
  prepareRunState,
  executeGenerateRun,
  type PreparedRunState,
} from '../agent/run-engine.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSpyPlugin(): AgentLoopPlugin & {
  trackPhase: ReturnType<typeof vi.fn>
} {
  return {
    onUsage: vi.fn(),
    trackPhase: vi.fn(),
    maybeCompress: vi.fn(async (messages, _model, existingSummary = null) => ({
      messages,
      summary: existingSummary,
      compressed: false,
    })),
    shouldHalt: vi.fn(() => false),
    status: 'ok',
    hooks: null,
    manager: null,
    reset: vi.fn(),
    cleanup: vi.fn(),
  } as unknown as AgentLoopPlugin & {
    trackPhase: ReturnType<typeof vi.fn>
  }
}

function mockTool(name: string): StructuredToolInterface {
  return {
    name,
    description: `Mock ${name}`,
    schema: {} as never,
    lc_namespace: [] as string[],
    invoke: vi.fn(async () => 'ok'),
  } as unknown as StructuredToolInterface
}

function mockModel(): BaseChatModel {
  return {
    invoke: vi.fn(async () => new AIMessage('done')),
  } as unknown as BaseChatModel
}

function basePrepareParams(
  plugin: AgentLoopPlugin,
  overrides: Partial<Parameters<typeof prepareRunState>[0]> = {},
) {
  const tools = [mockTool('read_file')]
  const model = mockModel()
  return {
    config: {
      id: 'test-agent',
      instructions: 'You are a test agent.',
      model: 'gpt-4' as const,
      tokenLifecyclePlugin: plugin,
    } satisfies DzupAgentConfig as DzupAgentConfig,
    resolvedModel: model,
    messages: [new HumanMessage('hello')] as BaseMessage[],
    options: undefined as GenerateOptions | undefined,
    prepareMessages: vi.fn(async (msgs: BaseMessage[]) => ({ messages: msgs })),
    getTools: vi.fn(() => tools),
    bindTools: vi.fn((_m: BaseChatModel, _t: StructuredToolInterface[]) => model),
    runBeforeAgentHooks: vi.fn(async () => {}),
    ...overrides,
  }
}

function baseExecuteParams(
  runState: PreparedRunState,
  plugin: AgentLoopPlugin,
  overrides: Partial<Parameters<typeof executeGenerateRun>[0]> = {},
) {
  return {
    agentId: 'test-agent',
    config: {
      id: 'test-agent',
      instructions: 'You are a test agent.',
      model: 'gpt-4',
      tokenLifecyclePlugin: plugin,
    } as DzupAgentConfig,
    options: undefined as GenerateOptions | undefined,
    runState,
    invokeModel: vi.fn(async () => new AIMessage('done')),
    transformToolResult: vi.fn(
      async (_n: string, _i: Record<string, unknown>, r: string) => r,
    ),
    maybeUpdateSummary: vi.fn(async () => {}),
    ...overrides,
  }
}

function makeToolLoopResult(overrides: Partial<ToolLoopResult> = {}): ToolLoopResult {
  return {
    messages: [new HumanMessage('hello'), new AIMessage('done')],
    totalInputTokens: 100,
    totalOutputTokens: 50,
    llmCalls: 1,
    hitIterationLimit: false,
    stopReason: 'complete' as StopReason,
    toolStats: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Session S — plugin.trackPhase() wiring', () => {
  it(
    'charges the "prompt" phase during prepareRunState with the estimated prepared-transcript token count',
    async () => {
      const plugin = makeSpyPlugin()
      const longMessage = 'x'.repeat(400) // Non-trivial size so tokens > 0.
      const prepared: BaseMessage[] = [new HumanMessage(longMessage)]

      await prepareRunState(
        basePrepareParams(plugin, {
          prepareMessages: vi.fn(async () => ({ messages: prepared })),
        }),
      )

      // Exactly one 'prompt' charge with a positive token count.
      const promptCalls = plugin.trackPhase.mock.calls.filter(
        ([phase]) => phase === 'prompt',
      )
      expect(promptCalls).toHaveLength(1)
      const [, tokens] = promptCalls[0]!
      expect(typeof tokens).toBe('number')
      expect(tokens).toBeGreaterThan(0)
    },
  )

  it(
    'charges the "tool-result" phase via runToolLoop\'s onToolResult hook during executeGenerateRun',
    async () => {
      const plugin = makeSpyPlugin()
      const runState: PreparedRunState = {
        maxIterations: 5,
        preparedMessages: [new HumanMessage('hi')] as BaseMessage[],
        tools: [],
        toolMap: new Map(),
        model: mockModel(),
      }

      // Capture the config passed to runToolLoop so we can invoke the
      // onToolResult hook directly (simulating tool-call completion).
      mockRunToolLoop.mockImplementationOnce(async (_m, _msgs, _tools, cfg) => {
        const config = cfg as {
          onToolResult?: (name: string, result: string) => void
        }
        config.onToolResult?.('read_file', 'file contents here — many bytes')
        config.onToolResult?.('list_dir', 'a\nb\nc')
        return makeToolLoopResult()
      })

      await executeGenerateRun(baseExecuteParams(runState, plugin))

      const toolResultCalls = plugin.trackPhase.mock.calls.filter(
        ([phase]) => phase === 'tool-result',
      )
      // One trackPhase call per tool result emitted by the loop.
      expect(toolResultCalls).toHaveLength(2)
      for (const [, tokens] of toolResultCalls) {
        expect(typeof tokens).toBe('number')
        expect(tokens).toBeGreaterThan(0)
      }
    },
  )

  it(
    'per-phase breakdown appears in the lifecycle report when a real manager is attached',
    async () => {
      // Wire a real TokenLifecycleManager into a minimal AgentLoopPlugin so
      // we can verify the charges actually land in manager.report.phases.
      const manager = new TokenLifecycleManager({
        budget: createTokenBudget(10_000, 0),
      })
      const plugin: AgentLoopPlugin = {
        onUsage: () => {},
        trackPhase: (phase, tokens) => {
          manager.track(phase, tokens)
        },
        maybeCompress: async (messages, _m, existingSummary = null) => ({
          messages,
          summary: existingSummary,
          compressed: false,
        }),
        shouldHalt: () => false,
        status: 'ok',
        hooks: null,
        manager,
        reset: () => {
          manager.reset()
        },
        cleanup: () => {},
      }

      // Drive a prompt-phase charge via prepareRunState.
      const prepared: BaseMessage[] = [new HumanMessage('prompt text here')]
      const runState = await prepareRunState(
        basePrepareParams(plugin, {
          prepareMessages: vi.fn(async () => ({ messages: prepared })),
        }),
      )

      // Drive a tool-result-phase charge via executeGenerateRun.
      mockRunToolLoop.mockImplementationOnce(async (_m, _msgs, _tools, cfg) => {
        const config = cfg as {
          onToolResult?: (name: string, result: string) => void
        }
        config.onToolResult?.('read_file', 'some tool output bytes')
        return makeToolLoopResult()
      })
      await executeGenerateRun(baseExecuteParams(runState, plugin))

      const phases = manager.report.phases
      const phaseNames = phases.map((p) => p.phase)

      expect(phaseNames).toContain('prompt')
      expect(phaseNames).toContain('tool-result')
      // Per-phase tokens are positive so breakdowns are meaningful.
      for (const p of phases) {
        expect(p.tokens).toBeGreaterThan(0)
      }
      expect(manager.usedTokens).toBeGreaterThan(0)
    },
  )
})
