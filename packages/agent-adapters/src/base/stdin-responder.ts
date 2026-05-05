import { randomUUID } from 'node:crypto'

import type {
  AdapterProviderId,
  AgentEvent,
  AgentInput,
  InteractionPolicy,
} from '../types.js'
import { withCorrelationId } from '../types.js'
import type { InteractionKind } from '../interaction/interaction-detector.js'
import type { InteractionResolver } from '../interaction/interaction-resolver.js'
import type { GovernanceEmitter } from './governance-emitter.js'

export type StdinResponder = (
  record: Record<string, unknown>,
  question: string,
  kind: InteractionKind,
) => Promise<string | null>

interface CreateStdinResponderOpts {
  providerId: AdapterProviderId
  resolver: InteractionResolver
  policy: InteractionPolicy
  input: AgentInput
  sessionId: string
  pendingEvents: AgentEvent[]
  governance: GovernanceEmitter
}

/**
 * Build the stdinResponder closure used by the spawn loop to answer
 * interactive prompts from the CLI process. Mirrors every prompt and
 * resolution onto both the AgentEvent stream (via `pendingEvents`) and
 * the governance side-channel.
 */
export function createStdinResponder(opts: CreateStdinResponderOpts): StdinResponder {
  const { providerId, resolver, policy, input, sessionId, pendingEvents, governance } = opts
  return async (_record, question, kind) => {
    const interactionId = randomUUID()
    const timeoutMs = policy.askCaller?.timeoutMs ?? 60_000
    const now = Date.now()
    const runId = input.correlationId ?? sessionId

    if (policy.mode === 'ask-caller') {
      pendingEvents.push(withCorrelationId({
        type: 'adapter:interaction_required',
        providerId,
        interactionId,
        question,
        kind,
        timestamp: now,
        expiresAt: now + timeoutMs,
      }, input.correlationId))
    }

    // Governance side-channel: mirror every interaction request as an
    // approval_requested event regardless of policy mode so the audit
    // trail captures auto-approved prompts too.
    governance.emit({
      type: 'governance:approval_requested',
      runId,
      sessionId,
      interactionId,
      providerId,
      timestamp: now,
      prompt: question,
    })

    const result = await resolver.resolve({ interactionId, question, kind })

    pendingEvents.push(withCorrelationId({
      type: 'adapter:interaction_resolved',
      providerId,
      interactionId,
      question,
      answer: result.answer,
      resolvedBy: result.resolvedBy,
      timestamp: Date.now(),
    }, input.correlationId))

    // Governance side-channel: mirror resolution with a normalized
    // resolution field distinct from the detailed resolvedBy.
    governance.emit({
      type: 'governance:approval_resolved',
      runId,
      sessionId,
      interactionId,
      providerId,
      timestamp: Date.now(),
      resolution: mapResolvedByToResolution(result.resolvedBy),
    })

    return result.answer
  }
}

/**
 * Map an interaction-resolver `resolvedBy` value to the normalized
 * governance `resolution` field. Everything that is not an explicit
 * caller-provided allow/deny is classified as `auto`.
 */
function mapResolvedByToResolution(
  resolvedBy: 'auto-approve' | 'auto-deny' | 'default-answers' | 'ai-autonomous' | 'caller' | 'timeout-fallback',
): 'approved' | 'denied' | 'auto' {
  if (resolvedBy === 'auto-approve') return 'approved'
  if (resolvedBy === 'auto-deny') return 'denied'
  return 'auto'
}
