/**
 * Outstanding human-contact registry (DZUPAGENT-AGENT-H-14).
 *
 * Legacy callers store contact ids as strings. Runtime-bound callers store a
 * structured tenant/run/contact binding with only a digest of the opaque
 * resume token. Both shapes remain readable during the compatibility window.
 *
 * @module runtime/pending-contacts
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import {
  isAtomicRunStore,
  type AtomicRunStore,
  type Run,
  type RunStore,
} from '@dzupagent/core/persistence'
import { DURABLE_PENDING_CONTACTS_KEY } from '@dzupagent/agent/tools'

/** Metadata key holding outstanding contact entries for a run. */
export const PENDING_CONTACTS_KEY = 'pendingHumanContacts'
/** Metadata key holding content-free replay receipts. */
export const RESOLVED_CONTACTS_KEY = 'resolvedHumanContacts'
/** Dedicated header carrying the opaque token on a human response. */
export const HUMAN_CONTACT_RESUME_TOKEN_HEADER = 'X-Dzup-Resume-Token'

const BINDING_KIND = 'human-contact-binding-v1'
const RECEIPT_KIND = 'human-contact-receipt-v1'

export interface PendingContactRegistration {
  contactId: string
  runId: string
  tenantId: string
  /** Opaque input. Only its SHA-256 digest is retained. */
  resumeToken: string
}

export type SuspendForPendingContactResult = 'suspended' | 'already_suspended'

export interface PendingContactBinding {
  kind: typeof BINDING_KIND
  contactId: string
  runId: string
  tenantId: string
  resumeTokenHash: string
}

export interface ResolvedContactReceipt {
  kind: typeof RECEIPT_KIND
  contactId: string
  runId: string
  tenantId: string
  resumeTokenHash: string
  respondedAt: string
  responseType: string
  publicationId?: string
  publicationStatus?: 'pending' | 'published'
  publicationClaimId?: string
  publicationLeaseExpiresAt?: string
  publishedAt?: string
}

type PendingContactEntry = string | PendingContactBinding

function metadataRecord(run: Pick<Run, 'metadata'>): Record<string, unknown> {
  return (run.metadata as Record<string, unknown> | undefined) ?? {}
}

function withoutDurableReservation(
  metadata: Record<string, unknown>,
  contactId: string,
): Record<string, unknown> {
  const raw = metadata[DURABLE_PENDING_CONTACTS_KEY]
  if (!Array.isArray(raw)) return metadata
  return {
    ...metadata,
    [DURABLE_PENDING_CONTACTS_KEY]: raw.filter((entry) => (
      typeof entry !== 'object'
      || entry === null
      || (entry as Record<string, unknown>)['contactId'] !== contactId
    )),
  }
}

function publicationResponseOf(
  run: Pick<Run, 'metadata'>,
  contactId: string,
): Record<string, unknown> | null {
  const value = metadataRecord(run)['humanContactResponse']
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const response = value as Record<string, unknown>
  return response['contactId'] === contactId ? response : null
}

function isPendingContactBinding(value: unknown): value is PendingContactBinding {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return candidate['kind'] === BINDING_KIND
    && typeof candidate['contactId'] === 'string'
    && typeof candidate['runId'] === 'string'
    && typeof candidate['tenantId'] === 'string'
    && typeof candidate['resumeTokenHash'] === 'string'
}

function isResolvedContactReceipt(value: unknown): value is ResolvedContactReceipt {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return candidate['kind'] === RECEIPT_KIND
    && typeof candidate['contactId'] === 'string'
    && typeof candidate['runId'] === 'string'
    && typeof candidate['tenantId'] === 'string'
    && typeof candidate['resumeTokenHash'] === 'string'
    && typeof candidate['respondedAt'] === 'string'
    && typeof candidate['responseType'] === 'string'
}

function readPendingEntries(run: Pick<Run, 'metadata'>): PendingContactEntry[] {
  const raw = metadataRecord(run)[PENDING_CONTACTS_KEY]
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (entry): entry is PendingContactEntry =>
      typeof entry === 'string' || isPendingContactBinding(entry),
  )
}

function contactIdOf(entry: PendingContactEntry): string {
  return typeof entry === 'string' ? entry : entry.contactId
}

export function hashResumeToken(resumeToken: string): string {
  return createHash('sha256').update(resumeToken).digest('hex')
}

export interface ConsumePendingContactInput {
  runId: string
  tenantId: string
  contactId: string
  resumeToken?: string
  response: Record<string, unknown>
  responseType: string
  respondedAt: string
  publicationClaimId: string
  publicationLeaseExpiresAt: string
}

