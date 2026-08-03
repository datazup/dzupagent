/**
 * RF-04 / SEC-08 — default safety budget for un-guardrailed agent runs.
 *
 * When a `DzupAgentConfig` is constructed without an explicit `guardrails`
 * block, the run-engine installs the budget below as a defence-in-depth
 * measure. Without this, a runaway tool loop or compromised prompt could
 * burn unbounded tokens against the underlying provider.
 *
 * Override by supplying `config.guardrails` with at least one cap field
 * (maxIterations, maxTokens, maxCost, etc.). An empty `guardrails: {}` does
 * NOT opt out — it still applies DEFAULT_UNGUARDED_BUDGET so that callers
 * cannot accidentally disable token/iteration caps by passing an empty object.
 * The startup warning is suppressed for explicit (even empty) guardrails.
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
} as const);

/** Default `maxIterations` when `config.guardrails` IS provided. */
export const DEFAULT_GUARDED_MAX_ITERATIONS = 10;

/**
 * ORCH-DSL-L1-H-03 — default per-tool wall-clock deadline.
 *
 * Timeouts are looked up by tool name, and before this default a tool absent
 * from `toolTimeouts` ran with no deadline at all: the fail-open opposite of
 * the fail-closed posture {@link DEFAULT_UNGUARDED_BUDGET} applies to tokens.
 * The whole-run deadline (ORCH-DSL-L1-H-02) does not cover the gap, because
 * `guardrails.maxDurationMs` is itself optional and has no default — and even
 * when set, one hung tool would consume the entire run budget rather than
 * failing fast and letting the loop recover.
 *
 * The value matches the long-standing `defaultToolTimeoutMs` in
 * `production-tool-governance-preset.ts`, which already defaults to 30s; this
 * makes the engine default agree with the preset instead of contradicting it.
 *
 * Opt out per tool with an explicit `Infinity` in `toolTimeouts`, or globally
 * by setting `defaultToolTimeoutMs: Infinity` on the tool-execution policy.
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/**
 * Resolve the deadline for a single tool invocation.
 *
 * Precedence: an explicit per-name entry wins; otherwise the caller-supplied
 * default; otherwise {@link DEFAULT_TOOL_TIMEOUT_MS}. A non-finite or
 * non-positive resolved value means "unbounded" and is returned as `undefined`
 * so `invokeWithOptionalTimeout` installs no timer — the documented opt-out.
 *
 * Shared by the generate and streaming tool paths so the two cannot drift.
 */
export function resolveToolTimeoutMs(
  perToolTimeouts: Record<string, number> | undefined,
  toolName: string,
  defaultToolTimeoutMs: number | undefined = DEFAULT_TOOL_TIMEOUT_MS
): number | undefined {
  const explicit = perToolTimeouts?.[toolName];
  const resolved = explicit ?? defaultToolTimeoutMs;
  if (resolved === undefined) return undefined;
  if (!Number.isFinite(resolved) || resolved <= 0) return undefined;
  return resolved;
}

/**
 * Internal: agent ids for which the "no guardrails" warning has already been
 * emitted. Keyed by agent id so two distinct agents constructed without
 * guardrails each get one warning, but repeated `generate()` / `stream()`
 * calls on the same agent stay quiet.
 *
 * Exported only for tests (to clear between cases). Production callers
 * should not touch this.
 */
export const _warnedAgentIds = new Set<string>();
