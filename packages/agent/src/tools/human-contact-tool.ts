/**
 * HumanContactTool — built-in tool for human-in-the-loop interactions.
 *
 * When an agent calls this tool, it:
 * 1. Creates a HumanContactRequest with a unique contactId
 * 2. Resolves the delivery channel (4-step chain)
 * 3. Suspends the run (via the run's pause mechanism)
 * 4. Stores the pending contact for later resolution
 *
 * The run resumes when the human responds via:
 * - The server route: POST /api/runs/:id/human-contact/:contactId/respond
 * - Or directly via RunHandle.resume({ humanResponse: ... })
 *
 * Channel resolution order:
 * 1. Explicit channel in tool call
 * 2. User profile preferred channel (not implemented in v1 — skipped)
 * 3. Agent config default channel
 * 4. 'in-app' fallback
 */
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { tool } from '@langchain/core/tools'
import type { ContactType, ContactChannel, HumanContactRequest, PendingHumanContact } from '@dzupagent/core/tools'
import { omitUndefined } from '../utils/exact-optional.js'
import { setToolTier } from './tool-tier-registry.js'
import {
  readHumanContactInvocationContext,
} from './human-contact-invocation.js'

export {
  HUMAN_CONTACT_RUNNABLE_CONFIG_KEY,
  humanContactRunnableConfig,
  readHumanContactInvocationContext,
} from './human-contact-invocation.js'
export type {
  HumanContactInvocationContext,
  HumanContactRunContext,
} from './human-contact-invocation.js'

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

export const SUPPORTED_CONTACT_CHANNELS = [
  'in-app',
  'slack',
  'email',
  'webhook',
] as const

const supportedContactChannelSchema = z.enum(SUPPORTED_CONTACT_CHANNELS)

const humanContactInputSchema = z.object({
  mode: z
    .string()
    .describe(
      'Contact mode: approval | clarification | input_request | escalation | custom',
    ),
  question: z
    .string()
    .optional()
    .describe('For clarification/approval: the question to ask'),
  context: z
    .string()
    .optional()
    .describe('Additional context for the human'),
  channel: supportedContactChannelSchema
    .optional()
    .describe(
      'Preferred delivery channel: in-app | slack | email | webhook',
    ),
  timeoutHours: z
    .number()
    .optional()
    .default(24)
    .describe('Hours before auto-timeout (default: 24)'),
  fallback: z.unknown().optional().describe('Value to use on timeout'),
  data: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Mode-specific structured data'),
})

export type HumanContactInput = z.infer<typeof humanContactInputSchema>

/** Agent-owned lifecycle fields layered over the shared legacy contact type. */
export type PendingContactRecord = PendingHumanContact & {
  tenantId: string
  invocationId: string
  invocationDigest: string
  lifecycleStatus: 'preparing' | 'paused' | 'failed'
  /** Opaque, short-lived ownership claim; never model-visible. */
  pauseLeaseId?: string
  pauseLeaseExpiresAt?: string
}

function requireSupportedChannel(
  value: ContactChannel,
  source: 'configured default' | 'resolver',
): ContactChannel {
  const parsed = supportedContactChannelSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error(
      `HUMAN_CONTACT_CHANNEL_UNSUPPORTED: ${source} must be one of ${SUPPORTED_CONTACT_CHANNELS.join(', ')}`,
    )
  }
  return parsed.data
}

// ---------------------------------------------------------------------------
// Pending contact store
// ---------------------------------------------------------------------------

/**
 * Storage interface for pending contacts.
 * In production, backed by the RunStore or a dedicated table.
 * In development/testing, uses in-memory Map.
 */
export interface PendingContactStore {
  /** Atomically create by contactId, returning the existing record on replay. */
  create(contact: PendingContactRecord): Promise<PendingContactCreateResult>
  /** Persist a lifecycle transition for an existing contact. */
  save(contact: PendingContactRecord): Promise<void>
  get(contactId: string, runId?: string): Promise<PendingContactRecord | null>
  delete(contactId: string, runId?: string): Promise<void>
  /** Atomically lease a preparing reservation to one pause adapter caller. */
  claimPause?(
    contactId: string,
    claim: PendingContactPauseClaim,
  ): Promise<PendingContactPauseClaimResult>
  /** Atomically move a lease-owned reservation to its next lifecycle state. */
  transition?(
    contactId: string,
    transition: PendingContactTransition,
  ): Promise<PendingContactTransitionResult>
}

export interface PendingContactCreateResult {
  created: boolean
  contact: PendingContactRecord
}

export interface PendingContactPauseClaim {
  runId: string
  claimId: string
  now: string
  leaseExpiresAt: string
}

export interface PendingContactPauseClaimResult {
  claimed: boolean
  contact: PendingContactRecord
}

