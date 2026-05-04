/**
 * Errors raised by the durable approval gate.
 *
 * @module approval/approval-errors
 */

/**
 * Thrown by {@link ApprovalGate.requestApproval} when the gate is configured
 * with `durableResume: true` and a `checkpointStore`. The outer run driver
 * is expected to catch this error, persist the suspension, and surface a
 * `{ status: 'suspended', resumeToken }` result so an out-of-process resumer
 * can later complete the run.
 */
export class ApprovalSuspendedError extends Error {
  /** Always `'ApprovalSuspendedError'` for `instanceof`-free callers. */
  public override readonly name = 'ApprovalSuspendedError'

  constructor(
    public readonly resumeToken: string,
    public readonly runId: string,
  ) {
    super(`Approval suspended -- resume with token: ${resumeToken}`)
  }
}
