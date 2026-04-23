/**
 * P10 Track A — createAgentWithMemory end-to-end integration test.
 *
 * Unlike the unit tests in agent-factory.test.ts (which stub memory.get) and
 * memory-write-back.test.ts (which stub memory.put), this suite wires a REAL
 * LangGraph InMemoryStore behind a real MemoryService and proves the full
 * P9 loop:
 *   1. createAgentWithMemory() reads records from the live store and freezes
 *      them into the agent's FrozenSnapshot.
 *   2. The first generate() call injects that snapshot into the SystemMessage
 *      handed to the model.
 *   3. After the run completes, the agent's response is auto-persisted back
 *      into the same live store via memory.put().
 */
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages'
import { InMemoryStore } from '@langchain/langgraph'
import { MemoryService } from '@dzupagent/core'
import type { NamespaceConfig } from '@dzupagent/core'
import { describe, expect, it } from 'vitest'

import { createAgentWithMemory } from '../agent/agent-factory.js'

const NAMESPACE = 'facts'
const SCOPE = { project: 'demo' } as const

const namespaces: NamespaceConfig[] = [
  { name: NAMESPACE, scopeKeys: ['project'], searchable: false },
]

/** Captures every message array passed to model.invoke so the test can
 *  inspect the SystemMessage content. */
function createCapturingModel(responseContent: string) {
  const invocations: Array<Array<{ type: string; content: string }>> = []
  return {
    invocations,
    invoke: async (messages: Array<{ _getType: () => string; content: unknown }>) => {
      invocations.push(
        messages.map(m => ({
          type: m._getType(),
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        })),
      )
      return new AIMessage({ content: responseContent })
    },
  }
}

describe('createAgentWithMemory — end-to-end with InMemoryStore', () => {
  it('injects frozen snapshot into system prompt AND writes response back to live store', async () => {
    // ---- Arrange: real store seeded with one fact ---------------------------
    const store = new InMemoryStore()
    const memory = new MemoryService(store, namespaces, { rejectUnsafe: false })
    await memory.put(NAMESPACE, SCOPE, 'seed-1', {
      text: 'the sky is green on tuesdays',
    })

    const model = createCapturingModel('final agent response')

    // ---- Act (1): build agent via factory — this freezes the snapshot ------
    const agent = await createAgentWithMemory(
      {
        id: 'integration-agent',
        instructions: 'Base instructions',
        model: model as never,
        memory,
        memoryNamespace: NAMESPACE,
        memoryScope: SCOPE,
      },
      // memory/namespace/scope also set on config so the factory picks them up
    )

    // The factory should have loaded the seeded record into the snapshot.
    const snapshot = agent.agentConfig.frozenSnapshot
    expect(snapshot?.isActive()).toBe(true)
    expect(snapshot?.get()).toContain('the sky is green on tuesdays')

    // ---- Act (2): run generate() — snapshot should appear in SystemMessage -
    const result = await agent.generate([new HumanMessage('what colour is the sky?')])
    expect(result.content).toBe('final agent response')

    // Inspect what the model actually saw.
    expect(model.invocations.length).toBeGreaterThan(0)
    const firstCall = model.invocations[0]!
    const systemMessage = firstCall.find(m => m.type === 'system')
    expect(systemMessage).toBeDefined()
    expect(systemMessage!.content).toContain('Base instructions')
    // FrozenSnapshot wraps records under "## Memory Snapshot".
    expect(systemMessage!.content).toContain('## Memory Snapshot')
    expect(systemMessage!.content).toContain('the sky is green on tuesdays')

    // ---- Assert: write-back persisted the response to the LIVE store -------
    // Read directly via the MemoryService (not the frozen snapshot).
    const persisted = await memory.get(NAMESPACE, SCOPE)
    // Seed + written-back response = 2 records.
    expect(persisted.length).toBe(2)
    const written = persisted.find(r => r['text'] === 'final agent response')
    expect(written).toBeDefined()
    expect(written).toMatchObject({
      text: 'final agent response',
      agentId: 'integration-agent',
    })
    expect(typeof (written as { timestamp: unknown }).timestamp).toBe('number')

    // SystemMessage was actually a SystemMessage instance (sanity)
    expect(firstCall[0]!.type).toBe(new SystemMessage('').getType())
  })
})
