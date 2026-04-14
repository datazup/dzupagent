/**
 * Test helper factories for common DzupAgent test objects.
 *
 * These avoid boilerplate in test files by providing sensible defaults
 * that can be overridden via partial params.
 */
import {
  createEventBus,
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  type DzupEventBus,
  type DzupEvent,
  type RunStore,
  type AgentStore,
  type AgentDefinition,
} from '@dzupagent/core'

/** Create a test event bus that captures all emitted events */
export function createTestEventBus(): {
  bus: DzupEventBus
  events: DzupEvent[]
} {
  const bus = createEventBus()
  const events: DzupEvent[] = []
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
  eventBus: DzupEventBus
  events: DzupEvent[]
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
export function waitForEvent<T extends DzupEvent['type']>(
  bus: DzupEventBus,
  type: T,
  timeoutMs = 5000,
): Promise<Extract<DzupEvent, { type: T }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub()
      reject(new Error(`Timeout waiting for event "${type}" after ${timeoutMs}ms`))
    }, timeoutMs)

    const unsub = bus.on(type, (event) => {
      clearTimeout(timer)
      unsub()
      resolve(event as Extract<DzupEvent, { type: T }>)
    })
  })
}

export interface WaitForConditionOptions {
  timeoutMs?: number
  intervalMs?: number
  description?: string
}

/**
 * Polls until the predicate returns true (or truthy) or times out.
 */
export async function waitForCondition(
  predicate: () => Promise<boolean> | boolean,
  options: WaitForConditionOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5000
  const intervalMs = options.intervalMs ?? 25
  const startedAt = Date.now()

  while (Date.now() - startedAt <= timeoutMs) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  throw new Error(options.description ?? 'Condition not met before timeout')
}