export type ConsumePendingContactResult =
  | {
      status: 'consumed'
      run: Run
      publication?: ResolvedContactReceipt
      publicationResponse?: Record<string, unknown>
    }
  | {
      status: 'already_consumed'
      run: Run
      publication?: ResolvedContactReceipt
      publicationResponse?: Record<string, unknown>
    }
  | { status: 'not_found'; run: Run | null }
  | { status: 'run_conflict'; run: Run }
  | { status: 'contention' }

/**
 * Consume one response with an exact run-row compare-and-set.
 *
 * A losing replica re-reads the committed receipt and returns an idempotent
 * replay result. No in-process mutex participates in this decision.
 */
export async function consumePendingContact(
  runStore: AtomicRunStore,
  input: ConsumePendingContactInput,
): Promise<ConsumePendingContactResult> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const run = await runStore.get(input.runId)
    if (!run) return { status: 'not_found', run: null }
    if ((run.tenantId ?? 'default') !== input.tenantId) {
      return { status: 'not_found', run }
    }

    const resolved = readResolvedContact(run, input.contactId)
    if (resolved) {
      if (
        resolved.runId !== input.runId
        || resolved.tenantId !== input.tenantId
        || !matchesResumeToken(resolved.resumeTokenHash, input.resumeToken)
      ) {
        return { status: 'not_found', run }
      }
      if (
        resolved.publicationStatus === 'pending'
        && resolved.publicationId !== undefined
      ) {
        const leaseExpiresAt = resolved.publicationLeaseExpiresAt
        const leaseExpired = leaseExpiresAt === undefined
          || Date.parse(leaseExpiresAt) <= Date.parse(input.respondedAt)
        if (leaseExpired) {
          const claimed: ResolvedContactReceipt = {
            ...resolved,
            publicationClaimId: input.publicationClaimId,
            publicationLeaseExpiresAt: input.publicationLeaseExpiresAt,
          }
          const metadata = metadataRecord(run)
          const committed = await runStore.compareAndSet(
            run.id,
            { status: run.status, metadata },
            { metadata: replaceResolvedContact(metadata, claimed) },
          )
          if (committed) {
            const publicationResponse = publicationResponseOf(committed, input.contactId)
            if (!publicationResponse) {
              throw new Error('HUMAN_CONTACT_PUBLICATION_RESPONSE_MISSING')
            }
            return {
              status: 'already_consumed',
              run: committed,
              publication: claimed,
              publicationResponse,
            }
          }
          continue
        }
      }
      return { status: 'already_consumed', run }
    }

    if (run.status !== 'suspended' && run.status !== 'awaiting_approval') {
      return { status: 'run_conflict', run }
    }

    const binding = readPendingContactBinding(run, input.contactId)
    if (
      !isPendingContact(run, input.contactId)
      || (binding !== null && (
        binding.runId !== input.runId
        || binding.tenantId !== input.tenantId
        || !matchesResumeToken(binding.resumeTokenHash, input.resumeToken)
      ))
    ) {
      return { status: 'not_found', run }
    }

    const metadata = metadataRecord(run)
    let nextMetadata = withoutDurableReservation(
      withoutPendingContact(metadata, input.contactId),
      input.contactId,
    )
    if (binding) {
      nextMetadata = withResolvedContact(
        nextMetadata,
        resolvedContactReceipt(
          binding,
          input.responseType,
          input.respondedAt,
          {
            claimId: input.publicationClaimId,
            leaseExpiresAt: input.publicationLeaseExpiresAt,
          },
        ),
      )
    }
    const committed = await runStore.compareAndSet(
      input.runId,
      { status: run.status, metadata },
      {
        status: 'running',
        metadata: {
          ...nextMetadata,
          humanContactResponse: {
            contactId: input.contactId,
            respondedAt: input.respondedAt,
            ...input.response,
          },
        },
      },
    )
    if (committed) {
      const publication = readResolvedContact(committed, input.contactId)
      return publication
        ? {
            status: 'consumed',
            run: committed,
            publication,
            publicationResponse: input.response,
          }
        : { status: 'consumed', run: committed }
    }
  }
  return { status: 'contention' }
}

/** Read all outstanding contact ids, including structured binding entries. */
export function readPendingContacts(run: Pick<Run, 'metadata'>): string[] {
  return readPendingEntries(run).map(contactIdOf)
}

/** Read the structured binding for one contact, if it is not a legacy entry. */
export function readPendingContactBinding(
  run: Pick<Run, 'metadata'>,
  contactId: string,
): PendingContactBinding | null {
  return readPendingEntries(run).find(
    (entry): entry is PendingContactBinding =>
      typeof entry !== 'string' && entry.contactId === contactId,
  ) ?? null
}

