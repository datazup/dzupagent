/**
 * Approval primitives shared across the framework.
 *
 * These types live in `@dzupagent/agent-types` (Layer 0) so that
 * `@dzupagent/agent`, `@dzupagent/agent-adapters`, and other consumers
 * can agree on a single canonical contract for human-in-the-loop
 * approval flows without introducing a cross-package dependency.
 */

/** Approval mode determining when human approval is required. */
export type ApprovalMode = 'auto' | 'required' | 'conditional'

/**
 * Outcome of an approval request.
 *
 * - `approved`  — the request was granted.
 * - `rejected`  — the request was explicitly denied.
 * - `timeout`   — no decision was made before the configured deadline.
 * - `cancelled` — the awaiter was cancelled (e.g. parent run aborted)
 *                 before a terminal decision was recorded.
 *
 * The `cancelled` state is observable from in-process approval gates
 * that support cooperative cancellation. Adapters that do not expose
 * cancellation can simply never produce this value.
 */
export type ApprovalResult = 'approved' | 'rejected' | 'timeout' | 'cancelled'
