import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  InMemoryAgentStore,
  InMemoryRunStore,
  ModelRegistry,
  createEventBus,
  type DzupEventBus,
  type Run,
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

async function suspendedRun(
  config: ForgeServerConfig,
  tenantId = 'tenant-binding',
): Promise<Run> {
  const run = await config.runStore.create({
    agentId: 'agent-binding',
    input: 'test',
    tenantId,
  })
  await config.runStore.update(run.id, { status: 'suspended' })
  return { ...run, status: 'suspended' }
}

async function respond(
  app: ReturnType<typeof createForgeApp>,
  runId: string,
  contactId: string,
  token: string | undefined,
): Promise<Response> {
  return app.request(
    `/api/runs/${runId}/human-contact/${contactId}/respond`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token !== undefined ? { [RESUME_TOKEN_HEADER]: token } : {}),
      },
      body: JSON.stringify({ type: 'approval', approved: true }),
    },
  )
}

describe('human-contact strict resume binding H3 admission', () => {
  let config: ReturnType<typeof configForTest>
  let app: ReturnType<typeof createForgeApp>

  beforeEach(() => {
    config = configForTest()
    app = createForgeApp(config)
  })

  it('admits the exact tenant/run/contact/token binding and retains no raw token', async () => {
    const run = await suspendedRun(config)
    const resumeToken = 'opaque-test-token-not-for-retention-123456'
    await recordPendingContact(config.runStore, run.id, {
      contactId: 'contact-strict',
      runId: run.id,
      tenantId: 'tenant-binding',
      resumeToken,
    })
    const events: unknown[] = []
    config.eventBus.onAny((event) => events.push(event))

    const response = await respond(
      app,
      run.id,
      'contact-strict',
      resumeToken,
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: { runId: run.id, contactId: 'contact-strict', status: 'resumed' },
    })
    const stored = await config.runStore.get(run.id)
    expect(JSON.stringify(stored?.metadata)).not.toContain(resumeToken)
    expect(JSON.stringify(events)).not.toContain(resumeToken)
    expect(JSON.stringify(await config.runStore.getLogs(run.id))).not.toContain(
      resumeToken,
    )
  })

  it('rejects missing and wrong resume tokens without changing run state', async () => {
    const run = await suspendedRun(config)
    await recordPendingContact(config.runStore, run.id, {
      contactId: 'contact-token',
      runId: run.id,
      tenantId: 'tenant-binding',
      resumeToken: 'correct-token-value-123456789',
    })

    expect((await respond(app, run.id, 'contact-token', undefined)).status).toBe(404)
    expect((await respond(app, run.id, 'contact-token', 'wrong-token')).status).toBe(404)
    expect((await config.runStore.get(run.id))?.status).toBe('suspended')
  })

  it('rejects a binding whose run or tenant does not match the owning run', async () => {
    const run = await suspendedRun(config)
    await expect(
      recordPendingContact(config.runStore, run.id, {
        contactId: 'contact-foreign-run',
        runId: 'other-run',
        tenantId: 'tenant-binding',
        resumeToken: 'token-foreign-run-123456789',
      }),
    ).rejects.toThrow('PENDING_CONTACT_BINDING_MISMATCH')
    await expect(
      recordPendingContact(config.runStore, run.id, {
        contactId: 'contact-foreign-tenant',
        runId: run.id,
        tenantId: 'other-tenant',
        resumeToken: 'token-foreign-tenant-123456789',
      }),
    ).rejects.toThrow('PENDING_CONTACT_BINDING_MISMATCH')
  })

  it('returns an idempotent replay receipt without a second response event', async () => {
    const run = await suspendedRun(config)
    const resumeToken = 'token-replay-12345678901234567890'
    await recordPendingContact(config.runStore, run.id, {
      contactId: 'contact-replay',
      runId: run.id,
      tenantId: 'tenant-binding',
      resumeToken,
    })
    const responded = vi.fn()
    config.eventBus.on('human_contact:responded', responded)

    const first = await respond(app, run.id, 'contact-replay', resumeToken)
    const second = await respond(app, run.id, 'contact-replay', resumeToken)

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({
      data: {
        runId: run.id,
        contactId: 'contact-replay',
        status: 'already_resumed',
      },
    })
    expect(responded).toHaveBeenCalledTimes(1)
  })

  it('serializes concurrent exact-token responses into one resume event', async () => {
    const run = await suspendedRun(config)
    const resumeToken = 'token-concurrent-123456789012345678'
    await recordPendingContact(config.runStore, run.id, {
      contactId: 'contact-concurrent',
      runId: run.id,
      tenantId: 'tenant-binding',
      resumeToken,
    })
    const responded = vi.fn()
    config.eventBus.on('human_contact:responded', responded)

    const [first, second] = await Promise.all([
      respond(app, run.id, 'contact-concurrent', resumeToken),
      respond(app, run.id, 'contact-concurrent', resumeToken),
    ])
    const statuses = await Promise.all([
      first.json().then((value) => (value as { data: { status: string } }).data.status),
      second.json().then((value) => (value as { data: { status: string } }).data.status),
    ])

    expect([first.status, second.status]).toEqual([200, 200])
    expect(statuses.sort()).toEqual(['already_resumed', 'resumed'])
    expect(responded).toHaveBeenCalledTimes(1)
  })

  it('rejects a foreign token on an already resolved contact', async () => {
    const run = await suspendedRun(config)
    const resumeToken = 'token-resolved-123456789012345678'
    await recordPendingContact(config.runStore, run.id, {
      contactId: 'contact-resolved',
      runId: run.id,
      tenantId: 'tenant-binding',
      resumeToken,
    })
    expect((await respond(app, run.id, 'contact-resolved', resumeToken)).status).toBe(200)

    const replay = await respond(
      app,
      run.id,
      'contact-resolved',
      'foreign-token-value',
    )
    expect(replay.status).toBe(404)
  })
})
