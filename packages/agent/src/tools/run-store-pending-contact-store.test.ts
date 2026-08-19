import { describe, expect, it } from 'vitest'
import { InMemoryRunStore } from '@dzupagent/core/persistence'

import {
  AesGcmResumeTokenProtector,
  DURABLE_PENDING_CONTACTS_KEY,
  KeyringResumeTokenProtector,
  RunStorePendingContactStore,
} from './run-store-pending-contact-store.js'
import type { PendingContactRecord } from './human-contact-tool.js'

async function fixture(): Promise<{
  runStore: InMemoryRunStore
  runId: string
  record: PendingContactRecord
  protector: AesGcmResumeTokenProtector
}> {
  const runStore = new InMemoryRunStore()
  const run = await runStore.create({
    agentId: 'durable-contact-agent',
    input: 'redacted',
    tenantId: 'tenant-durable',
  })
  await runStore.update(run.id, { status: 'running' })
  return {
    runStore,
    runId: run.id,
    protector: new AesGcmResumeTokenProtector(new Uint8Array(32).fill(7)),
    record: {
      request: {
        contactId: 'contact-durable',
        runId: run.id,
        type: 'approval',
        channel: 'in-app',
        data: { question: 'sensitive-question-must-not-persist' },
      },
      tenantId: 'tenant-durable',
      invocationId: 'invocation-durable',
      invocationDigest: 'digest-durable',
      resumeToken: 'raw-resume-token-must-not-persist',
      deliveredTo: 'in-app',
      deliveryStatus: 'pending',
      lifecycleStatus: 'preparing',
    },
  }
}

describe('RunStorePendingContactStore', () => {
  it('rotates explicit key ids while retaining bounded legacy decryption', async () => {
    const context = {
      tenantId: 'tenant-keyring',
      runId: 'run-keyring',
      contactId: 'contact-keyring',
    }
    const oldKey = new Uint8Array(32).fill(31)
    const newKey = new Uint8Array(32).fill(32)
    const oldProtector = new KeyringResumeTokenProtector({
      current: { id: 'key-2026-08-a', key: oldKey },
    })
    const oldCiphertext = await oldProtector.protect('rotating-token', context)
    const legacyCiphertext = await new AesGcmResumeTokenProtector(oldKey)
      .protect('legacy-token', context)
    const rotated = new KeyringResumeTokenProtector({
      current: { id: 'key-2026-08-b', key: newKey },
      previous: [{ id: 'key-2026-08-a', key: oldKey }],
    })

    expect(oldCiphertext).toMatch(/^aes-256-gcm-keyring-v1\.key-2026-08-a\./)
    expect(oldCiphertext).not.toContain('rotating-token')
    await expect(rotated.unprotect(oldCiphertext, context))
      .resolves.toBe('rotating-token')
    await expect(rotated.unprotect(legacyCiphertext, context))
      .resolves.toBe('legacy-token')
    await expect(rotated.protect('new-token', context))
      .resolves.toMatch(/^aes-256-gcm-keyring-v1\.key-2026-08-b\./)
  })

  it('fails closed for an unknown ciphertext key id', async () => {
    const context = {
      tenantId: 'tenant-keyring',
      runId: 'run-keyring',
      contactId: 'contact-keyring',
    }
    const protector = new KeyringResumeTokenProtector({
      current: { id: 'key-known', key: new Uint8Array(32).fill(33) },
    })
    const ciphertext = await protector.protect('unknown-key-token', context)
    const foreign = ciphertext.replace('.key-known.', '.key-foreign.')

    await expect(protector.unprotect(foreign, context))
      .rejects.toThrow('HUMAN_CONTACT_TOKEN_KEY_NOT_FOUND')
  })

  it('persists a content-free reservation and recovers its protected token', async () => {
    const { runStore, runId, record, protector } = await fixture()
    const store = new RunStorePendingContactStore(runStore, protector)

    expect((await store.create(record)).created).toBe(true)

    const run = await runStore.get(runId)
    const serialized = JSON.stringify(run?.metadata)
    expect(serialized).toContain(DURABLE_PENDING_CONTACTS_KEY)
    expect(serialized).not.toContain('sensitive-question-must-not-persist')
    expect(serialized).not.toContain('raw-resume-token-must-not-persist')
    const recovered = await store.get(record.request.contactId, runId)
    expect(recovered?.resumeToken).toBe(record.resumeToken)
    expect(recovered?.request.data).toEqual({})
  })

  it('fails closed when a different host key attempts token recovery', async () => {
    const { runStore, runId, record, protector } = await fixture()
    await new RunStorePendingContactStore(runStore, protector).create(record)
    const wrongKeyStore = new RunStorePendingContactStore(
      runStore,
      new AesGcmResumeTokenProtector(new Uint8Array(32).fill(8)),
    )

    await expect(wrongKeyStore.get(record.request.contactId, runId))
      .rejects.toThrow('HUMAN_CONTACT_TOKEN_DECRYPTION_FAILED')
  })

  it('grants one cross-instance pause lease and permits expired-lease recovery', async () => {
    const { runStore, runId, record, protector } = await fixture()
    const first = new RunStorePendingContactStore(runStore, protector)
    const second = new RunStorePendingContactStore(runStore, protector)
    await first.create(record)

    const now = '2026-08-19T08:00:00.000Z'
    const claims = await Promise.all([
      first.claimPause(record.request.contactId, {
        runId,
        claimId: 'claim-first',
        now,
        leaseExpiresAt: '2026-08-19T08:00:30.000Z',
      }),
      second.claimPause(record.request.contactId, {
        runId,
        claimId: 'claim-second',
        now,
        leaseExpiresAt: '2026-08-19T08:00:30.000Z',
      }),
    ])
    expect(claims.filter((claim) => claim.claimed)).toHaveLength(1)

    const recovered = await second.claimPause(record.request.contactId, {
      runId,
      claimId: 'claim-recovery',
      now: '2026-08-19T08:00:31.000Z',
      leaseExpiresAt: '2026-08-19T08:01:01.000Z',
    })
    expect(recovered.claimed).toBe(true)
    expect(recovered.contact.pauseLeaseId).toBe('claim-recovery')
  })
})
