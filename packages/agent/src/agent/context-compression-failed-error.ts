/**
 * Thrown by the tool loop when context compression fails on TWO consecutive
 * turns (audit finding AGENT-112).
 *
 * Compression failures are normally swallowed because compression is
 * best-effort and must not abort an otherwise-healthy run. However, if the
 * LLM history grows past the model's context window AND compression is
 * persistently failing, the run cannot make further progress: continuing
 * would just rack up budget on doomed LLM calls. Once we observe two
 * consecutive failures we surface a typed error so the run engine can
 * terminate cleanly with a meaningful stop reason.
 */
export class ContextCompressionFailedError extends Error {
  readonly consecutiveFailures: number
  readonly cause?: unknown

  constructor(opts: { consecutiveFailures: number; cause?: unknown; message?: string }) {
    super(
      opts.message
        ?? `Context compression failed ${opts.consecutiveFailures} times in a row; aborting run.`,
    )
    this.name = 'ContextCompressionFailedError'
    this.consecutiveFailures = opts.consecutiveFailures
    if (opts.cause !== undefined) this.cause = opts.cause
  }
}
