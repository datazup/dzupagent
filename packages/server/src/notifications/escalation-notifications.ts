/**
 * Escalation notifications — maps `@dzupagent/hitl-kit` `EscalationEngine`
 * events onto {@link Notification}s so approval escalation reaches the
 * configured channels (Slack, email webhook, ...).
 *
 * The event shape is mirrored structurally (not imported) so this module does
 * not depend on hitl-kit's build output. Pass the handler from
 * {@link createEscalationNotificationHandler} as the engine's `onEvent`.
 */
import type { Notification, Notifier } from './notifier.js'

/** Structural mirror of hitl-kit `EscalationEvent`. */
export type EscalationEventLike =
  | { type: 'level_started'; level: number; approvers: string[]; at: number; deadline: number }
  | { type: 'level_timed_out'; level: number; at: number }
  | {
      type: 'decided'
      level: number
      approverId: string
      decision: 'granted' | 'rejected'
      reason?: string
      at: number
    }
  | {
      type: 'exhausted'
      action: 'reject' | 'approve'
      decision: 'granted' | 'rejected'
      at: number
    }

export interface EscalationNotificationContext {
  /** Approval request id; prefixes notification ids for de-duplication. */
  approvalId: string
  runId?: string
  agentId?: string
}

export interface EscalationNotificationHandlerOptions {
  /** Receives asynchronous delivery failures. Defaults to ignoring them. */
  onError?: (error: unknown) => void
}

/**
 * Convert one escalation event into a notification. The id is deterministic
 * (`<approvalId>:<type>:<level|final>`). A decision's free-text `reason` is
 * deliberately not forwarded to channels.
 */
export function escalationEventToNotification(
  event: EscalationEventLike,
  context: EscalationNotificationContext,
): Notification {
  const { approvalId } = context
  const base = {
    runId: context.runId,
    agentId: context.agentId,
    timestamp: new Date(event.at),
  }

  switch (event.type) {
    case 'level_started': {
      const escalated = event.level > 0
      return {
        ...base,
        id: `${approvalId}:level_started:${event.level}`,
        tier: 'human-required',
        priority: escalated ? 'critical' : 'high',
        title: escalated
          ? `Approval escalated to level ${event.level}`
          : 'Approval requested',
        body:
          `Approval ${approvalId} awaits a decision from: ${event.approvers.join(', ')}. ` +
          `Deadline: ${new Date(event.deadline).toISOString()}.`,
        eventType: 'approval:escalation_level_started',
        metadata: {
          approvalId,
          level: event.level,
          approvers: [...event.approvers],
          deadline: event.deadline,
        },
      }
    }
    case 'level_timed_out':
      return {
        ...base,
        id: `${approvalId}:level_timed_out:${event.level}`,
        tier: 'human-required',
        priority: 'high',
        title: `Approval level ${event.level} timed out`,
        body: `No decision on approval ${approvalId} at level ${event.level} before its deadline.`,
        eventType: 'approval:escalation_timed_out',
        metadata: { approvalId, level: event.level },
      }
    case 'decided':
      return {
        ...base,
        id: `${approvalId}:decided:${event.level}`,
        tier: 'agent-handled',
        priority: 'normal',
        title: `Approval ${event.decision}`,
        body: `Approval ${approvalId} was ${event.decision} by ${event.approverId} at level ${event.level}.`,
        eventType: 'approval:escalation_decided',
        metadata: {
          approvalId,
          level: event.level,
          approverId: event.approverId,
          decision: event.decision,
        },
      }
    case 'exhausted':
      return {
        ...base,
        id: `${approvalId}:exhausted:final`,
        tier: 'human-required',
        priority: 'critical',
        title: 'Approval escalation exhausted',
        body:
          `Every escalation level for approval ${approvalId} timed out; ` +
          `the request was ${event.decision} by default (${event.action}).`,
        eventType: 'approval:escalation_exhausted',
        metadata: { approvalId, action: event.action, decision: event.decision },
      }
  }
}

/**
 * Build a synchronous `onEvent` handler for `EscalationEngine`. Delivery is
 * fire-and-forget: the handler never throws into the engine, and async
 * failures go to `options.onError`.
 */
export function createEscalationNotificationHandler(
  notifier: Pick<Notifier, 'notify'>,
  context: EscalationNotificationContext,
  options: EscalationNotificationHandlerOptions = {},
): (event: EscalationEventLike) => void {
  const onError = options.onError ?? (() => {})
  return (event) => {
    try {
      notifier.notify(escalationEventToNotification(event, context)).catch(onError)
    } catch (error) {
      onError(error)
    }
  }
}
