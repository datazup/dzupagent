/**
 * Test helper factories for common ForgeAgent test objects.
 *
 * These avoid boilerplate in test files by providing sensible defaults
 * that can be overridden via partial params.
 */
import {
  createEventBus,
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  type ForgeEventBus,
  type ForgeEvent,
  type RunStore,
  type AgentStore,
  type AgentDefinition,
} from '@forgeagent/core'

/** Create a test event bus that captures all emitted events */
export function createTestEventBus(): {
  bus: ForgeEventBus
  events: ForgeEvent[]
} {
  const bus = createEventBus()
  const events: ForgeEvent[] = []
  bus.onAny((event) => { events.push(event) })
  return { bus, events }
}

/** Create an in-memory run store (pre-cleared) */
export function createTestRunStore(): InMemoryRunStore {
  return new InMemoryRunStore()
}

/** Create an in-memory agent store (pre-cleared) */
export function createTestAgentStore(): InMemoryAgentStore {
  return new InMemoryAgentStore()
}

/** Create a minimal agent definition for testing */
export function createTestAgent(overrides?: Partial<AgentDefinition>): AgentDefinition {
  return {
    id: overrides?.id ?? `test-agent-${Date.now()}`,
    name: overrides?.name ?? 'Test Agent',
    instructions: overrides?.instructions ?? 'You are a test agent.',
    modelTier: overrides?.modelTier ?? 'chat',
    active: overrides?.active ?? true,
    ...overrides,
  }
}

/** Create a test config object with all stores and event bus */
export function createTestConfig(): {
  runStore: RunStore
  agentStore: AgentStore
  eventBus: ForgeEventBus
  events: ForgeEvent[]
  modelRegistry: ModelRegistry
} {
  const { bus, events } = createTestEventBus()
  return {
    runStore: createTestRunStore(),
    agentStore: createTestAgentStore(),
    eventBus: bus,
    events,
    modelRegistry: new ModelRegistry(),
  }
}

/**
 * Wait for a specific event type to be emitted.
 * Resolves with the event data or rejects on timeout.
 */
export function waitForEvent<T extends ForgeEvent['type']>(
  bus: ForgeEventBus,
  type: T,
  timeoutMs = 5000,
): Promise<Extract<ForgeEvent, { type: T }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub()
      reject(new Error(`Timeout waiting for event "${type}" after ${timeoutMs}ms`))
    }, timeoutMs)

    const unsub = bus.on(type, (event) => {
      clearTimeout(timer)
      unsub()
      resolve(event as Extract<ForgeEvent, { type: T }>)
    })
  })
}