/** True when `contactId` is an outstanding contact request on `run`. */
export function isPendingContact(
  run: Pick<Run, 'metadata'>,
  contactId: string,
): boolean {
  return readPendingContacts(run).includes(contactId)
}

/** Return a content-free receipt for a contact that was already consumed. */
export function readResolvedContact(
  run: Pick<Run, 'metadata'>,
  contactId: string,
): ResolvedContactReceipt | null {
  const raw = metadataRecord(run)[RESOLVED_CONTACTS_KEY]
  if (!Array.isArray(raw)) return null
  return raw.find(
    (entry): entry is ResolvedContactReceipt =>
      isResolvedContactReceipt(entry) && entry.contactId === contactId,
  ) ?? null
}

/** Compare an opaque token to a stored digest without data-dependent bytes. */
export function matchesResumeToken(
  storedHash: string,
  resumeToken: string | undefined,
): boolean {
  if (resumeToken === undefined) return false
  const candidate = hashResumeToken(resumeToken)
  const storedBuffer = Buffer.from(storedHash, 'hex')
  const candidateBuffer = Buffer.from(candidate, 'hex')
  return storedBuffer.length === candidateBuffer.length
    && timingSafeEqual(storedBuffer, candidateBuffer)
}

/**
 * Record a legacy contact id or a strict runtime binding as outstanding.
 * Strict bindings fail closed on run/tenant mismatch and retain no raw token.
 */
export async function recordPendingContact(
  runStore: RunStore,
  runId: string,
  contact: string | PendingContactRegistration,
): Promise<void> {
  const run = await runStore.get(runId)
  if (!run) {
    if (typeof contact === 'string') return
    throw new Error('PENDING_CONTACT_RUN_NOT_FOUND')
  }

  const entries = readPendingEntries(run)
  const contactId = typeof contact === 'string' ? contact : contact.contactId
  const sameId = entries.find((entry) => contactIdOf(entry) === contactId)

  if (typeof contact === 'string') {
    if (sameId) return
    await runStore.update(runId, {
      metadata: {
        ...metadataRecord(run),
        [PENDING_CONTACTS_KEY]: [...entries, contact],
      },
    })
    return
  }

  const tenantId = run.tenantId ?? 'default'
  if (contact.runId !== runId || contact.tenantId !== tenantId) {
    throw new Error('PENDING_CONTACT_BINDING_MISMATCH')
  }
  const binding: PendingContactBinding = {
    kind: BINDING_KIND,
    contactId,
    runId,
    tenantId,
    resumeTokenHash: hashResumeToken(contact.resumeToken),
  }
  if (sameId && typeof sameId !== 'string') {
    if (
      sameId.runId === binding.runId
      && sameId.tenantId === binding.tenantId
      && sameId.resumeTokenHash === binding.resumeTokenHash
    ) return
    throw new Error('PENDING_CONTACT_BINDING_CONFLICT')
  }

  const nextEntries = sameId
    ? entries.map((entry) => contactIdOf(entry) === contactId ? binding : entry)
    : [...entries, binding]
  const nextMetadata = {
    ...metadataRecord(run),
    [PENDING_CONTACTS_KEY]: nextEntries,
  }
  if (isAtomicRunStore(runStore)) {
    const committed = await runStore.compareAndSet(
      runId,
      { status: run.status, metadata: metadataRecord(run) },
      { metadata: nextMetadata },
    )
    if (!committed) throw new Error('PENDING_CONTACT_REGISTRATION_CONFLICT')
    return
  }
  await runStore.update(runId, { metadata: nextMetadata })
}

/** Atomically register an exact binding and suspend its owning run. */
export async function suspendForPendingContact(
  runStore: AtomicRunStore,
  registration: PendingContactRegistration,
): Promise<SuspendForPendingContactResult> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const run = await runStore.get(registration.runId)
    if (!run) throw new Error('PENDING_CONTACT_RUN_NOT_FOUND')
    const tenantId = run.tenantId ?? 'default'
    if (registration.tenantId !== tenantId) {
      throw new Error('PENDING_CONTACT_BINDING_MISMATCH')
    }
    const entries = readPendingEntries(run)
    const sameId = entries.find(
      (entry) => contactIdOf(entry) === registration.contactId,
    )
    const binding: PendingContactBinding = {
      kind: BINDING_KIND,
      contactId: registration.contactId,
      runId: registration.runId,
      tenantId: registration.tenantId,
      resumeTokenHash: hashResumeToken(registration.resumeToken),
    }
    if (sameId && typeof sameId !== 'string') {
      if (
        sameId.runId !== binding.runId
        || sameId.tenantId !== binding.tenantId
        || sameId.resumeTokenHash !== binding.resumeTokenHash
      ) {
        throw new Error('PENDING_CONTACT_BINDING_CONFLICT')
      }
      if (run.status === 'suspended' || run.status === 'awaiting_approval') {
        return 'already_suspended'
      }
    }
    if (
      run.status === 'completed'
      || run.status === 'halted'
      || run.status === 'failed'
      || run.status === 'rejected'
      || run.status === 'cancelled'
    ) {
      throw new Error(`PENDING_CONTACT_RUN_TERMINAL: ${run.status}`)
    }
    const nextEntries = sameId
      ? entries.map((entry) => (
          contactIdOf(entry) === registration.contactId ? binding : entry
        ))
      : [...entries, binding]
    const metadata = metadataRecord(run)
    const committed = await runStore.compareAndSet(
      run.id,
      { status: run.status, metadata },
      {
        status: 'suspended',
        metadata: {
          ...metadata,
          [PENDING_CONTACTS_KEY]: nextEntries,
        },
      },
    )
    if (committed) return 'suspended'
  }
  throw new Error('PENDING_CONTACT_SUSPENSION_CONTENTION')
}