export interface PendingContactTransition {
  runId: string
  expected: 'preparing'
  next: 'paused' | 'failed'
  claimId: string
  deliveryStatus: PendingContactRecord['deliveryStatus']
}

export interface PendingContactTransitionResult {
  transitioned: boolean
  contact: PendingContactRecord
}

export class InMemoryPendingContactStore implements PendingContactStore {
  private readonly contacts = new Map<string, PendingContactRecord>()

  async create(contact: PendingContactRecord): Promise<PendingContactCreateResult> {
    const contactId = contact.request.contactId
    const existing = this.contacts.get(contactId)
    if (existing) return { created: false, contact: existing }
    this.contacts.set(contactId, contact)
    return { created: true, contact }
  }

  async save(contact: PendingContactRecord): Promise<void> {
    this.contacts.set(contact.request.contactId, contact)
  }

  async get(contactId: string): Promise<PendingContactRecord | null> {
    return this.contacts.get(contactId) ?? null
  }

  async delete(contactId: string): Promise<void> {
    this.contacts.delete(contactId)
  }

  async claimPause(
    contactId: string,
    claim: PendingContactPauseClaim,
  ): Promise<PendingContactPauseClaimResult> {
    const contact = this.contacts.get(contactId)
    if (!contact) throw new Error('PENDING_CONTACT_NOT_FOUND')
    if (contact.lifecycleStatus !== 'preparing') {
      return { claimed: false, contact }
    }
    const leaseIsActive = contact.pauseLeaseId !== undefined
      && contact.pauseLeaseExpiresAt !== undefined
      && Date.parse(contact.pauseLeaseExpiresAt) > Date.parse(claim.now)
      && contact.pauseLeaseId !== claim.claimId
    if (leaseIsActive) return { claimed: false, contact }
    const leased = {
      ...contact,
      pauseLeaseId: claim.claimId,
      pauseLeaseExpiresAt: claim.leaseExpiresAt,
    }
    this.contacts.set(contactId, leased)
    return { claimed: true, contact: leased }
  }

  async transition(
    contactId: string,
    transition: PendingContactTransition,
  ): Promise<PendingContactTransitionResult> {
    const contact = this.contacts.get(contactId)
    if (!contact) throw new Error('PENDING_CONTACT_NOT_FOUND')
    if (
      contact.lifecycleStatus !== transition.expected
      || contact.pauseLeaseId !== transition.claimId
    ) {
      return { transitioned: false, contact }
    }
    const next: PendingContactRecord = {
      ...contact,
      lifecycleStatus: transition.next,
      deliveryStatus: transition.deliveryStatus,
    }
    delete next.pauseLeaseId
    delete next.pauseLeaseExpiresAt
    this.contacts.set(contactId, next)
    return { transitioned: true, contact: next }
  }
}

// ---------------------------------------------------------------------------
// Tool config
// ---------------------------------------------------------------------------

export interface HumanContactToolConfig {
  /** Default channel if neither the tool call nor user profile specifies one */
  defaultChannel?: ContactChannel
  /**
   * App-neutral preferred-channel lookup. Receives identity only; contact
   * content and delivery targets are deliberately excluded.
   */
  resolvePreferredChannel?: PreferredContactChannelResolver
  /** Store for pending contacts (default: in-memory) */
  pendingStore?: PendingContactStore
  /**
   * Pause callback — called when a human contact suspends the run.
   * In production, this is wired to RunHandle.pause().
   * In testing, can be a mock function.
   */
  onPause?: (
    contactId: string,
    request: HumanContactRequest,
    context: HumanContactPauseContext,
  ) => Promise<void>
  /** Bounded ownership lease for recoverable pause acknowledgement. */
  pauseLeaseMs?: number
}

export interface HumanContactPauseContext {
  runId: string
  tenantId: string
  invocationId: string
  resumeToken: string
}

export interface PreferredContactChannelContext {
  runId: string
  tenantId: string
  profileKey?: string
}

export type PreferredContactChannelResolver = (
  context: PreferredContactChannelContext,
) => Promise<ContactChannel | null | undefined>

