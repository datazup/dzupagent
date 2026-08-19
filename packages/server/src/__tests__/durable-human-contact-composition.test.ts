import { describe, expect, it, vi } from 'vitest'
import {
  AesGcmResumeTokenProtector,
  createHumanContactTool,
  humanContactRunnableConfig,
  type PendingContactStore,
} from '@dzupagent/agent/tools'
import {
  InMemoryAgentStore,
  InMemoryRunStore,
  ModelRegistry,
  createEventBus,
} from '@dzupagent/core'

import { createForgeApp } from '../app.js'
import { createDurableHumanContactComposition } from '../runtime/durable-human-contact-composition.js'
import {
  consumePendingContact,
  readPendingContactBinding,
  readResolvedContact,
  recordPendingContact,
  suspendForPendingContact,
} from '../runtime/pending-contacts.js'

function interruptTransitions(store: PendingContactStore): PendingContactStore {
  return {
    create: (contact) => store.create(contact),
    save: (contact) => store.save(contact),
    get: (contactId, runId) => store.get(contactId, runId),
    delete: (contactId, runId) => store.delete(contactId, runId),
    claimPause: (contactId, claim) => store.claimPause!(contactId, claim),
    transition: async () => {
      throw new Error('simulated process death before transition commit')
    },
  }
}

