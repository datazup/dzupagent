/**
 * Tests for the judge cost/latency/budget controls.
 *
 * Two properties matter more than the happy paths:
 *
 * 1. A refused call (timeout, exhausted budget) must THROW, never resolve to a
 *    low score — the verdict service has to see it as a judge failure so its
 *    `onJudgeFailure` policy applies. A control that scored 0.0 instead would
 *    reject every run during an outage.
 * 2. The documented composition order actually behaves as claimed: budget
 *    outside cache (hits are free), cache outside timeout (hits do not wait).
 */
import { describe, expect, it, vi } from "vitest";
import {
  JudgeBudgetExceededError,
  JudgeTimeoutError,
  createGuardedJudgeInvoker,
  readJudgeGuards,
  withJudgeBudget,
  withJudgeCache,
  withJudgeTimeout,
} from "../team-verdict-judge-controls.js";
import { createLlmJudgeVerdictService } from "../team-verdict-llm-judge.js";
import type { TeamVerdictInput } from "../team-runtime-verdict.js";
import type { TeamPolicies } from "../team-policy.js";

function input(overrides: Partial<TeamVerdictInput> = {}): TeamVerdictInput {
  return {
    teamId: "team-a",
    runId: "run-1",
    task: "summarise the incident",
    result: {
      content: "a summary",
      agentResults: [],
      durationMs: 1,
      pattern: "council",
    },
    policies: {} as TeamPolicies,
    ...overrides,
  } as TeamVerdictInput;
}

