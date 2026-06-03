import { describe, expect, it, vi } from "vitest";
import {
  runAllConcurrently,
  runConcurrently,
} from "../orchestration/concurrency-runner.js";

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

describe("concurrency-runner", () => {
  it("preserves input order for allSettled results when tasks resolve out of order", async () => {
    const results = await runConcurrently(
      [
        async () => {
          await delay(20);
          return "first";
        },
        async () => {
          await delay(1);
          return "second";
        },
        async () => "third",
      ],
      2
    );

    expect(results).toEqual([
      { status: "fulfilled", value: "first" },
      { status: "fulfilled", value: "second" },
      { status: "fulfilled", value: "third" },
    ]);
  });

  it("respects maxConcurrency for allSettled execution", async () => {
    let active = 0;
    let peak = 0;
    const createTask = () => async () => {
      active++;
      peak = Math.max(peak, active);
      await delay(5);
      active--;
      return peak;
    };

    await runConcurrently(
      [createTask(), createTask(), createTask(), createTask()],
      2
    );

    expect(peak).toBe(2);
  });

  it("preserves input order for Promise.all-style results", async () => {
    const results = await runAllConcurrently(
      [
        async () => {
          await delay(20);
          return "first";
        },
        async () => {
          await delay(1);
          return "second";
        },
        async () => "third",
      ],
      2
    );

    expect(results).toEqual(["first", "second", "third"]);
  });

  it("rejects on the first observed failure and does not start queued tasks", async () => {
    const started: string[] = [];
    const neverStarted = vi.fn(async () => "late");

    await expect(
      runAllConcurrently(
        [
          async () => {
            started.push("bad");
            throw new Error("first failure");
          },
          async () => {
            started.push("queued");
            return neverStarted();
          },
        ],
        1
      )
    ).rejects.toThrow("first failure");

    expect(started).toEqual(["bad"]);
    expect(neverStarted).not.toHaveBeenCalled();
  });

  describe("cancellation (W1)", () => {
    it("aborts in-flight siblings when one task fails (runAllConcurrently)", async () => {
      const siblingAborted = vi.fn();

      await expect(
        runAllConcurrently(
          [
            // Slow sibling launched first; should be signalled to abort when the
            // fast sibling rejects.
            async (signal?: AbortSignal) => {
              signal?.addEventListener("abort", () => siblingAborted());
              await delay(50);
              return "slow";
            },
            // Fast failure.
            async () => {
              await delay(5);
              throw new Error("boom");
            },
          ],
          // Unbounded so both launch immediately.
          undefined
        )
      ).rejects.toThrow("boom");

      // The slow sibling's signal must have fired.
      expect(siblingAborted).toHaveBeenCalledTimes(1);
    });

    it("passes an abort signal into every factory", async () => {
      const seen: boolean[] = [];
      await runAllConcurrently(
        [
          async (signal?: AbortSignal) => {
            seen.push(signal instanceof AbortSignal);
            return 1;
          },
          async (signal?: AbortSignal) => {
            seen.push(signal instanceof AbortSignal);
            return 2;
          },
        ],
        undefined
      );
      expect(seen).toEqual([true, true]);
    });

    it("propagates an external signal to running tasks (runAllConcurrently)", async () => {
      const controller = new AbortController();
      const aborted = vi.fn();

      const pending = runAllConcurrently(
        [
          async (signal?: AbortSignal) =>
            new Promise<string>((resolve, reject) => {
              signal?.addEventListener("abort", () => {
                aborted();
                reject(new Error("cancelled"));
              });
              setTimeout(() => resolve("done"), 100);
            }),
        ],
        undefined,
        { signal: controller.signal }
      );

      // Abort externally before the task would resolve.
      setTimeout(() => controller.abort(), 10);

      await expect(pending).rejects.toThrow("cancelled");
      expect(aborted).toHaveBeenCalledTimes(1);
    });

    it("fails fast when the external signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort(new Error("pre-aborted"));
      const factory = vi.fn(async () => "should-not-run");

      await expect(
        runAllConcurrently([factory, factory], undefined, {
          signal: controller.signal,
        })
      ).rejects.toThrow("pre-aborted");

      expect(factory).not.toHaveBeenCalled();
    });

    it("threads the external signal into factories but still settles all (runConcurrently)", async () => {
      const controller = new AbortController();
      const seen: boolean[] = [];

      const results = await runConcurrently(
        [
          async (signal?: AbortSignal) => {
            seen.push(signal === controller.signal);
            return "a";
          },
          async (signal?: AbortSignal) => {
            seen.push(signal === controller.signal);
            throw new Error("b-failed");
          },
        ],
        // Bounded path so the signal-threading branch is exercised.
        1,
        { signal: controller.signal }
      );

      expect(seen).toEqual([true, true]);
      expect(results[0]).toEqual({ status: "fulfilled", value: "a" });
      expect(results[1]?.status).toBe("rejected");
    });
  });
});
