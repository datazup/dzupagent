import { describe, expect, it, vi } from 'vitest'
import {
  InMemoryAgentStore,
  InMemoryRunStore,
  ModelRegistry,
  createEventBus,
  type DzupEventBus,
} from '@dzupagent/core'

import { createForgeApp, type ForgeServerConfig } from '../app.js'
import { recordPendingContact } from '../runtime/pending-contacts.js'

const RESUME_TOKEN_HEADER = 'X-Dzup-Resume-Token'

function configForTest(): ForgeServerConfig & { eventBus: DzupEventBus } {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
  }
}

async function respond(
  app: ReturnType<typeof createForgeApp>,
  runId: string,
  contactId: string,
  resumeToken: string,
): Promise<Response> {
  return app.request(
    `/api/runs/${runId}/human-contact/${contactId}/respond`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [RESUME_TOKEN_HEADER]: resumeToken,
      },
      body: JSON.stringify({ type: 'approval', approved: true }),
    },
  )
}

describe('human-contact cross-replica response admission', () => {
  it('commits one resume when two independent route instances race', async () => {
    const config = configForTest()
    const firstReplica = createForgeApp(config)
    const secondReplica = createForgeApp(config)
    const run = await config.runStore.create({
      agentId: 'agent-cross-replica',
      input: 'redacted',
      tenantId: 'tenant-cross-replica',
    })
    await config.runStore.update(run.id, { status: 'suspended' })
    const resumeToken = 'cross-replica-token-12345678901234567890'
    await recordPendingContact(config.runStore, run.id, {
      contactId: 'contact-cross-replica',
      runId: run.id,
      tenantId: 'tenant-cross-replica',
      resumeToken,
    })
    const responded = vi.fn()
    config.eventBus.on('human_contact:responded', responded)

    const responses = await Promise.all([
      respond(firstReplica, run.id, 'contact-cross-replica', resumeToken),
      respond(secondReplica, run.id, 'contact-cross-replica', resumeToken),
    ])
    const statuses = await Promise.all(responses.map(async (response) => {
      const body = await response.json() as { data: { status: string } }
      return body.data.status
    }))

    expect(statuses.sort()).toEqual(['already_resumed', 'resumed'])
    expect(responded).toHaveBeenCalledTimes(1)
  })
})