async function resolveContactChannel(
  input: HumanContactInput,
  config: HumanContactToolConfig,
  context: PreferredContactChannelContext,
  defaultChannel: ContactChannel,
): Promise<ContactChannel> {
  if (input.channel !== undefined) return input.channel
  if (config.resolvePreferredChannel === undefined) return defaultChannel

  let preferred: ContactChannel | null | undefined
  try {
    preferred = await config.resolvePreferredChannel(context)
  } catch {
    throw new Error(
      'HUMAN_CONTACT_PREFERENCE_RESOLUTION_FAILED: preferred channel could not be resolved',
    )
  }
  if (preferred == null) return defaultChannel
  return requireSupportedChannel(preferred, 'resolver')
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function digestText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function contactIdFor(context: {
  runId: string
  tenantId: string
  invocationId: string
}): string {
  const digest = digestText(
    `dzupagent-human-contact-v1\0${context.tenantId}\0${context.runId}\0${context.invocationId}`,
  )
  return `hc_${digest.slice(0, 32)}`
}

function invocationDigest(input: HumanContactInput): string {
  return digestText(canonicalJson(input))
}

function assertMatchingReservation(
  contact: PendingContactRecord,
  context: { runId: string; tenantId: string; invocationId: string },
  expectedInvocationDigest: string,
): void {
  if (
    contact.request.runId !== context.runId
    || contact.tenantId !== context.tenantId
    || contact.invocationId !== context.invocationId
    || contact.invocationDigest !== expectedInvocationDigest
  ) {
    throw new Error(
      'HUMAN_CONTACT_INVOCATION_CONFLICT: contact identity already belongs to different input',
    )
  }
}

function pendingResult(contact: PendingContactRecord): string {
  const { request } = contact
  return JSON.stringify({
    contactId: request.contactId,
    status: 'pending',
    channel: request.channel,
    message: `Human contact request sent (${request.type}). Run suspended until response.`,
    resumeWith: `POST /api/runs/${request.runId}/human-contact/${request.contactId}/respond`,
  })
}

function terminalPauseError(status: 'failed' | 'preparing'): Error {
  return new Error(
    status === 'failed'
      ? 'HUMAN_CONTACT_PAUSE_FAILED: pause adapter did not acknowledge the contact'
      : 'HUMAN_CONTACT_PAUSE_COMMIT_FAILED: pause acknowledgement was not durably recorded',
  )
}

// ---------------------------------------------------------------------------
// Request builder
// ---------------------------------------------------------------------------

function buildRequest(
  mode: ContactType,
  contactId: string,
  runId: string,
  input: HumanContactInput,
  channel: ContactChannel,
  timeoutAt?: string,
): HumanContactRequest {
  const base = omitUndefined({
    contactId,
    runId,
    channel,
    timeoutAt,
    timeoutFallback: input.fallback,
  })

  if (mode === 'approval') {
    return {
      ...base,
      type: 'approval' as const,
      data: omitUndefined({
        question: input.question ?? 'Approve?',
        context: input.context,
      }),
    }
  }
  if (mode === 'clarification') {
    return {
      ...base,
      type: 'clarification' as const,
      data: omitUndefined({
        question: input.question ?? 'Please clarify:',
        context: input.context,
      }),
    }
  }
  if (mode === 'input_request') {
    return {
      ...base,
      type: 'input_request' as const,
      data: omitUndefined({
        prompt: input.question ?? 'Please provide input:',
        context: input.context,
      }),
    }
  }
  if (mode === 'escalation') {
    return {
      ...base,
      type: 'escalation' as const,
      data: {
        summary: input.question ?? 'Escalated',
        reason: input.context ?? 'Agent cannot proceed',
      },
    }
  }
  // Generic/custom mode
  return {
    ...base,
    type: mode,
    data: input.data ?? {},
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a LangChain-compatible StructuredTool that suspends agent runs
 * for human-in-the-loop interaction.
 *
 * @param config - optional configuration (default channel, store, pause callback)
 * @returns a StructuredToolInterface usable with any LangChain agent
 */
export function createHumanContactTool(
  config: HumanContactToolConfig = {},
): StructuredToolInterface {
  const pendingStore =
    config.pendingStore ?? new InMemoryPendingContactStore()
  const defaultChannel = requireSupportedChannel(
    config.defaultChannel ?? 'in-app',
    'configured default',
  )
  const pauseLeaseMs = config.pauseLeaseMs ?? 30_000
  if (!Number.isFinite(pauseLeaseMs) || pauseLeaseMs <= 0) {
    throw new Error('HUMAN_CONTACT_PAUSE_LEASE_INVALID')
  }

  const humanContactTool = tool(
    async (input: HumanContactInput, runnableConfig): Promise<string> => {
      const invocationContext = readHumanContactInvocationContext(runnableConfig)
      const { runId } = invocationContext
      const contactId = contactIdFor(invocationContext)
      const inputDigest = invocationDigest(input)

      let existing: PendingContactRecord | null
      try {
        existing = await pendingStore.get(contactId, runId)
      } catch {
        throw new Error(
          'HUMAN_CONTACT_RESERVATION_FAILED: pending contact store could not be read',
        )
      }
      if (existing) {
        assertMatchingReservation(existing, invocationContext, inputDigest)
        if (existing.lifecycleStatus === 'paused') return pendingResult(existing)
        if (existing.lifecycleStatus === 'failed') throw terminalPauseError('failed')
      }

      // Step 1: Resolve channel (chain of responsibility)
      const channel = existing?.request.channel ?? await resolveContactChannel(
          input,
          config,
          omitUndefined({
            runId: invocationContext.runId,
            tenantId: invocationContext.tenantId,
            profileKey: invocationContext.profileKey,
          }),
          defaultChannel,
        )

      // Step 2: Build the request
      const timeoutAt =
        input.timeoutHours != null
          ? new Date(
              Date.now() + input.timeoutHours * 3600 * 1000,
            ).toISOString()
          : undefined

      const request: HumanContactRequest = buildRequest(
          input.mode as ContactType,
          contactId,
          runId,
          input,
          channel,
          timeoutAt,
        )

      // Step 3: Atomically reserve a recoverable preparing record.
      const proposed: PendingContactRecord = omitUndefined({
        request,
        tenantId: invocationContext.tenantId,
        invocationId: invocationContext.invocationId,
        invocationDigest: inputDigest,
        resumeToken: randomUUID(),
        expiresAt: timeoutAt,
        deliveredTo: channel,
        deliveryStatus: 'pending',
        lifecycleStatus: 'preparing',
      })
      let pending: PendingContactRecord
      try {
        const reservation = existing
          ? { created: false, contact: existing }
          : await pendingStore.create(proposed)
        pending = reservation.contact
      } catch {
        throw new Error(
          'HUMAN_CONTACT_RESERVATION_FAILED: pending contact could not be reserved',
        )
      }
      assertMatchingReservation(pending, invocationContext, inputDigest)
      if (pending.lifecycleStatus === 'paused') return pendingResult(pending)
      if (pending.lifecycleStatus === 'failed') throw terminalPauseError('failed')

      const claimId = randomUUID()
      if (pendingStore.claimPause) {
        const now = new Date()
        let claim: PendingContactPauseClaimResult
        try {
          claim = await pendingStore.claimPause(contactId, {
            runId,
            claimId,
            now: now.toISOString(),
            leaseExpiresAt: new Date(now.getTime() + pauseLeaseMs).toISOString(),
          })
        } catch {
          throw new Error(
            'HUMAN_CONTACT_RESERVATION_FAILED: pause ownership could not be claimed',
          )
        }
        pending = claim.contact
        if (!claim.claimed) {
          if (pending.lifecycleStatus === 'paused') return pendingResult(pending)
          if (pending.lifecycleStatus === 'failed') throw terminalPauseError('failed')
          throw new Error(
            'HUMAN_CONTACT_PAUSE_IN_PROGRESS: another caller owns pause acknowledgement',
          )
        }
      }

      // Step 4: Pause the run
      try {
        if (config.onPause) {
          await config.onPause(contactId, request, {
            runId,
            tenantId: invocationContext.tenantId,
            invocationId: invocationContext.invocationId,
            resumeToken: pending.resumeToken,
          })
        }
      } catch {
        try {
          if (pendingStore.transition) {
            await pendingStore.transition(contactId, {
              runId,
              expected: 'preparing',
              next: 'failed',
              claimId,
              deliveryStatus: 'failed',
            })
          } else {
            await pendingStore.save({
              ...pending,
              deliveryStatus: 'failed',
              lifecycleStatus: 'failed',
            })
          }
        } catch {
          throw new Error(
            'HUMAN_CONTACT_PAUSE_RECOVERY_FAILED: pause failure state could not be recorded',
          )
        }
        throw terminalPauseError('failed')
      }

      let paused: PendingContactRecord = {
        ...pending,
        lifecycleStatus: 'paused',
      }
      try {
        if (pendingStore.transition) {
          const transition = await pendingStore.transition(contactId, {
            runId,
            expected: 'preparing',
            next: 'paused',
            claimId,
            deliveryStatus: pending.deliveryStatus,
          })
          if (!transition.transitioned) {
            if (transition.contact.lifecycleStatus === 'paused') {
              paused = transition.contact
            } else {
              throw new Error('conditional transition lost')
            }
          } else {
            paused = transition.contact
          }
        } else {
          await pendingStore.save(paused)
        }
      } catch {
        throw terminalPauseError('preparing')
      }

      // Return only after pause acknowledgement is durably recorded.
      return pendingResult(paused)
    },
    {
      name: 'human_contact',
      description:
        'Request input, approval, or clarification from a human. ' +
        'Suspends the current run until a human responds. ' +
        'Modes: approval (yes/no decision), clarification (free-form answer), ' +
        'input_request (structured data), escalation (hand off to human).',
      schema: humanContactInputSchema,
    },
  )
  // Human contact persists pending state, may cross an external delivery
  // channel, and suspends the run. It must never inherit the compatibility
  // read-only tier merely because the LangChain type has no metadata slot.
  setToolTier(humanContactTool, 'full-access')
  return humanContactTool
}
