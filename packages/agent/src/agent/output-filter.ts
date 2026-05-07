/**
 * Pluggable output filter chain for DzupAgent (M-13).
 *
 * Replaces the single `guardrails.outputFilter` function with a composable
 * pipeline of named filters that run in declaration order. Each filter
 * receives the current output string and a lightweight context object
 * carrying agent provenance (agentId, tenantId, runId).
 *
 * Returning `null` from a filter short-circuits the chain and causes the
 * run engine to fall back to the pre-filter content (same semantics as the
 * legacy single-filter contract). Returning a string replaces the content
 * for all subsequent filters.
 *
 * ## Usage
 *
 * ```ts
 * const redact: OutputFilter = {
 *   name: 'pii-redact',
 *   filter(output, ctx) {
 *     return output.replace(/\b\d{4}-\d{4}-\d{4}-\d{4}\b/g, '[REDACTED]')
 *   },
 * }
 *
 * const agent = new DzupAgent({
 *   ...
 *   outputFilters: [redact],
 * })
 * ```
 */

/**
 * Context available to every filter in the chain.
 *
 * All fields are required so filters can make consistent provenance
 * decisions without needing to guard for `undefined`.
 */
export interface OutputFilterContext {
  /** The agent that produced this output. */
  agentId: string
  /** Tenant scope of the run (defaults to `'default'` when not set). */
  tenantId: string
  /** Durable run identifier, empty string when the run has no runId. */
  runId: string
}

/**
 * A single named step in the output filter chain.
 *
 * Filters are applied in the order they appear in
 * {@link DzupAgentConfig.outputFilters}. Each filter receives the output
 * produced by the previous step (or the raw output on the first step).
 *
 * Returning `null` preserves the input to this filter unchanged and skips
 * all subsequent filters (pass-through semantics). Returning a string
 * replaces the content going forward.
 */
export interface OutputFilter {
  /**
   * Unique label for this filter, used in telemetry and debug logs.
   * Does not need to be globally unique — only unique within an agent's
   * filter list.
   */
  name: string

  /**
   * Transform or validate the output content.
   *
   * @param output  The current output string (already passed through any
   *                preceding filters in the chain).
   * @param ctx     Provenance context — agentId, tenantId, runId.
   * @returns The (possibly modified) content string, or `null` to leave
   *          the input unchanged and skip remaining filters.
   */
  filter(
    output: string,
    ctx: OutputFilterContext,
  ): Promise<string | null> | string | null
}

/**
 * Run `output` through the provided filter chain in sequence.
 *
 * Each filter that returns a non-null string advances the chain with the
 * new value; a `null` return short-circuits and preserves the current
 * value. Async and sync filters are both supported.
 *
 * @param output   Raw content to filter.
 * @param filters  Ordered list of filters to apply.
 * @param ctx      Provenance context forwarded to every filter.
 * @returns        The final filtered string.
 */
export async function applyOutputFilterChain(
  output: string,
  filters: OutputFilter[],
  ctx: OutputFilterContext,
): Promise<string> {
  let current = output
  for (const filter of filters) {
    const result = await filter.filter(current, ctx)
    if (result === null) {
      break
    }
    current = result
  }
  return current
}
