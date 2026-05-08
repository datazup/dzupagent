/**
 * Approval-flow integration for the Codex streaming loop.
 *
 * Extracts the in-loop branches for `approval_request` items and `turn.failed`
 * approval-pause detection out of the main runStreamedThread generator into
 * focused helpers. The actual approval-resolution work lives in
 * {@link ../codex-approval} — these helpers are thin adapters that wire the
 * stream events into that flow.
 */
import type {
  AgentInput,
  AgentStreamEvent,
} from '../types.js'
import type {
  CodexApprovalRequestItem,
  CodexInstance,
  CodexStreamEvent,
  CodexThread,
} from './codex-types.js'
import {
  handleApprovalRequest,
  handleTurnFailedApproval,
  type CodexApprovalContext,
} from './codex-approval.js'
import type { RunStreamedThreadContext } from './codex-streamed-thread-types.js'

/**
 * Yield approval-request stream events when an SDK `item.completed` event
 * carries an `approval_request` item.
 */
export async function* handleStreamApprovalRequest(
  event: CodexStreamEvent,
  input: AgentInput,
  providerEventId: string | null,
  parentProviderEventId: string | null,
  ctx: RunStreamedThreadContext,
): AsyncGenerator<AgentStreamEvent, void, undefined> {
  const item = event.item as CodexApprovalRequestItem
  yield* handleApprovalRequest(
    item,
    input,
    providerEventId,
    parentProviderEventId,
    ctx.buildApprovalContext(input),
  )
}

/**
 * Detect whether a `turn.failed` event represents a Codex approval pause
 * (the SDK signals approval-required by failing the turn with a known
 * message phrase). Returns the extracted error message when matched, or
 * `null` when the failure is something else.
 */
export function detectApprovalPause(
  event: CodexStreamEvent,
  input: AgentInput,
  ctx: RunStreamedThreadContext,
): string | null {
  const errObj = event.error
  const errMsg =
    typeof errObj === 'object' && errObj !== null && 'message' in errObj
      ? (errObj as { message: string }).message
      : typeof errObj === 'string'
        ? errObj
        : ''

  const isApprovalPause =
    ctx.isApprovalCapable(input) &&
    /requires approval|user confirmation|permission denied|approval required/i.test(errMsg)

  return isApprovalPause ? errMsg : null
}

/**
 * Drive the approval-pause flow when {@link detectApprovalPause} matches.
 * Resumes the thread via the supplied recursion factory once the resolver
 * settles the request.
 */
export async function* handleStreamTurnFailedApproval(
  errMsg: string,
  input: AgentInput,
  sessionId: string,
  codex: CodexInstance,
  signal: AbortSignal,
  providerEventId: string | null,
  parentProviderEventId: string | null,
  approvalCtx: CodexApprovalContext,
  resumeWithThread: (thread: CodexThread) => AsyncGenerator<AgentStreamEvent, void, undefined>,
): AsyncGenerator<AgentStreamEvent, void, undefined> {
  yield* handleTurnFailedApproval(
    errMsg,
    input,
    sessionId,
    codex,
    signal,
    providerEventId,
    parentProviderEventId,
    approvalCtx,
    resumeWithThread,
  )
}
