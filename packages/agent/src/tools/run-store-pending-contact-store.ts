import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto'
import type {
  AtomicRunStore,
  Run,
} from '@dzupagent/core/persistence'
import type {
  ContactChannel,
  HumanContactRequest,
} from '@dzupagent/core/tools'
import { omitUndefined } from '../utils/exact-optional.js'
import type {
  PendingContactCreateResult,
  PendingContactPauseClaim,
  PendingContactPauseClaimResult,
  PendingContactRecord,
  PendingContactStore,
  PendingContactTransition,
  PendingContactTransitionResult,
} from './human-contact-tool.js'

export const DURABLE_PENDING_CONTACTS_KEY = 'durablePendingHumanContacts'

const RESERVATION_KIND = 'durable-human-contact-reservation-v1'
const CIPHER_KIND = 'aes-256-gcm-v1'

export interface ResumeTokenProtectionContext {
  tenantId: string
  runId: string
  contactId: string
}

export interface ResumeTokenProtector {
  protect(token: string, context: ResumeTokenProtectionContext): Promise<string>
  unprotect(ciphertext: string, context: ResumeTokenProtectionContext): Promise<string>
}

/** Host-owned AES-256-GCM protector; callers retain custody of the 32-byte key. */
export class AesGcmResumeTokenProtector implements ResumeTokenProtector {
  private readonly key: Buffer

  constructor(key: Uint8Array) {
    if (key.byteLength !== 32) {
      throw new Error('HUMAN_CONTACT_TOKEN_KEY_INVALID: expected 32 bytes')
    }
    this.key = Buffer.from(key)
  }

  async protect(
    token: string,
    context: ResumeTokenProtectionContext,
  ): Promise<string> {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    cipher.setAAD(Buffer.from(protectionAad(context)))
    const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return [
      CIPHER_KIND,
      iv.toString('base64url'),
      tag.toString('base64url'),
      encrypted.toString('base64url'),
    ].join('.')
  }

  async unprotect(
    ciphertext: string,
    context: ResumeTokenProtectionContext,
  ): Promise<string> {
    const [kind, ivText, tagText, encryptedText, ...extra] = ciphertext.split('.')
    if (
      kind !== CIPHER_KIND
      || !ivText
      || !tagText
      || !encryptedText
      || extra.length > 0
    ) {
      throw new Error('HUMAN_CONTACT_TOKEN_CIPHERTEXT_INVALID')
    }
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key,
        Buffer.from(ivText, 'base64url'),
      )
      decipher.setAAD(Buffer.from(protectionAad(context)))
      decipher.setAuthTag(Buffer.from(tagText, 'base64url'))
      return Buffer.concat([
        decipher.update(Buffer.from(encryptedText, 'base64url')),
        decipher.final(),
      ]).toString('utf8')
    } catch {
      throw new Error('HUMAN_CONTACT_TOKEN_DECRYPTION_FAILED')
    }
  }
}

interface DurablePendingContactReservation {
  kind: typeof RESERVATION_KIND
  contactId: string
  runId: string
  tenantId: string
  invocationId: string
  invocationDigest: string
  requestType: string
  channel?: ContactChannel
  timeoutAt?: string
  resumeTokenHash: string
  resumeTokenCiphertext: string
  expiresAt?: string
  deliveredTo?: ContactChannel
  deliveryStatus: PendingContactRecord['deliveryStatus']
  lifecycleStatus: PendingContactRecord['lifecycleStatus']
  pauseLeaseId?: string
  pauseLeaseExpiresAt?: string
}