/** Remove one contact while preserving both legacy and structured entries. */
export function withoutPendingContact(
  metadata: Record<string, unknown>,
  contactId: string,
): Record<string, unknown> {
  const remaining = readPendingEntries({ metadata } as Pick<Run, 'metadata'>)
    .filter((entry) => contactIdOf(entry) !== contactId)
  return { ...metadata, [PENDING_CONTACTS_KEY]: remaining }
}

/** Add an idempotent, content-free resolved-contact receipt. */
export function withResolvedContact(
  metadata: Record<string, unknown>,
  receipt: ResolvedContactReceipt,
): Record<string, unknown> {
  const raw = metadata[RESOLVED_CONTACTS_KEY]
  const existing = Array.isArray(raw)
    ? raw.filter(isResolvedContactReceipt)
    : []
  if (existing.some((entry) => entry.contactId === receipt.contactId)) {
    return metadata
  }
  return {
    ...metadata,
    [RESOLVED_CONTACTS_KEY]: [...existing, receipt],
  }
}

function replaceResolvedContact(
  metadata: Record<string, unknown>,
  receipt: ResolvedContactReceipt,
): Record<string, unknown> {
  const raw = metadata[RESOLVED_CONTACTS_KEY]
  const existing = Array.isArray(raw)
    ? raw.filter(isResolvedContactReceipt)
    : []
  return {
    ...metadata,
    [RESOLVED_CONTACTS_KEY]: existing.map((entry) => (
      entry.contactId === receipt.contactId ? receipt : entry
    )),
  }
}

export async function markContactPublicationPublished(
  runStore: AtomicRunStore,
  input: {
    runId: string
    contactId: string
    publicationClaimId: string
    publishedAt: string
  },
): Promise<boolean> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const run = await runStore.get(input.runId)
    if (!run) return false
    const receipt = readResolvedContact(run, input.contactId)
    if (!receipt) return false
    if (receipt.publicationStatus === 'published') return true
    if (
      receipt.publicationStatus !== 'pending'
      || receipt.publicationClaimId !== input.publicationClaimId
    ) {
      return false
    }
    const published: ResolvedContactReceipt = {
      ...receipt,
      publicationStatus: 'published',
      publishedAt: input.publishedAt,
    }
    delete published.publicationClaimId
    delete published.publicationLeaseExpiresAt
    const metadata = metadataRecord(run)
    const committed = await runStore.compareAndSet(
      run.id,
      { status: run.status, metadata },
      { metadata: replaceResolvedContact(metadata, published) },
    )
    if (committed) return true
  }
  return false
}

/** Build a receipt using only the already-hashed token binding. */
export function resolvedContactReceipt(
  binding: PendingContactBinding,
  responseType: string,
  respondedAt = new Date().toISOString(),
  publication?: { claimId: string; leaseExpiresAt: string },
): ResolvedContactReceipt {
  const receipt: ResolvedContactReceipt = {
    kind: RECEIPT_KIND,
    contactId: binding.contactId,
    runId: binding.runId,
    tenantId: binding.tenantId,
    resumeTokenHash: binding.resumeTokenHash,
    respondedAt,
    responseType,
  }
  if (publication) {
    receipt.publicationId = `hc_pub_${createHash('sha256')
      .update(`${binding.tenantId}\0${binding.runId}\0${binding.contactId}\0${binding.resumeTokenHash}`)
      .digest('hex')
      .slice(0, 32)}`
    receipt.publicationStatus = 'pending'
    receipt.publicationClaimId = publication.claimId
    receipt.publicationLeaseExpiresAt = publication.leaseExpiresAt
  }
  return receipt
}
