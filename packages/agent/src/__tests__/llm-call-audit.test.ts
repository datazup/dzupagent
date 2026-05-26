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
import { createEventBus, type DzupEvent } from '@dzupagent/core'
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

  it('emits audit:sink_failure when audit sink rejects, with redacted message', async () => {
    const failingSink: LlmCallAuditSink = {
      record: () => {
        throw new Error('sink offline for token AKIAIOSFODNN7EXAMPLE and alice@example.com')
      },
    }
    const bus = createEventBus()
    const events: DzupEvent[] = []
    bus.onAny((event) => events.push(event))
    const agent = new DzupAgent({
      id: 'sink-failure-event-agent',
      instructions: 'You are a test agent.',
      model: createMockModel(),
      auditStore: failingSink,
      eventBus: bus,
    })

    const result = await agent.generate([new HumanMessage('hi')], { runId: 'run-audit-err' })
    expect(result.content).toBe('hello')

    const sinkFailure = events.find((event) => event.type === 'audit:sink_failure')
    expect(sinkFailure).toBeDefined()
    if (sinkFailure?.type === 'audit:sink_failure') {
      expect(sinkFailure.sink).toBe('llm-call-audit')
      expect(sinkFailure.agentId).toBe('sink-failure-event-agent')
      expect(sinkFailure.runId).toBe('run-audit-err')
      expect(sinkFailure.redactionMode).toBe('secrets-and-pii')
      expect(sinkFailure.message).not.toContain('AKIAIOSFODNN7EXAMPLE')
      expect(sinkFailure.message).not.toContain('alice@example.com')
    }
  })

  it('supports async sinks without blocking the run result', async () => {
    const recorded: LlmCallAuditEntry[] = []
    const asyncSink: LlmCallAuditSink = {
      record: async (entry) => {
        await Promise.resolve()
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

  it('redacts audit prompt/response payloads before writing to auditStore', async () => {
    const auditStore = new InMemoryAuditStore()
    const agent = new DzupAgent({
      id: 'audit-redaction-agent',
      instructions: 'You are a test agent.',
      model: createMockModel({
        invoke: () => Promise.resolve(new AIMessage('contact me at alice@example.com token glpat-abcdefghij1234567890')),
      }),
      auditStore,
    })

    await agent.generate([new HumanMessage('my token is AKIAIOSFODNN7EXAMPLE and email is bob@example.com')])

    expect(auditStore.entries).toHaveLength(1)
    const entry = auditStore.entries[0]!
    expect(entry.prompt).toBeDefined()
    expect(entry.response).toBeDefined()
    expect(entry.promptSnippet).toBeDefined()
    expect(entry.responseSnippet).toBeDefined()
    expect(entry.prompt).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(entry.prompt).not.toContain('bob@example.com')
    expect(entry.response).not.toContain('glpat-abcdefghij1234567890')
    expect(entry.response).not.toContain('alice@example.com')
  })

  it('can omit full audit payloads while retaining snippets', async () => {
    const auditStore = new InMemoryAuditStore()
    const agent = new DzupAgent({
      id: 'audit-snippet-only-agent',
      instructions: 'You are a test agent.',
      model: createMockModel(),
      auditStore,
      auditRedaction: {
        includeFullPayloads: false,
      },
    })

    await agent.generate([new HumanMessage('hello')])

    expect(auditStore.entries).toHaveLength(1)
    const entry = auditStore.entries[0]!
    expect(entry.prompt).toBeUndefined()
    expect(entry.response).toBeUndefined()
    expect(entry.promptSnippet).toBeDefined()
    expect(entry.responseSnippet).toBeDefined()
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
