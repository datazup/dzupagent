/**
 * RF-04 / SEC-08 — default safety budget for un-guardrailed agent runs.
 *
 * When a `DzupAgentConfig` is constructed without an explicit `guardrails`
 * block, the run-engine installs the budget below as a defence-in-depth
 * measure. Without this, a runaway tool loop or compromised prompt could
 * burn unbounded tokens against the underlying provider.
 *
 * Override by supplying `config.guardrails` (any non-undefined value, including
 * an empty object, opts out of these defaults — empty `guardrails: {}` keeps
 * the legacy permissive behaviour intentionally for callers who have made an
 * informed choice).
 *
 * Mapping into `IterationBudget`:
 * - `IterationBudget` exposes a single combined `maxTokens` cap covering input
 *   + output. The default is set to `inputTokens` (50_000) so that input
 *   spend alone exhausts the budget at parity with the spec, while overall
 *   token cost stays bounded under `inputTokens + outputTokens` (100_000).
 * - `maxIterations` is lowered from the legacy default of 10 to `5` to limit
 *   blast radius for un-guardrailed agents.
 */
export const DEFAULT_UNGUARDED_BUDGET = Object.freeze({
  /** Per-stream input token cap (also serves as the combined `maxTokens`). */
  inputTokens: 50_000,
  /** Per-stream output token cap. */
  outputTokens: 50_000,
  /** Lowered iteration cap when no explicit guardrails were provided. */
  maxIterations: 5,
} as const)

/** Default `maxIterations` when `config.guardrails` IS provided. */
export const DEFAULT_GUARDED_MAX_ITERATIONS = 10

/**
 * Internal: agent ids for which the "no guardrails" warning has already been
 * emitted. Keyed by agent id so two distinct agents constructed without
 * guardrails each get one warning, but repeated `generate()` / `stream()`
 * calls on the same agent stay quiet.
 *
 * Exported only for tests (to clear between cases). Production callers
 * should not touch this.
 */
export const _warnedAgentIds = new Set<string>()
