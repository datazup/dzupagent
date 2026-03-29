import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createEventBus } from '@dzipagent/core'
import type { DzipEvent, DzipEventBus } from '@dzipagent/core'

import { SessionRegistry } from '../session/session-registry.js'
import type {
  ConversationEntry,
  SessionRegistryConfig,
} from '../session/session-registry.js'
import { AdapterRegistry } from '../registry/adapter-registry.js'
import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  TaskDescriptor,
} from '../types.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockAdapter(
  providerId: AdapterProviderId,
  events: AgentEvent[],
): AgentCLIAdapter {
  return {
    providerId,
    async *execute(_input: AgentInput) {
      for (const e of events) yield e
    },
    async *resumeSession(_id: string, _input: AgentInput) {
      /* noop */
    },
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
  }
}

function collectBusEvents(bus: DzipEventBus): DzipEvent[] {
  const events: DzipEvent[] = []
  bus.onAny((e) => events.push(e))
  return events
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionRegistry', () => {
  let registry: SessionRegistry
  let bus: DzipEventBus

  beforeEach(() => {
    bus = createEventBus()
    registry = new SessionRegistry({ eventBus: bus })
  })

  describe('workflow lifecycle', () => {
    it('creates and retrieves a workflow', () => {
      const id = registry.createWorkflow({ project: 'test' })
      expect(id).toBeDefined()
      expect(typeof id).toBe('string')

      const workflow = registry.getWorkflow(id)
      expect(workflow).toBeDefined()
      expect(workflow!.workflowId).toBe(id)
      expect(workflow!.metadata).toEqual({ project: 'test' })
    })

    it('returns undefined for unknown workflow', () => {
      expect(registry.getWorkflow('nonexistent')).toBeUndefined()
    })

    it('lists all workflows', () => {
      registry.createWorkflow()
      registry.createWorkflow()
      expect(registry.listWorkflows()).toHaveLength(2)
    })

    it('deleteWorkflow removes session', () => {
      const id = registry.createWorkflow()
      expect(registry.deleteWorkflow(id)).toBe(true)
      expect(registry.getWorkflow(id)).toBeUndefined()
    })

    it('deleteWorkflow returns false for unknown workflow', () => {
      expect(registry.deleteWorkflow('nonexistent')).toBe(false)
    })
  })

  describe('provider sessions', () => {
    it('links provider sessions to workflow', () => {
      const workflowId = registry.createWorkflow()

      registry.linkProviderSession(workflowId, 'claude', 'claude-sess-1')
      registry.linkProviderSession(workflowId, 'codex', 'codex-sess-1')

      const claudeSession = registry.getProviderSession(workflowId, 'claude')
      expect(claudeSession).toBeDefined()
      expect(claudeSession!.sessionId).toBe('claude-sess-1')
      expect(claudeSession!.providerId).toBe('claude')
      expect(claudeSession!.turnCount).toBe(0)

      const codexSession = registry.getProviderSession(workflowId, 'codex')
      expect(codexSession).toBeDefined()
      expect(codexSession!.sessionId).toBe('codex-sess-1')
    })

    it('updates existing provider session on re-link', () => {
      const workflowId = registry.createWorkflow()
      registry.linkProviderSession(workflowId, 'claude', 'sess-1')
      registry.linkProviderSession(workflowId, 'claude', 'sess-2')

      const session = registry.getProviderSession(workflowId, 'claude')
      expect(session!.sessionId).toBe('sess-2')
    })

    it('throws when linking to non-existent workflow', () => {
      expect(() => {
        registry.linkProviderSession('nonexistent', 'claude', 'sess-1')
      }).toThrow('not found')
    })
  })

  describe('switchProvider', () => {
    it('updates active provider', () => {
      const workflowId = registry.createWorkflow()
      registry.switchProvider(workflowId, 'claude')

      const workflow = registry.getWorkflow(workflowId)
      expect(workflow!.activeProvider).toBe('claude')
    })

    it('emits provider_switched event', () => {
      const emitted = collectBusEvents(bus)
      const workflowId = registry.createWorkflow()
      registry.switchProvider(workflowId, 'codex')

      const switchEvent = emitted.find(
        (e) => e.type === 'session:provider_switched',
      ) as DzipEvent & { to?: string } | undefined
      expect(switchEvent).toBeDefined()
    })
  })

  describe('conversation history', () => {
    it('adds and retrieves conversation history', () => {
      const workflowId = registry.createWorkflow()
      registry.linkProviderSession(workflowId, 'claude', 'sess-1')

      registry.addConversationEntry(workflowId, {
        role: 'user',
        content: 'Hello',
        providerId: 'claude',
        timestamp: new Date(),
      })

      registry.addConversationEntry(workflowId, {
        role: 'assistant',
        content: 'Hi there',
        providerId: 'claude',
        timestamp: new Date(),
      })

      const history = registry.getHistory(workflowId)
      expect(history).toHaveLength(2)
      // getHistory returns most recent first
      expect(history[0]!.content).toBe('Hi there')
      expect(history[1]!.content).toBe('Hello')
    })

    it('respects limit parameter in getHistory', () => {
      const workflowId = registry.createWorkflow()

      for (let i = 0; i < 5; i++) {
        registry.addConversationEntry(workflowId, {
          role: 'user',
          content: `Message ${String(i)}`,
          providerId: 'claude',
          timestamp: new Date(),
        })
      }

      const limited = registry.getHistory(workflowId, 2)
      expect(limited).toHaveLength(2)
    })

    it('returns empty array for unknown workflow', () => {
      expect(registry.getHistory('nonexistent')).toEqual([])
    })

    it('increments turnCount on provider session', () => {
      const workflowId = registry.createWorkflow()
      registry.linkProviderSession(workflowId, 'claude', 'sess-1')

      registry.addConversationEntry(workflowId, {
        role: 'user',
        content: 'Hello',
        providerId: 'claude',
        timestamp: new Date(),
      })

      const session = registry.getProviderSession(workflowId, 'claude')
      expect(session!.turnCount).toBe(1)
    })

    it('trims history at maxHistoryEntries', () => {
      const smallRegistry = new SessionRegistry({
        eventBus: bus,
        maxHistoryEntries: 3,
      })
      const workflowId = smallRegistry.createWorkflow()

      for (let i = 0; i < 5; i++) {
        smallRegistry.addConversationEntry(workflowId, {
          role: 'user',
          content: `Message ${String(i)}`,
          providerId: 'claude',
          timestamp: new Date(),
        })
      }

      const history = smallRegistry.getHistory(workflowId)
      expect(history).toHaveLength(3)
      // Most recent entries should be kept
      expect(history[0]!.content).toBe('Message 4')
      expect(history[1]!.content).toBe('Message 3')
      expect(history[2]!.content).toBe('Message 2')
    })
  })

  describe('buildContextForHandoff', () => {
    it('formats context correctly', () => {
      const workflowId = registry.createWorkflow()

      registry.addConversationEntry(workflowId, {
        role: 'user',
        content: 'Fix the bug',
        providerId: 'claude',
        timestamp: new Date(),
      })
      registry.addConversationEntry(workflowId, {
        role: 'assistant',
        content: 'I found the issue',
        providerId: 'claude',
        timestamp: new Date(),
      })

      const context = registry.buildContextForHandoff(workflowId)
      expect(context).toContain('--- Previous conversation context ---')
      expect(context).toContain('--- End of context ---')
      expect(context).toContain('[claude] USER: Fix the bug')
      expect(context).toContain('[claude] ASSISTANT: I found the issue')
    })

    it('returns empty string when no history', () => {
      const workflowId = registry.createWorkflow()
      expect(registry.buildContextForHandoff(workflowId)).toBe('')
    })

    it('respects maxEntries parameter', () => {
      const workflowId = registry.createWorkflow()

      for (let i = 0; i < 5; i++) {
        registry.addConversationEntry(workflowId, {
          role: 'user',
          content: `Msg ${String(i)}`,
          providerId: 'claude',
          timestamp: new Date(),
        })
      }

      const context = registry.buildContextForHandoff(workflowId, 2)
      // Should only include 2 most recent entries
      expect(context).toContain('Msg 4')
      expect(context).toContain('Msg 3')
      expect(context).not.toContain('Msg 0')
    })
  })

  describe('executeMultiTurn', () => {
    it('captures session IDs and records history', async () => {
      const workflowId = registry.createWorkflow()

      const events: AgentEvent[] = [
        {
          type: 'adapter:started' as const,
          providerId: 'claude' as AdapterProviderId,
          sessionId: 'multi-sess-1',
          timestamp: Date.now(),
        },
        {
          type: 'adapter:message' as const,
          providerId: 'claude' as AdapterProviderId,
          content: 'Response text',
          role: 'assistant' as const,
          timestamp: Date.now(),
        },
        {
          type: 'adapter:completed' as const,
          providerId: 'claude' as AdapterProviderId,
          sessionId: 'multi-sess-1',
          result: 'Done',
          durationMs: 100,
          timestamp: Date.now(),
          usage: { inputTokens: 10, outputTokens: 20 },
        },
      ]

      const mockAdapterRegistry = {
        async *executeWithFallback(_input: AgentInput, _task: TaskDescriptor) {
          for (const e of events) yield e
        },
      } as unknown as AdapterRegistry

      const collectedEvents: AgentEvent[] = []
      const gen = registry.executeMultiTurn(
        { prompt: 'Hello' },
        { workflowId, provider: 'claude' },
        mockAdapterRegistry,
      )

      for await (const event of gen) {
        collectedEvents.push(event)
      }

      expect(collectedEvents).toHaveLength(3)

      // Session should have been linked
      const session = registry.getProviderSession(workflowId, 'claude')
      expect(session).toBeDefined()
      expect(session!.sessionId).toBe('multi-sess-1')

      // Token counts should be updated
      expect(session!.totalTokens.input).toBe(10)
      expect(session!.totalTokens.output).toBe(20)

      // Conversation history should include user + assistant entries
      const history = registry.getHistory(workflowId)
      expect(history.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe('pruneExpired', () => {
    it('removes old sessions', () => {
      const shortTtl = new SessionRegistry({
        eventBus: bus,
        sessionTtlMs: 1, // 1ms TTL
      })

      shortTtl.createWorkflow()
      shortTtl.createWorkflow()

      // Wait briefly to ensure they expire
      const start = Date.now()
      while (Date.now() - start < 5) {
        // busy wait
      }

      const pruned = shortTtl.pruneExpired()
      expect(pruned).toBe(2)
      expect(shortTtl.listWorkflows()).toHaveLength(0)
    })

    it('keeps recent sessions', () => {
      const longTtl = new SessionRegistry({
        eventBus: bus,
        sessionTtlMs: 60_000,
      })

      longTtl.createWorkflow()
      const pruned = longTtl.pruneExpired()
      expect(pruned).toBe(0)
      expect(longTtl.listWorkflows()).toHaveLength(1)
    })
  })
})
