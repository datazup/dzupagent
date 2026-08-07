/**
 * CodexRunContext — run-local state for one Codex execution (Packet A).
 *
 * Every `execute()` / `resumeSession()` call creates its own context so two
 * concurrent runs through one adapter instance can never share:
 *
 *   - provider session identity (`sessionId`),
 *   - the in-flight input / resume flag,
 *   - the abort controller (per-run; the caller-provided `AgentInput.signal`
 *     is the authoritative per-turn cancellation, combined with this run's
 *     internal controller for timeout + emergency interrupt routing),
 *   - the interaction resolver for approval flows,
 *   - the adapter config snapshot (provider/model config is immutable for
 *     the lifetime of one execution).
 *
 * The adapter keeps a Set of active contexts; `interrupt()` remains an
 * adapter-wide EMERGENCY operation that aborts every active run. Session
 * runtimes must abort via the caller signal instead.
 */
import type { AdapterConfig, AgentInput } from "../types.js";
import type { InteractionResolver } from "../interaction/interaction-resolver.js";

export interface CodexRunContext {
  /** The input this run was started with. Never shared across runs. */
  readonly input: AgentInput;
  /** Whether this run resumes an existing provider session. */
  readonly isResume: boolean;
  /**
   * Shallow snapshot of the adapter config taken at run start. A concurrent
   * `configure()` cannot change this run's provider/model behavior.
   */
  readonly config: AdapterConfig;
  /**
   * Run-local abort controller. Timeout enforcement and adapter-wide
   * `interrupt()` abort THIS controller only; it is combined with the
   * caller's `input.signal` to form the effective stream signal.
   */
  readonly abortController: AbortController;
  /** Provider session id, assigned when the SDK emits `thread.started`. */
  sessionId: string | null;
  /** Run-local interaction resolver for approval flows (lazily created). */
  resolver: InteractionResolver | null;
}

export function createCodexRunContext(params: {
  input: AgentInput;
  isResume: boolean;
  config: AdapterConfig;
  sessionId?: string | null;
}): CodexRunContext {
  return {
    input: params.input,
    isResume: params.isResume,
    config: { ...params.config },
    abortController: new AbortController(),
    sessionId: params.sessionId ?? null,
    resolver: null,
  };
}

/** Dispose run-local resources at the end of a run. Safe to call once. */
export function disposeCodexRunContext(run: CodexRunContext): void {
  run.resolver?.dispose();
  run.resolver = null;
}
