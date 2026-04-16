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
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { tool } from '@langchain/core/tools'
import type {
  ContactType,
  ContactChannel,
  HumanContactRequest,
  PendingHumanContact,
} from '@dzupagent/core'

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

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
  channel: z
    .string()
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

// ---------------------------------------------------------------------------
// Pending contact store
// ---------------------------------------------------------------------------

/**
 * Storage interface for pending contacts.
 * In production, backed by the RunStore or a dedicated table.
 * In development/testing, uses in-memory Map.
 */
export interface PendingContactStore {
  save(contact: PendingHumanContact): Promise<void>
  get(contactId: string): Promise<PendingHumanContact | null>
  delete(contactId: string): Promise<void>
}

export class InMemoryPendingContactStore implements PendingContactStore {
  private readonly contacts = new Map<string, PendingHumanContact>()

  async save(contact: PendingHumanContact): Promise<void> {
    this.contacts.set(contact.request.contactId, contact)
  }

  async get(contactId: string): Promise<PendingHumanContact | null> {
    return this.contacts.get(contactId) ?? null
  }

  async delete(contactId: string): Promise<void> {
    this.contacts.delete(contactId)
  }
}

// ---------------------------------------------------------------------------
// Tool config
// ---------------------------------------------------------------------------

export interface HumanContactToolConfig {
  /** Default channel if neither the tool call nor user profile specifies one */
  defaultChannel?: ContactChannel
  /** Store for pending contacts (default: in-memory) */
  pendingStore?: PendingContactStore
  /**
   * Pause callback — called when a human contact suspends the run.
   * In production, this is wired to RunHandle.pause().
   * In testing, can be a mock function.
   */
  onPause?: (contactId: string, request: HumanContactRequest) => Promise<void>
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
  const base = {
    contactId,
    runId,
    channel,
    timeoutAt,
    timeoutFallback: input.fallback,
  }

  if (mode === 'approval') {
    return {
      ...base,
      type: 'approval' as const,
      data: {
        question: input.question ?? 'Approve?',
        context: input.context,
      },
    }
  }
  if (mode === 'clarification') {
    return {
      ...base,
      type: 'clarification' as const,
      data: {
        question: input.question ?? 'Please clarify:',
        context: input.context,
      },
    }
  }
  if (mode === 'input_request') {
    return {
      ...base,
      type: 'input_request' as const,
      data: {
        prompt: input.question ?? 'Please provide input:',
        context: input.context,
      },
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
  const defaultChannel: ContactChannel = config.defaultChannel ?? 'in-app'

  return tool(
    async (input: HumanContactInput): Promise<string> => {
      const contactId = randomUUID()
      const runId = 'unknown'

      // Step 1: Resolve channel (chain of responsibility)
      const channel: ContactChannel =
        (input.channel as ContactChannel | undefined) ?? defaultChannel

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

      // Step 3: Store as pending
      const resumeToken = randomUUID()
      const pending: PendingHumanContact = {
        request,
        resumeToken,
        expiresAt: timeoutAt,
        deliveredTo: channel,
        deliveryStatus: 'pending',
      }
      await pendingStore.save(pending)

      // Step 4: Pause the run
      if (config.onPause) {
        await config.onPause(contactId, request)
      }

      // Return a JSON message the agent sees upon resume
      return JSON.stringify({
        contactId,
        status: 'pending',
        channel,
        message: `Human contact request sent (${input.mode}). Run suspended until response.`,
        resumeWith: `POST /api/runs/${runId}/human-contact/${contactId}/respond`,
      })
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
}
