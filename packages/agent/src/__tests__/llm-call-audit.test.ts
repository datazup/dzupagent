/**
 * RF-12 — LLM-call audit log integration tests.
 *
 * Verifies that every model invocation made by `DzupAgent.generate()` is
 * recorded in the configured `auditStore`, on both success and failure
 * paths, with the expected metadata (agent id, model, tokens, duration,
 * success flag, error message).
 *
 * Also asserts that audit-sink errors never disturb the run (fire-and-
 * forget contract) and that the entry shape stays stable for compliance
 * pipelines downstream.
 */
import { describe, it, expect, vi } from 'vitest'
import { AIMessage, HumanMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { DzupAgent } from '../agent/dzip-agent.js'
import {
  InMemoryAuditStore,
  type LlmCallAuditEntry,
  type LlmCallAuditSink,
} from '../observability/llm-call-audit.js'

function createMockModel(overrides?: {
  invoke?: () => Promise<AIMessage>
  modelId?: string
}): BaseChatModel {
  return {
    invoke: vi.fn(
      overrides?.invoke ??
        (() => {
          const msg = new AIMessage('hello')
          ;(msg as AIMessage & { usage_metadata: Record<string, unknown> }).usage_metadata = {
            input_tokens: 11,
            output_tokens: 7,
            total_tokens: 18,
          }
          return Promise.resolve(msg)
        }),
    ),
    bindTools: vi.fn().mockReturnThis(),
    model: overrides?.modelId ?? 'test-model',
  } as unknown as BaseChatModel
}

describe('LLM-call audit log (RF-12)', () => {
  it('records a successful model invocation with token usage and duration', async () => {
    const auditStore = new InMemoryAuditStore()
    const agent = new DzupAgent({
      id: 'audit-agent',
      instructions: 'You are a test agent.',
      model: createMockModel(),
      auditStore,
    })

    await agent.generate([new HumanMessage('hi')])

    expect(auditStore.entries).toHaveLength(1)
    const entry = auditStore.entries[0]!
    expect(entry.agentId).toBe('audit-agent')
    expect(entry.model).toBe('test-model')
    expect(entry.success).toBe(true)
    expect(entry.error).toBeUndefined()
    expect(entry.inputTokens).toBe(11)
    expect(entry.outputTokens).toBe(7)
    expect(entry.durationMs).toBeGreaterThanOrEqual(0)
    expect(entry.timestamp).toBeGreaterThan(0)
  })

  it('records a failed model invocation with error message', async () => {
    const auditStore = new InMemoryAuditStore()
    const agent = new DzupAgent({
      id: 'audit-agent-fail',
      instructions: 'You are a test agent.',
      model: createMockModel({
        invoke: () => Promise.reject(new Error('upstream timeout')),
      }),
      auditStore,
    })

    await expect(agent.generate([new HumanMessage('hi')])).rejects.toThrow(
      'upstream timeout',
    )

    expect(auditStore.entries).toHaveLength(1)
    const entry = auditStore.entries[0]!
    expect(entry.agentId).toBe('audit-agent-fail')
    expect(entry.success).toBe(false)
    expect(entry.error).toBe('upstream timeout')
    expect(entry.inputTokens).toBe(0)
    expect(entry.outputTokens).toBe(0)
  })

  it('records the configured runId when provided via GenerateOptions', async () => {
    const auditStore = new InMemoryAuditStore()
    const agent = new DzupAgent({
      id: 'run-id-agent',
      instructions: 'You are a test agent.',
      model: createMockModel(),
      auditStore,
    })

    await agent.generate([new HumanMessage('hi')], { runId: 'run-42' })

    expect(auditStore.entries).toHaveLength(1)
    expect(auditStore.entries[0]!.runId).toBe('run-42')
  })

  it('does not propagate audit-sink errors into the run', async () => {
    const failingSink: LlmCallAuditSink = {
      record: () => {
        throw new Error('sink offline')
      },
    }
    const agent = new DzupAgent({
      id: 'sink-error-agent',
      instructions: 'You are a test agent.',
      model: createMockModel(),
      auditStore: failingSink,
    })

    const result = await agent.generate([new HumanMessage('hi')])
    expect(result.content).toBe('hello')
  })

  it('supports async sinks without blocking the run result', async () => {
    const recorded: LlmCallAuditEntry[] = []
    const asyncSink: LlmCallAuditSink = {
      record: async (entry) => {
        await new Promise((resolve) => setTimeout(resolve, 0))
        recorded.push(entry)
      },
    }
    const agent = new DzupAgent({
      id: 'async-sink-agent',
      instructions: 'You are a test agent.',
      model: createMockModel(),
      auditStore: asyncSink,
    })

    await agent.generate([new HumanMessage('hi')])
    // Audit is fire-and-forget; let the microtask drain.
    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.success).toBe(true)
  })

  it('does nothing when no auditStore is configured', async () => {
    const agent = new DzupAgent({
      id: 'no-sink-agent',
      instructions: 'You are a test agent.',
      model: createMockModel(),
    })

    const result = await agent.generate([new HumanMessage('hi')])
    expect(result.content).toBe('hello')
  })
})