/** A deferred promise, for driving in-flight calls deterministically. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("withJudgeTimeout", () => {
  it("rejects a non-positive timeout at construction", () => {
    expect(() => withJudgeTimeout(async () => "{}", { timeoutMs: 0 })).toThrow(
      /positive, finite number/
    );
    expect(() =>
      withJudgeTimeout(async () => "{}", { timeoutMs: Number.NaN })
    ).toThrow(/positive, finite number/);
  });

  it("passes through a call that finishes in time", async () => {
    const judge = withJudgeTimeout(async () => '{"score":0.9}', {
      timeoutMs: 1000,
    });
    await expect(judge("p")).resolves.toBe('{"score":0.9}');
  });

  it("throws JudgeTimeoutError when the call overruns", async () => {
    vi.useFakeTimers();
    try {
      const judge = withJudgeTimeout(() => new Promise<string>(() => {}), {
        timeoutMs: 5_000,
      });
      const pending = judge("p");
      const assertion = expect(pending).rejects.toThrow(JudgeTimeoutError);
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts the underlying call so it stops billing", async () => {
    vi.useFakeTimers();
    try {
      let observed: AbortSignal | undefined;
      const judge = withJudgeTimeout(
        (_prompt, signal) => {
          observed = signal;
          return new Promise<string>(() => {});
        },
        { timeoutMs: 5_000 }
      );
      const pending = judge("p");
      const assertion = expect(pending).rejects.toThrow(JudgeTimeoutError);

      expect(observed?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;

      // The whole point of threading a signal through: Promise.race alone
      // would stop waiting while the request kept running and kept billing.
      expect(observed?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears its timer when the call succeeds, leaving no pending work", async () => {
    vi.useFakeTimers();
    try {
      const judge = withJudgeTimeout(async () => "ok", { timeoutMs: 5_000 });
      await expect(judge("p")).resolves.toBe("ok");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createGuardedJudgeInvoker", () => {
  it("applies finite timeout, budget, and cache controls by default", async () => {
    const inner = vi.fn(async (_prompt: string, _signal: AbortSignal) => "ok");
    const judge = createGuardedJudgeInvoker(inner);

    await expect(judge("same")).resolves.toBe("ok");
    await expect(judge("same")).resolves.toBe("ok");

    expect(inner).toHaveBeenCalledTimes(1);
    expect(readJudgeGuards(judge)).toEqual({
      timeout: true,
      budget: true,
      cache: true,
    });
  });

  it("can disable caching while retaining timeout and budget", async () => {
    const inner = vi.fn(async (_prompt: string, _signal: AbortSignal) => "ok");
    const judge = createGuardedJudgeInvoker(inner, {
      maxCalls: 1,
      cache: false,
    });

    await expect(judge("first")).resolves.toBe("ok");
    await expect(judge("second")).rejects.toThrow(JudgeBudgetExceededError);
    expect(readJudgeGuards(judge)).toEqual({ timeout: true, budget: true });
  });
});

describe("withJudgeCache", () => {
  it("rejects a non-positive maxEntries at construction", () => {
    expect(() => withJudgeCache(async () => "{}", { maxEntries: 0 })).toThrow(
      /positive integer/
    );
  });

  it("calls the judge once for a repeated prompt", async () => {
    const inner = vi.fn(async () => '{"score":0.8}');
    const judge = withJudgeCache(inner);

    await expect(judge("same")).resolves.toBe('{"score":0.8}');
    await expect(judge("same")).resolves.toBe('{"score":0.8}');

    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("calls the judge again for a different prompt", async () => {
    const inner = vi.fn(async () => '{"score":0.8}');
    const judge = withJudgeCache(inner);

    await judge("a");
    await judge("b");

    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("shares an in-flight call between concurrent identical prompts", async () => {
    const gate = deferred<string>();
    const inner = vi.fn(() => gate.promise);
    const judge = withJudgeCache(inner);

    const first = judge("same");
    const second = judge("same");
    gate.resolve('{"score":1}');

    await expect(Promise.all([first, second])).resolves.toEqual([
      '{"score":1}',
      '{"score":1}',
    ]);
    // Caching only settled results would have made this 2 — N concurrent runs
    // judging identical output would each pay for their own call.
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed call", async () => {
    const inner = vi
      .fn<(prompt: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error("rate limited"))
      .mockResolvedValueOnce('{"score":0.7}');
    const judge = withJudgeCache(inner);

    await expect(judge("same")).rejects.toThrow("rate limited");
    // A transient blip is a property of the moment, not of the prompt.
    await expect(judge("same")).resolves.toBe('{"score":0.7}');
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("evicts the oldest entry beyond maxEntries", async () => {
    const inner = vi.fn(async (p: string) => `{"score":0.5,"p":"${p}"}`);
    const judge = withJudgeCache(inner, { maxEntries: 2 });

    await judge("a");
    await judge("b");
    await judge("c"); // evicts "a"

    expect(inner).toHaveBeenCalledTimes(3);
    await judge("b"); // still cached
    expect(inner).toHaveBeenCalledTimes(3);
    await judge("a"); // evicted, recomputed
    expect(inner).toHaveBeenCalledTimes(4);
  });
});

describe("withJudgeBudget", () => {
  it("rejects a non-positive maxCalls at construction", () => {
    expect(() => withJudgeBudget(async () => "{}", { maxCalls: 0 })).toThrow(
      /positive integer/
    );
  });

  it("permits calls up to the cap then refuses", async () => {
    const inner = vi.fn(async () => '{"score":1}');
    const judge = withJudgeBudget(inner, { maxCalls: 2 });

    await judge("a");
    await judge("b");
    await expect(judge("c")).rejects.toThrow(JudgeBudgetExceededError);

    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("counts a failed call against the budget", async () => {
    const inner = vi
      .fn<(prompt: string) => Promise<string>>()
      .mockRejectedValue(new Error("boom"));
    const judge = withJudgeBudget(inner, { maxCalls: 1 });

    await expect(judge("a")).rejects.toThrow("boom");
    // A failed model call still cost money and still consumed capacity.
    await expect(judge("b")).rejects.toThrow(JudgeBudgetExceededError);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("reports each admitted call to onCall", async () => {
    const onCall = vi.fn();
    const judge = withJudgeBudget(async () => "{}", { maxCalls: 3, onCall });

    await judge("a");
    await judge("b");

    expect(onCall.mock.calls).toEqual([
      [1, 3],
      [2, 3],
    ]);
  });

  it("survives a throwing onCall callback", async () => {
    const judge = withJudgeBudget(async () => '{"score":1}', {
      maxCalls: 1,
      onCall: () => {
        throw new Error("metrics backend down");
      },
    });

    // Observability must never break the gate it observes.
    await expect(judge("a")).resolves.toBe('{"score":1}');
  });
});

describe("composition order", () => {
  it("does not spend budget on a cache hit (cache outside budget)", async () => {
    const inner = vi.fn(async () => '{"score":1}');
    const judge = withJudgeCache(withJudgeBudget(inner, { maxCalls: 1 }));

    await expect(judge("same")).resolves.toBe('{"score":1}');
    // The cache runs first and serves this from memory, so the budget — which
    // has exactly one unit and already spent it — is never consulted.
    await expect(judge("same")).resolves.toBe('{"score":1}');
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("charges a cache hit when the wrappers are inverted", async () => {
    const inner = vi.fn(async () => '{"score":1}');
    // Calls flow outermost-in, so THIS order runs the budget first and bills a
    // call the cache would have served for free. Pinned as a test because the
    // nesting reads backwards: the correct arrangement is the one above.
    const judge = withJudgeBudget(withJudgeCache(inner), { maxCalls: 1 });

    await expect(judge("same")).resolves.toBe('{"score":1}');
    await expect(judge("same")).rejects.toThrow(JudgeBudgetExceededError);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("does not arm a timer on a cache hit (cache outside timeout)", async () => {
    vi.useFakeTimers();
    try {
      const inner = vi.fn(async () => '{"score":1}');
      const judge = withJudgeCache(withJudgeTimeout(inner, { timeoutMs: 100 }));

      await judge("same");
      const hit = judge("same");
      // A hit returns the memoized promise without entering the timeout
      // wrapper at all, so no timer exists to advance past.
      await vi.advanceTimersByTimeAsync(500);
      await expect(hit).resolves.toBe('{"score":1}');
      expect(inner).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("integration with the verdict service", () => {
  it("routes a timeout through onJudgeFailure rather than scoring 0", async () => {
    vi.useFakeTimers();
    try {
      const service = createLlmJudgeVerdictService({
        judge: withJudgeTimeout(() => new Promise<string>(() => {}), {
          timeoutMs: 1_000,
        }),
        onJudgeFailure: "skip",
      });

      const pending = service.score(input());
      await vi.advanceTimersByTimeAsync(1_000);

      // 'skip' is a pass-through, NOT a judgement. Scoring 0 here would let a
      // slow judge reject every run. notScored marks it as an abstention so the
      // gate reports reason='scorer_failed' instead of a silent pass.
      await expect(pending).resolves.toEqual({
        score: 1,
        unanimous: true,
        notScored: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes an exhausted budget through onJudgeFailure", async () => {
    const service = createLlmJudgeVerdictService({
      judge: withJudgeBudget(async () => '{"score":0.9,"unanimous":true}', {
        maxCalls: 1,
      }),
      onJudgeFailure: "skip",
    });

    await expect(service.score(input())).resolves.toEqual({
      score: 0.9,
      unanimous: true,
    });
    // An exhausted budget is an abstention, not a pass: without notScored a
    // spent budget would silently ungate every subsequent run.
    await expect(service.score(input({ runId: "run-2" }))).resolves.toEqual({
      score: 1,
      unanimous: true,
      notScored: true,
    });
  });

  it("raises TeamJudgeUnavailableError on budget exhaustion under 'reject'", async () => {
    const service = createLlmJudgeVerdictService({
      judge: withJudgeBudget(async () => '{"score":0.9}', { maxCalls: 1 }),
      onJudgeFailure: "reject",
    });

    await service.score(input());
    await expect(service.score(input({ runId: "run-2" }))).rejects.toThrow(
      /verdict judge failed to produce a score/
    );
  });

  it("serves a repeated identical run from cache, halving judge calls", async () => {
    const inner = vi.fn(async () => '{"score":0.9,"unanimous":true}');
    const service = createLlmJudgeVerdictService({
      judge: withJudgeCache(inner),
      onJudgeFailure: "reject",
    });

    // Same task + same output ⇒ same prompt ⇒ one model call. runId is not in
    // the prompt, so it correctly does not defeat the cache.
    await service.score(input({ runId: "run-1" }));
    await service.score(input({ runId: "run-2" }));

    expect(inner).toHaveBeenCalledTimes(1);
  });
});