describe('durable human-contact host composition', () => {
  it('survives host recreation and completes one strict in-app resume', async () => {
    const runStore = new InMemoryRunStore()
    const eventBus = createEventBus()
    const run = await runStore.create({
      agentId: 'durable-host-agent',
      input: 'redacted',
      tenantId: 'tenant-durable-host',
    })
    await runStore.update(run.id, { status: 'running' })
    const key = new Uint8Array(32).fill(19)
    const protector = new AesGcmResumeTokenProtector(key)
    const requested = vi.fn()
    eventBus.on('human_contact:requested', requested)
    const invocation = humanContactRunnableConfig({
      runId: run.id,
      tenantId: 'tenant-durable-host',
      invocationId: 'invocation-durable-host',
    })
    const firstComposition = createDurableHumanContactComposition({
      runStore,
      tokenProtector: protector,
      pauseLeaseMs: 1_000,
      eventBus,
    })
    const firstTool = createHumanContactTool(firstComposition)

    const firstResult = JSON.parse(await firstTool.invoke({
      mode: 'approval',
      question: 'sensitive-host-question',
    }, invocation)) as { contactId: string }
    expect((await runStore.get(run.id))?.status).toBe('suspended')
    expect(JSON.stringify((await runStore.get(run.id))?.metadata))
      .not.toContain('sensitive-host-question')
    expect(requested).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(requested.mock.calls)).not.toContain('sensitive-host-question')

    const recreated = createDurableHumanContactComposition({
      runStore,
      tokenProtector: new AesGcmResumeTokenProtector(key),
    })
    const replay = JSON.parse(await createHumanContactTool(recreated).invoke({
      mode: 'approval',
      question: 'sensitive-host-question',
    }, invocation)) as { contactId: string }
    expect(replay.contactId).toBe(firstResult.contactId)

    const pending = await recreated.pendingStore?.get(firstResult.contactId, run.id)
    expect(pending?.lifecycleStatus).toBe('paused')
    const responded = vi.fn()
    eventBus.on('human_contact:responded', responded)
    const app = createForgeApp({
      runStore,
      agentStore: new InMemoryAgentStore(),
      eventBus,
      modelRegistry: new ModelRegistry(),
    })
    const response = await app.request(
      `/api/runs/${run.id}/human-contact/${firstResult.contactId}/respond`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Dzup-Resume-Token': pending?.resumeToken ?? '',
        },
        body: JSON.stringify({ type: 'approval', approved: true }),
      },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ data: { status: 'resumed' } })
    expect((await runStore.get(run.id))?.status).toBe('running')
    expect(responded).toHaveBeenCalledTimes(1)
    expect(await recreated.pendingStore?.get(firstResult.contactId, run.id)).toBeNull()
  })

  it('reclaims an expired lease after death before pause acknowledgement', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-19T09:00:00.000Z'))
      const runStore = new InMemoryRunStore()
      const run = await runStore.create({
        agentId: 'before-pause-death-agent',
        input: 'redacted',
        tenantId: 'tenant-before-pause-death',
      })
      await runStore.update(run.id, { status: 'running' })
      const protector = new AesGcmResumeTokenProtector(new Uint8Array(32).fill(21))
      const composition = createDurableHumanContactComposition({
        runStore,
        tokenProtector: protector,
        pauseLeaseMs: 1_000,
      })
      const invocation = humanContactRunnableConfig({
        runId: run.id,
        tenantId: 'tenant-before-pause-death',
        invocationId: 'invocation-before-pause-death',
      })
      const interrupted = createHumanContactTool({
        pendingStore: interruptTransitions(composition.pendingStore!),
        pauseLeaseMs: 1_000,
        onPause: async () => {
          throw new Error('simulated death before pause acknowledgement')
        },
      })

      await expect(interrupted.invoke({
        mode: 'approval',
        question: 'redacted',
      }, invocation)).rejects.toThrow('HUMAN_CONTACT_PAUSE_RECOVERY_FAILED')
      expect((await runStore.get(run.id))?.status).toBe('running')

      vi.setSystemTime(new Date('2026-08-19T09:00:01.001Z'))
      const recovered = JSON.parse(await createHumanContactTool(composition).invoke({
        mode: 'approval',
        question: 'redacted',
      }, invocation)) as { contactId: string }
      expect((await runStore.get(run.id))?.status).toBe('suspended')
      expect((await composition.pendingStore?.get(recovered.contactId, run.id))?.lifecycleStatus)
        .toBe('paused')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reclaims an expired lease after death following pause acknowledgement', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-19T10:00:00.000Z'))
      const runStore = new InMemoryRunStore()
      const run = await runStore.create({
        agentId: 'after-pause-death-agent',
        input: 'redacted',
        tenantId: 'tenant-after-pause-death',
      })
      await runStore.update(run.id, { status: 'running' })
      const composition = createDurableHumanContactComposition({
        runStore,
        tokenProtector: new AesGcmResumeTokenProtector(new Uint8Array(32).fill(22)),
        pauseLeaseMs: 1_000,
      })
      const invocation = humanContactRunnableConfig({
        runId: run.id,
        tenantId: 'tenant-after-pause-death',
        invocationId: 'invocation-after-pause-death',
      })
      const interrupted = createHumanContactTool({
        ...composition,
        pendingStore: interruptTransitions(composition.pendingStore!),
      })

      await expect(interrupted.invoke({
        mode: 'approval',
        question: 'redacted',
      }, invocation)).rejects.toThrow('HUMAN_CONTACT_PAUSE_COMMIT_FAILED')
      expect((await runStore.get(run.id))?.status).toBe('suspended')

      vi.setSystemTime(new Date('2026-08-19T10:00:01.001Z'))
      const recovered = JSON.parse(await createHumanContactTool(composition).invoke({
        mode: 'approval',
        question: 'redacted',
      }, invocation)) as { contactId: string }
      expect((await composition.pendingStore?.get(recovered.contactId, run.id))?.lifecycleStatus)
        .toBe('paused')
    } finally {
      vi.useRealTimers()
    }
  })

  it('upgrades a legacy pending id while atomically suspending the run', async () => {
    const runStore = new InMemoryRunStore()
    const run = await runStore.create({
      agentId: 'legacy-upgrade-agent',
      input: 'redacted',
      tenantId: 'tenant-legacy-upgrade',
      metadata: { pendingHumanContacts: ['contact-legacy-upgrade'] },
    })
    await runStore.update(run.id, { status: 'running' })
    const resumeToken = 'legacy-upgrade-token-must-not-persist'

    await expect(suspendForPendingContact(runStore, {
      contactId: 'contact-legacy-upgrade',
      runId: run.id,
      tenantId: 'tenant-legacy-upgrade',
      resumeToken,
    })).resolves.toBe('suspended')

    const updated = (await runStore.get(run.id))!
    expect(updated.status).toBe('suspended')
    expect(readPendingContactBinding(updated, 'contact-legacy-upgrade'))
      .toMatchObject({ tenantId: 'tenant-legacy-upgrade' })
    expect(JSON.stringify(updated.metadata)).not.toContain(resumeToken)
  })

  it('recovers publication after consumption wins and its process dies', async () => {
    const runStore = new InMemoryRunStore()
    const eventBus = createEventBus()
    const run = await runStore.create({
      agentId: 'publication-recovery-agent',
      input: 'redacted',
      tenantId: 'tenant-publication-recovery',
    })
    await runStore.update(run.id, { status: 'suspended' })
    const contactId = 'contact-publication-recovery'
    const resumeToken = 'publication-recovery-token-1234567890'
    await recordPendingContact(runStore, run.id, {
      contactId,
      runId: run.id,
      tenantId: 'tenant-publication-recovery',
      resumeToken,
    })

    const consumed = await consumePendingContact(runStore, {
      runId: run.id,
      tenantId: 'tenant-publication-recovery',
      contactId,
      resumeToken,
      response: { type: 'approval', approved: true, comment: 'original' },
      responseType: 'approval',
      respondedAt: '2026-08-19T08:00:00.000Z',
      publicationClaimId: 'claim-dead-process',
      publicationLeaseExpiresAt: '2026-08-19T08:00:01.000Z',
    })
    expect(consumed.status).toBe('consumed')
    expect(readResolvedContact((await runStore.get(run.id))!, contactId))
      .toMatchObject({ publicationStatus: 'pending' })

    const responded = vi.fn()
    eventBus.on('human_contact:responded', responded)
    const app = createForgeApp({
      runStore,
      agentStore: new InMemoryAgentStore(),
      eventBus,
      modelRegistry: new ModelRegistry(),
    })
    const recovered = await app.request(
      `/api/runs/${run.id}/human-contact/${contactId}/respond`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Dzup-Resume-Token': resumeToken,
        },
        body: JSON.stringify({ type: 'approval', approved: false, comment: 'replay' }),
      },
    )

    expect(await recovered.json()).toMatchObject({
      data: { status: 'already_resumed' },
    })
    expect(responded).toHaveBeenCalledTimes(1)
    expect(responded).toHaveBeenCalledWith(expect.objectContaining({
      publicationId: expect.stringMatching(/^hc_pub_/),
      response: expect.objectContaining({ approved: true, comment: 'original' }),
    }))
    expect(readResolvedContact((await runStore.get(run.id))!, contactId))
      .toMatchObject({ publicationStatus: 'published' })
  })
})
