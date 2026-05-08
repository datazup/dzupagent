/**
 * runStreamedThread — Codex SDK streaming loop.
 *
 * This is the heart of the Codex adapter: it consumes events emitted by the
 * Codex SDK's `thread.runStreamed()` iterable and yields unified
 * {@link AgentStreamEvent}s. It owns:
 *
 *   - Per-call timeout enforcement (config.timeoutMs / DEFAULT_TIMEOUT_MS).
 *   - `runStreamed()` pre-stream phase (may throw/abort before events start).
 *   - Per-event mapping via {@link mapCodexEvent} + {@link wrapRawProviderEvent}.
 *   - Approval-pause handling via the `codex-streamed-thread-approval` helpers
 *     which delegate into `codex-approval.ts`.
 *   - Final `adapter:completed` + optional `adapter:cache_stats` emission.
 *
 * This file is a thin re-export barrel. Implementations live in:
 *  - codex-streamed-thread-types.ts     (RunStreamedThreadContext, DEFAULT_CODEX_TIMEOUT_MS)
 *  - codex-streamed-thread-events.ts    (wrapRawProviderEvent, combineSignals,
 *                                        buildAdapterStartedEvent)
 *  - codex-streamed-thread-approval.ts  (approval-request + turn.failed approval-pause)
 *  - codex-streamed-thread-loop.ts      (runStreamedThread async generator)
 */

export type { RunStreamedThreadContext } from './codex-streamed-thread-types.js'
export { DEFAULT_CODEX_TIMEOUT_MS } from './codex-streamed-thread-types.js'
export {
  buildAdapterStartedEvent,
  combineSignals,
  wrapRawProviderEvent,
} from './codex-streamed-thread-events.js'
export {
  detectApprovalPause,
  handleStreamApprovalRequest,
  handleStreamTurnFailedApproval,
} from './codex-streamed-thread-approval.js'
export { runStreamedThread } from './codex-streamed-thread-loop.js'
