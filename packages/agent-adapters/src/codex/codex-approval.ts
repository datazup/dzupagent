/**
 * Approval-flow helpers for the Codex adapter.
 *
 * Codex emits two flavors of approval signals during a streaming turn:
 *
 *   1. `item.completed` with `item.type === 'approval_request'` — a structured
 *      observed interaction. The exposed SDK has no reply channel for it;
 *      the caller must stop the run unless auto-approve was explicitly selected.
 *
 *   2. `turn.failed` with an approval-shaped error message — an older code
 *      path where the SDK terminates the turn instead of pausing it. Caller
 *      approval cannot be delivered by replaying the failed prompt.
 *
 * Both flows yield {@link AgentStreamEvent}s so the streaming loop in
 * `codex-streamed-thread.ts` can stay focused on SDK iteration.
 */

import { randomUUID } from 'node:crypto'
import { withCorrelationId } from '../types.js'
import type {
  AdapterProviderId,
  AgentStreamEvent,
  AgentInput,
  InteractionPolicy,
} from '../types.js'
import type { InteractionResolver, InteractionResult } from '../interaction/interaction-resolver.js'
import {
  makeFailedEvent,
  makeInteractionRequiredEvent,
  makeInteractionResolvedEvent,
} from '../events/event-factories.js'
import type {
  CodexApprovalRequestItem,
  CodexInstance,
  CodexThread,
  CodexThreadOptions,
} from './codex-types.js'
import { annotateProviderIdentity, now } from './codex-helpers.js'

/**
 * Per-call dependencies the approval helpers need. Built by
 * `CodexAdapter.buildApprovalContext()` so it can wire instance state
 * (resolver, thread-options builder) into pure helper calls.
 */
export interface CodexApprovalContext {
  providerId: AdapterProviderId
  policy: InteractionPolicy
  resolver: InteractionResolver
  buildThreadOptions: (input: AgentInput) => CodexThreadOptions
}

/**
 * Handle an `approval_request` item mid-stream. Yields events for
 * `interaction_required` (if ask-caller mode) and `interaction_resolved`,
 * then returns the decision for enforcement by the streaming loop.
 */
export async function* handleApprovalRequest(
  item: CodexApprovalRequestItem,
  input: AgentInput,
  providerEventId: string | null,
  parentProviderEventId: string | null,
  ctx: CodexApprovalContext,
): AsyncGenerator<AgentStreamEvent, InteractionResult, undefined> {
  const interactionId = randomUUID()
  const ts = now()

  // Register before publishing so callers can respond while consuming the event.
  const resolution = ctx.resolver.resolve({
    interactionId,
    question: item.message,
    kind: item.kind,
  })

  if (ctx.policy.mode === 'ask-caller') {
    yield annotateProviderIdentity(
      withCorrelationId(
        makeInteractionRequiredEvent({
          providerId: ctx.providerId,
          interactionId,
          question: item.message,
          kind: item.kind,
          timestamp: ts,
          expiresAt: ts + (ctx.policy.askCaller?.timeoutMs ?? 60_000),
        }),
        input.correlationId,
      ),
      providerEventId,
      parentProviderEventId,
    )
  }

  const result = await resolution

  yield annotateProviderIdentity(
    withCorrelationId(
      makeInteractionResolvedEvent({
        providerId: ctx.providerId,
        interactionId,
        question: item.message,
        answer: result.answer,
        resolvedBy: result.resolvedBy,
        timestamp: now(),
      }),
      input.correlationId,
    ),
    providerEventId,
    parentProviderEventId,
  )
  return result
}

/**
 * Handle a `turn.failed` event that represents an approval pause. Yields
 * interaction events and fails closed when a caller decision has no native
 * response channel. Preserve the explicitly selected auto-approve legacy path.
 *
 * The caller MUST `return` after this generator finishes — the resumed
 * thread is a complete sub-turn that emits its own `adapter:completed`.
 */
export async function* handleTurnFailedApproval(
  errMsg: string,
  input: AgentInput,
  sessionId: string,
  codex: CodexInstance,
  _signal: AbortSignal,
  providerEventId: string | null,
  parentProviderEventId: string | null,
  ctx: CodexApprovalContext,
  resumeFn: (resumed: CodexThread) => AsyncGenerator<AgentStreamEvent, void, undefined>,
): AsyncGenerator<AgentStreamEvent, void, undefined> {
  const interactionId = randomUUID()
  const ts = now()

  // Register before publishing so callers can respond while consuming the event.
  const resolution = ctx.resolver.resolve({
    interactionId,
    question: errMsg,
    kind: 'permission',
  })

  if (ctx.policy.mode === 'ask-caller') {
    yield annotateProviderIdentity(
      withCorrelationId(
        makeInteractionRequiredEvent({
          providerId: ctx.providerId,
          interactionId,
          question: errMsg,
          kind: 'permission',
          timestamp: ts,
          expiresAt: ts + (ctx.policy.askCaller?.timeoutMs ?? 60_000),
        }),
        input.correlationId,
      ),
      providerEventId,
      parentProviderEventId,
    )
  }

  const result = await resolution

  yield annotateProviderIdentity(
    withCorrelationId(
      makeInteractionResolvedEvent({
        providerId: ctx.providerId,
        interactionId,
        question: errMsg,
        answer: result.answer,
        resolvedBy: result.resolvedBy,
        timestamp: now(),
      }),
      input.correlationId,
    ),
    providerEventId,
    parentProviderEventId,
  )

  const approved = result.answer === 'yes' || result.answer === 'approve'
  if (approved && ctx.policy.mode === 'auto-approve') {
    const approvalThread = codex.resumeThread(sessionId, ctx.buildThreadOptions(input))
    yield* resumeFn(approvalThread)
  } else {
    yield withCorrelationId(
      makeFailedEvent({
        providerId: ctx.providerId,
        sessionId,
        error: approved
          ? 'Codex SDK exposes no response channel for this failed turn; prompt replay is unsupported'
          : `Interaction denied by policy: ${errMsg}`,
        code: approved ? 'INTERACTION_RESPONSE_UNSUPPORTED' : 'INTERACTION_DENIED',
        timestamp: now(),
      }),
      input.correlationId,
    )
  }
}