function protectionAad(context: ResumeTokenProtectionContext): string {
  return `${context.tenantId}\0${context.runId}\0${context.contactId}`
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function metadataOf(run: Pick<Run, 'metadata'>): Record<string, unknown> {
  return run.metadata ?? {}
}

function isReservation(value: unknown): value is DurablePendingContactReservation {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return entry['kind'] === RESERVATION_KIND
    && typeof entry['contactId'] === 'string'
    && typeof entry['runId'] === 'string'
    && typeof entry['tenantId'] === 'string'
    && typeof entry['invocationId'] === 'string'
    && typeof entry['invocationDigest'] === 'string'
    && typeof entry['requestType'] === 'string'
    && typeof entry['resumeTokenHash'] === 'string'
    && typeof entry['resumeTokenCiphertext'] === 'string'
    && (entry['deliveryStatus'] === 'pending'
      || entry['deliveryStatus'] === 'delivered'
      || entry['deliveryStatus'] === 'failed')
    && (entry['lifecycleStatus'] === 'preparing'
      || entry['lifecycleStatus'] === 'paused'
      || entry['lifecycleStatus'] === 'failed')
}

function reservationsOf(run: Pick<Run, 'metadata'>): DurablePendingContactReservation[] {
  const value = metadataOf(run)[DURABLE_PENDING_CONTACTS_KEY]
  return Array.isArray(value) ? value.filter(isReservation) : []
}

function replaceReservation(
  metadata: Record<string, unknown>,
  reservation: DurablePendingContactReservation,
): Record<string, unknown> {
  const existing = reservationsOf({ metadata } as Pick<Run, 'metadata'>)
  const found = existing.some((entry) => entry.contactId === reservation.contactId)
  return {
    ...metadata,
    [DURABLE_PENDING_CONTACTS_KEY]: found
      ? existing.map((entry) => (
          entry.contactId === reservation.contactId ? reservation : entry
        ))
      : [...existing, reservation],
  }
}

function removeReservation(
  metadata: Record<string, unknown>,
  contactId: string,
): Record<string, unknown> {
  return {
    ...metadata,
    [DURABLE_PENDING_CONTACTS_KEY]: reservationsOf({ metadata } as Pick<Run, 'metadata'>)
      .filter((entry) => entry.contactId !== contactId),
  }
}

function contextOf(
  reservation: DurablePendingContactReservation,
): ResumeTokenProtectionContext {
  return {
    tenantId: reservation.tenantId,
    runId: reservation.runId,
    contactId: reservation.contactId,
  }
}

/**
 * Pending-contact adapter stored in the atomically updated run metadata row.
 * Request content is deliberately not persisted; retries rebuild it from the
 * exact invocation while the adapter returns only the routing envelope.
 */
export class RunStorePendingContactStore implements PendingContactStore {
  constructor(
    private readonly runStore: AtomicRunStore,
    private readonly tokenProtector: ResumeTokenProtector,
  ) {}

  async create(contact: PendingContactRecord): Promise<PendingContactCreateResult> {
    const reservation = await this.toReservation(contact)
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const run = await this.requireRun(reservation.runId, reservation.tenantId)
      const existing = reservationsOf(run).find(
        (entry) => entry.contactId === reservation.contactId,
      )
      if (existing) {
        return { created: false, contact: await this.materialize(existing) }
      }
      const metadata = metadataOf(run)
      const committed = await this.runStore.compareAndSet(
        run.id,
        { status: run.status, metadata },
        { metadata: replaceReservation(metadata, reservation) },
      )
      if (committed) return { created: true, contact }
    }
    throw new Error('HUMAN_CONTACT_RESERVATION_CONTENTION')
  }

  async save(contact: PendingContactRecord): Promise<void> {
    const reservation = await this.toReservation(contact)
    await this.replaceExisting(reservation)
  }

  async get(contactId: string, runId?: string): Promise<PendingContactRecord | null> {
    const run = await this.runForContact(runId)
    const reservation = reservationsOf(run).find((entry) => entry.contactId === contactId)
    return reservation ? this.materialize(reservation) : null
  }

  async delete(contactId: string, runId?: string): Promise<void> {
    const resolvedRunId = requireRunId(runId)
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const run = await this.runStore.get(resolvedRunId)
      if (!run) return
      const metadata = metadataOf(run)
      if (!reservationsOf(run).some((entry) => entry.contactId === contactId)) return
      const committed = await this.runStore.compareAndSet(
        run.id,
        { status: run.status, metadata },
        { metadata: removeReservation(metadata, contactId) },
      )
      if (committed) return
    }
    throw new Error('HUMAN_CONTACT_RESERVATION_CONTENTION')
  }

  async claimPause(
    contactId: string,
    claim: PendingContactPauseClaim,
  ): Promise<PendingContactPauseClaimResult> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const run = await this.runForContact(claim.runId)
      const reservation = reservationsOf(run).find((entry) => entry.contactId === contactId)
      if (!reservation) throw new Error('PENDING_CONTACT_NOT_FOUND')
      if (reservation.lifecycleStatus !== 'preparing') {
        return { claimed: false, contact: await this.materialize(reservation) }
      }
      const activeForeignLease = reservation.pauseLeaseId !== undefined
        && reservation.pauseLeaseExpiresAt !== undefined
        && Date.parse(reservation.pauseLeaseExpiresAt) > Date.parse(claim.now)
        && reservation.pauseLeaseId !== claim.claimId
      if (activeForeignLease) {
        return { claimed: false, contact: await this.materialize(reservation) }
      }
      const leased: DurablePendingContactReservation = {
        ...reservation,
        pauseLeaseId: claim.claimId,
        pauseLeaseExpiresAt: claim.leaseExpiresAt,
      }
      const metadata = metadataOf(run)
      const committed = await this.runStore.compareAndSet(
        run.id,
        { status: run.status, metadata },
        { metadata: replaceReservation(metadata, leased) },
      )
      if (committed) {
        return { claimed: true, contact: await this.materialize(leased) }
      }
    }
    throw new Error('HUMAN_CONTACT_RESERVATION_CONTENTION')
  }

  async transition(
    contactId: string,
    transition: PendingContactTransition,
  ): Promise<PendingContactTransitionResult> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const run = await this.runForContact(transition.runId)
      const reservation = reservationsOf(run).find((entry) => entry.contactId === contactId)
      if (!reservation) throw new Error('PENDING_CONTACT_NOT_FOUND')
      if (
        reservation.lifecycleStatus !== transition.expected
        || reservation.pauseLeaseId !== transition.claimId
      ) {
        return { transitioned: false, contact: await this.materialize(reservation) }
      }
      const next: DurablePendingContactReservation = {
        ...reservation,
        lifecycleStatus: transition.next,
        deliveryStatus: transition.deliveryStatus,
      }
      delete next.pauseLeaseId
      delete next.pauseLeaseExpiresAt
      const metadata = metadataOf(run)
      const committed = await this.runStore.compareAndSet(
        run.id,
        { status: run.status, metadata },
        { metadata: replaceReservation(metadata, next) },
      )
      if (committed) {
        return { transitioned: true, contact: await this.materialize(next) }
      }
    }
    throw new Error('HUMAN_CONTACT_RESERVATION_CONTENTION')
  }

  private async replaceExisting(
    reservation: DurablePendingContactReservation,
  ): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const run = await this.requireRun(reservation.runId, reservation.tenantId)
      if (!reservationsOf(run).some((entry) => entry.contactId === reservation.contactId)) {
        throw new Error('PENDING_CONTACT_NOT_FOUND')
      }
      const metadata = metadataOf(run)
      const committed = await this.runStore.compareAndSet(
        run.id,
        { status: run.status, metadata },
        { metadata: replaceReservation(metadata, reservation) },
      )
      if (committed) return
    }
    throw new Error('HUMAN_CONTACT_RESERVATION_CONTENTION')
  }

  private async toReservation(
    contact: PendingContactRecord,
  ): Promise<DurablePendingContactReservation> {
    const context = {
      tenantId: contact.tenantId,
      runId: contact.request.runId,
      contactId: contact.request.contactId,
    }
    const reservation: DurablePendingContactReservation = {
      kind: RESERVATION_KIND,
      contactId: contact.request.contactId,
      runId: contact.request.runId,
      tenantId: contact.tenantId,
      invocationId: contact.invocationId,
      invocationDigest: contact.invocationDigest,
      requestType: contact.request.type,
      resumeTokenHash: tokenHash(contact.resumeToken),
      resumeTokenCiphertext: await this.tokenProtector.protect(contact.resumeToken, context),
      deliveryStatus: contact.deliveryStatus,
      lifecycleStatus: contact.lifecycleStatus,
    }
    if (contact.request.channel !== undefined) reservation.channel = contact.request.channel
    if (contact.request.timeoutAt !== undefined) reservation.timeoutAt = contact.request.timeoutAt
    if (contact.expiresAt !== undefined) reservation.expiresAt = contact.expiresAt
    if (contact.deliveredTo !== undefined) reservation.deliveredTo = contact.deliveredTo
    if (contact.pauseLeaseId !== undefined) reservation.pauseLeaseId = contact.pauseLeaseId
    if (contact.pauseLeaseExpiresAt !== undefined) {
      reservation.pauseLeaseExpiresAt = contact.pauseLeaseExpiresAt
    }
    return reservation
  }

  private async materialize(
    reservation: DurablePendingContactReservation,
  ): Promise<PendingContactRecord> {
    const request: HumanContactRequest = omitUndefined({
      contactId: reservation.contactId,
      runId: reservation.runId,
      type: reservation.requestType,
      channel: reservation.channel,
      timeoutAt: reservation.timeoutAt,
      data: {},
    })
    return omitUndefined({
      request,
      tenantId: reservation.tenantId,
      invocationId: reservation.invocationId,
      invocationDigest: reservation.invocationDigest,
      resumeToken: await this.tokenProtector.unprotect(
        reservation.resumeTokenCiphertext,
        contextOf(reservation),
      ),
      expiresAt: reservation.expiresAt,
      deliveredTo: reservation.deliveredTo,
      deliveryStatus: reservation.deliveryStatus,
      lifecycleStatus: reservation.lifecycleStatus,
      pauseLeaseId: reservation.pauseLeaseId,
      pauseLeaseExpiresAt: reservation.pauseLeaseExpiresAt,
    })
  }

  private async requireRun(runId: string, tenantId: string): Promise<Run> {
    const run = await this.runStore.get(runId)
    if (!run) throw new Error('PENDING_CONTACT_RUN_NOT_FOUND')
    if ((run.tenantId ?? 'default') !== tenantId) {
      throw new Error('PENDING_CONTACT_BINDING_MISMATCH')
    }
    return run
  }

  private async runForContact(runId: string | undefined): Promise<Run> {
    const resolvedRunId = requireRunId(runId)
    const run = await this.runStore.get(resolvedRunId)
    if (!run) throw new Error('PENDING_CONTACT_RUN_NOT_FOUND')
    return run
  }
}

function requireRunId(runId: string | undefined): string {
  if (!runId) throw new Error('DURABLE_PENDING_CONTACT_RUN_ID_REQUIRED')
  return runId
}
