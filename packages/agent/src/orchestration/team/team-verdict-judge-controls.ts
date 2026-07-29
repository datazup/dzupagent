/**
 * Cost, latency, and budget controls for a {@link JudgeInvoker}.
 *
 * ## Why these are wrappers, not options on the judge service
 *
 * `createLlmJudgeVerdictService` takes a bare `JudgeInvoker` callback precisely
 * so it owns no provider concerns. Adding `timeoutMs` / `maxCalls` / a cache to
 * its options would pull all three back into the verdict service and make them
 * available *only* there. Expressed as `JudgeInvoker -> JudgeInvoker` decorators
 * they compose in any order, are independently testable, and apply to any other
 * invoker a host writes.
 *
 * The intended composition — cache outermost, timeout innermost:
 *
 * ```ts
 * const judge = withJudgeCache(
 *   withJudgeBudget(withJudgeTimeout(rawInvoker, { timeoutMs: 30_000 }), {
 *     maxCalls: 100,
 *   })
 * )
 * ```
 *
 * Order matters, and the rule is that a wrapper only governs what it actually
 * delegates to. Calls flow OUTERMOST-IN, so the outermost wrapper is the one
 * that runs first and can short-circuit the rest:
 *
 * - Cache OUTSIDE budget — a cache hit costs nothing, so it must not consume
 *   budget. Inverted, the budget wrapper runs first and charges for a call the
 *   cache would have served for free, exhausting a budget never actually spent.
 * - Budget OUTSIDE timeout — the budget admits the call, then the timeout
 *   bounds the real request it wraps.
 * - Cache OUTSIDE timeout (transitively) — a hit returns the memoized promise
 *   without arming a timer at all.
 *
 * Note that "outside" here means *earlier in the call path*, which reads as the
 * OUTER function call in source — `withJudgeCache(withJudgeBudget(...))` puts
 * the cache outside. The nesting is easy to invert by accident; the
 * `composition order` tests pin both claims.
 *
 * ## Why a judge failure is never fabricated into a score
 *
 * ## Why the wrappers brand what they return
 *
 * Each control marks its returned invoker with {@link JUDGE_GUARDED}, and
 * `createLlmJudgeVerdictService` reads that mark to warn when a judge arrives
 * with no latency or cost control at all. The brand accumulates through
 * composition, so an outer wrapper never hides an inner guard.
 *
 * The mark is a positive declaration only: its absence means "no control from
 * this module was applied", NOT "unguarded", since a host may wrap its own
 * timeout around its own model call where nothing here can see it. That is why
 * the service warns rather than throws, and why the warning can be acknowledged
 * with `unguarded: true`.
 *
 * Every control here throws on refusal (`JudgeTimeoutError`,
 * `JudgeBudgetExceededError`) rather than returning a low score. The verdict
 * service routes throws through its required `onJudgeFailure` policy, so a
 * timeout or an exhausted budget lands in the same audited place as an API
 * outage. A control that returned 0.0 instead would silently reject every run —
 * the exact `LLMJudgeScorer` failure mode this design exists to avoid.
 */

import type { JudgeInvoker } from "./team-verdict-llm-judge.js";

/** Raised when a judge call exceeds its latency budget. */
export class JudgeTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`TeamRuntime: verdict judge timed out after ${timeoutMs}ms`);
    this.name = "JudgeTimeoutError";
  }
}

/** Raised when the judge call budget for a wrapper instance is exhausted. */
export class JudgeBudgetExceededError extends Error {
  constructor(readonly maxCalls: number) {
    super(
      `TeamRuntime: verdict judge budget exhausted (${maxCalls} call(s) already made)`
    );
    this.name = "JudgeBudgetExceededError";
  }
}

/** An invoker that also accepts an abort signal, so a timeout can cancel it. */
export type AbortableJudgeInvoker = (
  prompt: string,
  signal: AbortSignal
) => Promise<string>;

/**
 * Marker set by the controls in this module on the invoker they return.
 *
 * Read by `createLlmJudgeVerdictService` to tell a guarded judge from a bare
 * one. A brand on the function is used rather than an option on the service
 * because the service accepts an opaque callback by design — it cannot inspect
 * what a host wrapped around its own model call, only what these wrappers
 * declare. Absence therefore means "no control from this module was applied",
 * which is a weaker claim than "unguarded", and the warning says so.
 */
export const JUDGE_GUARDED = Symbol.for("dzupagent.judgeGuarded");

/** Which controls have been applied to an invoker. */
export interface JudgeGuards {
  timeout?: boolean;
  budget?: boolean;
  cache?: boolean;
}

/** Read the guards declared on an invoker, if any. */
export function readJudgeGuards(invoker: JudgeInvoker): JudgeGuards {
  const brand = (invoker as { [JUDGE_GUARDED]?: JudgeGuards })[JUDGE_GUARDED];
  return brand ?? {};
}

/**
 * Copy the guards already on `inner` onto `outer` and add `added`.
 *
 * Guards must accumulate through composition: wrapping a timed-out invoker in a
 * cache must not erase the fact that a timeout is still in the chain, or the
 * outermost wrapper would report only itself.
 */
function brandGuarded(
  outer: JudgeInvoker,
  inner: JudgeInvoker | AbortableJudgeInvoker,
  added: JudgeGuards
): JudgeInvoker {
  const inherited = (inner as { [JUDGE_GUARDED]?: JudgeGuards })[JUDGE_GUARDED];
  Object.defineProperty(outer, JUDGE_GUARDED, {
    value: { ...inherited, ...added },
    enumerable: false,
  });
  return outer;
}

