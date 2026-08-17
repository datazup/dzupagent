/**
 * Run-lifecycle hook dispatch (`onRunStart` / `onRunComplete` / `onRunError`).
 *
 * These three hooks were declared on {@link AgentHooks} but never dispatched
 * from any production code path — the only callers were tests that invoked the
 * hook by hand, which proved nothing about the runtime. This module supplies
 * the missing dispatchers and the run coordinator calls them at the real run
 * boundary.
 *
 * Shape deliberately mirrors the already-shipped model-lifecycle dispatchers
 * (`runBeforeModelCall` / `runAfterModelCall` / `runOnModelError`):
 *
 *  - dispatch is error-isolated — a throwing hook NEVER breaks the run;
 *  - hook errors surface as `hook:error` on the configured event bus;
 *  - subsequent hooks still run after one throws.
 *
 * All three delegate to core's {@link runHooks}, which already implements
 * exactly that contract, so there is no second, divergent isolation policy.
 *
 * The {@link HookContext} is built by {@link buildModelHookContext} — the same
 * assembler the model hooks use — so `agentId` / `runId` / `eventBus` /
 * `metadata` conventions stay identical across every hook family (notably:
 * `metadata` is a fresh object per run, and `eventBus` is present only when
 * the config carries one).
 */

import { runHooks } from "@dzupagent/core/orchestration";
import type { HookContext } from "@dzupagent/core/orchestration";
import { buildModelHookContext, type ModelHooksConfig } from "./model-hooks.js";

export type { ModelHooksConfig as RunHooksConfig };

/**
 * Build the {@link HookContext} shared by every run-lifecycle hook of a single
 * run.
 *
 * The SAME object is handed to `onRunStart`, then to whichever of
 * `onRunComplete` / `onRunError` terminates the run, so a hook may stash
 * per-run state on `ctx.metadata` at start and read it back at completion.
 * That identity is part of the contract and is asserted by the dispatch specs.
 */
export function buildRunHookContext(
  config: ModelHooksConfig,
  agentId: string,
  runId: string | undefined
): HookContext {
  return buildModelHookContext(config, agentId, runId);
}

/**
 * Wrap a single optional hook in the array shape `runHooks` expects.
 * Returns `undefined` (not `[]`) when unset so `runHooks` short-circuits.
 */
function asHookList<T>(hook: T | undefined): [T] | undefined {
  return hook === undefined ? undefined : [hook];
}

/**
 * Normalise a thrown value into an `Error` for `onRunError`, whose declared
 * contract is `(ctx, error: Error)`.
 *
 * A real `Error` is passed through by IDENTITY — hooks that compare against
 * the error they expect to see propagate out of `generate()` must get the very
 * same instance, not a copy.
 */
export function toRunError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(String(thrown));
}

/** Dispatch `onRunStart` at the top of a run. */
export async function dispatchOnRunStart(
  config: ModelHooksConfig,
  ctx: HookContext
): Promise<void> {
  await runHooks(
    asHookList(config.hooks?.onRunStart),
    config.eventBus,
    "onRunStart",
    ctx
  );
}

/**
 * Dispatch `onRunComplete` for a run that returned a result.
 *
 * Fires for EVERY terminal result the run hands back, whatever the
 * `stopReason` (`complete`, `stuck`, `iteration_limit`, `budget_exceeded`,
 * `error`, …). Rationale: the run produced a result rather than throwing, and
 * `onRunError`'s declared contract requires a real `Error` — synthesising one
 * from a stop reason would fabricate a value no thrower ever produced. A hook
 * that cares about unhappy terminations reads `result.stopReason`, which is
 * carried on the payload.
 */
export async function dispatchOnRunComplete(
  config: ModelHooksConfig,
  ctx: HookContext,
  result: unknown
): Promise<void> {
  await runHooks(
    asHookList(config.hooks?.onRunComplete),
    config.eventBus,
    "onRunComplete",
    ctx,
    result
  );
}

/**
 * Dispatch `onRunError` for a run that threw.
 *
 * The error is dispatched and then RE-THROWN by the caller — this hook is an
 * observer, never a recovery point.
 */
export async function dispatchOnRunError(
  config: ModelHooksConfig,
  ctx: HookContext,
  error: Error
): Promise<void> {
  await runHooks(
    asHookList(config.hooks?.onRunError),
    config.eventBus,
    "onRunError",
    ctx,
    error
  );
}
