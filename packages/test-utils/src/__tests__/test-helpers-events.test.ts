import { test, expect } from 'vitest'
import { createTestConfig, createTestAgent, waitForEvent } from '../test-helpers.js'

test('test config captures events and waiters unsubscribe on completion and timeout', async () => {
  const config = createTestConfig()
  expect(createTestAgent({ id: 'fixture', active: false }).active).toBe(false)
  expect(createTestAgent().modelTier).toBe('chat')
  const pending = waitForEvent(config.eventBus, 'agent:started', 100)
  config.eventBus.emit({ type: 'agent:started', agentId: 'fixture', runId: 'fixture' })
  expect((await pending).agentId).toBe('fixture')
  expect(config.events).toHaveLength(1)
  await expect(waitForEvent(config.eventBus, 'agent:started', 1)).rejects.toThrow(/Timeout/)
})