export interface JudgeTimeoutOptions {
  /** Latency budget for a single judge call, in milliseconds. */
  timeoutMs: number;
}

/**
 * Enforce a latency budget on each judge call.
 *
 * Accepts an {@link AbortableJudgeInvoker} so the underlying request can
 * actually be cancelled. `Promise.race` alone only stops *waiting* — the HTTP
 * call keeps running and keeps billing, which for a cost control is precisely
 * the wrong behaviour. Passing the signal through to `fetch`/the provider SDK
 * makes the timeout free the spend as well as the wall-clock.
 *
 * The signal is still raced against, because a provider that ignores its abort
 * signal must not be able to hang the gate forever.
 */
export function withJudgeTimeout(
  invoker: AbortableJudgeInvoker,
  options: JudgeTimeoutOptions
): JudgeInvoker {
  const { timeoutMs } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      "withJudgeTimeout: 'timeoutMs' must be a positive, finite number"
    );
  }

  const guarded = async (prompt: string): Promise<string> => {
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      return await Promise.race([
        invoker(prompt, controller.signal),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            // Abort first so the in-flight request stops billing, then reject.
            controller.abort();
            reject(new JudgeTimeoutError(timeoutMs));
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timeoutId);
    }
  };

  return brandGuarded(guarded, invoker, { timeout: true });
}

export interface JudgeCacheOptions {
  /**
   * Maximum number of cached verdicts. Oldest insertion is evicted first.
   * Bounded by default: an unbounded cache on a long-lived gate is a leak.
   */
  maxEntries?: number;
}

const DEFAULT_CACHE_ENTRIES = 100;

/**
 * Memoize judge responses by exact prompt text.
 *
 * The prompt is the whole cache key because it already encodes everything the
 * verdict depends on — task, output, and criteria are all interpolated into it
 * by `buildJudgePrompt`. Keying on anything narrower (e.g. `runId`) would be
 * both wrong and useless: runIds are unique, so nothing would ever hit.
 *
 * This is a same-content cache, which is what makes it safe. Two runs sharing a
 * prompt are asking a deterministic question about identical text; reusing the
 * answer is not a staleness risk. Judge nondeterminism is deliberately traded
 * away here — a gate wants a stable verdict for identical output anyway.
 *
 * In-flight calls are shared, not just completed ones: the promise is cached
 * before it settles, so N concurrent runs judging identical output make ONE
 * model call rather than N. A rejected call is evicted, so a transient failure
 * is retried rather than cached forever.
 */
export function withJudgeCache(
  invoker: JudgeInvoker,
  options: JudgeCacheOptions = {}
): JudgeInvoker {
  const maxEntries = options.maxEntries ?? DEFAULT_CACHE_ENTRIES;
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
    throw new Error("withJudgeCache: 'maxEntries' must be a positive integer");
  }

  const cache = new Map<string, Promise<string>>();

  const guarded = (prompt: string): Promise<string> => {
    const hit = cache.get(prompt);
    if (hit) return hit;

    const pending = invoker(prompt);
    cache.set(prompt, pending);

    // Do not cache failures: a timeout or rate-limit is a property of the
    // moment, not of the prompt. Caching it would make one blip permanent for
    // every future run judging the same output.
    void pending.catch(() => {
      cache.delete(prompt);
    });

    // Map preserves insertion order, so the first key is the oldest entry.
    if (cache.size > maxEntries) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }

    return pending;
  };

  return brandGuarded(guarded, invoker, { cache: true });
}

export interface JudgeBudgetOptions {
  /** Maximum number of judge calls this wrapper will permit, in total. */
  maxCalls: number;
  /**
   * Called just before each permitted call, with the 1-based call number.
   * Use it to emit a spend metric or warn as the budget nears exhaustion.
   * A throw from this callback is swallowed — observability must not break the
   * gate it observes.
   */
  onCall?: (callNumber: number, maxCalls: number) => void;
}

/**
 * Cap the total number of judge calls made through this wrapper.
 *
 * The counter increments when a call is *admitted*, not when it succeeds,
 * because a failed model call still costs money and still consumed capacity.
 *
 * Scope is the wrapper instance: wrap once per budget window (per process, per
 * run, per batch) and the lifetime of that instance is the window. There is
 * deliberately no reset — a mutable budget is one that gets silently reset in a
 * retry loop, which is the same as having no budget.
 */
export function withJudgeBudget(
  invoker: JudgeInvoker,
  options: JudgeBudgetOptions
): JudgeInvoker {
  const { maxCalls, onCall } = options;
  if (!Number.isInteger(maxCalls) || maxCalls <= 0) {
    throw new Error("withJudgeBudget: 'maxCalls' must be a positive integer");
  }

  let used = 0;

  const guarded = (prompt: string): Promise<string> => {
    if (used >= maxCalls) {
      // Throw synchronously-as-rejection: the verdict service awaits this and
      // routes it through onJudgeFailure like any other judge failure.
      return Promise.reject(new JudgeBudgetExceededError(maxCalls));
    }
    used += 1;

    if (onCall) {
      try {
        onCall(used, maxCalls);
      } catch {
        // Non-fatal: a broken metrics callback must not fail the gate.
      }
    }

    return invoker(prompt);
  };

  return brandGuarded(guarded, invoker, { budget: true });
}
