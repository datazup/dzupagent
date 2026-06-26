import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InMemoryRunJournal } from "@dzupagent/core";
import { ConcreteRunHandle } from "../agent/run-handle.js";

type ToolCleanup = () => void;

interface CancellableTool {
  id: string;
  output: string;
  cleanup?: ToolCleanup;
  cancelBeforeOutput?: boolean;
  cancelAfterOutput?: boolean;
}

interface CancellationRunResult {
  status: "completed" | "cancelled";
  output: string[];
  reason?: unknown;
  cleanupLog: string[];
}

class RunCancellationHarness {
  private readonly controller = new AbortController();
  private inFlight: { id: string; cleanup?: ToolCleanup } | null = null;
  readonly cleanupLog: string[] = [];
  readonly output: string[] = [];

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  cancel(reason?: unknown): void {
    if (!this.controller.signal.aborted) {
      this.controller.abort(reason);
    }
    this.cleanupInFlight();
  }

  async run(tools: CancellableTool[]): Promise<CancellationRunResult> {
    for (const tool of tools) {
      if (this.signal.aborted) {
        return this.cancelledResult();
      }

      this.inFlight = { id: tool.id, cleanup: tool.cleanup };

      if (tool.cancelBeforeOutput) {
        this.cancel(`cancel before ${tool.id}`);
        return this.cancelledResult();
      }

      this.output.push(tool.output);

      if (tool.cancelAfterOutput) {
        this.cancel(`cancel after ${tool.id}`);
        return this.cancelledResult();
      }

      this.inFlight = null;
    }

    return {
      status: "completed",
      output: [...this.output],
      cleanupLog: [...this.cleanupLog],
    };
  }

  private cleanupInFlight(): void {
    if (!this.inFlight) return;

    this.inFlight.cleanup?.();
    this.cleanupLog.push(this.inFlight.id);
    this.inFlight = null;
  }

  private cancelledResult(): CancellationRunResult {
    return {
      status: "cancelled",
      output: [...this.output],
      reason: this.signal.reason,
      cleanupLog: [...this.cleanupLog],
    };
  }
}

function timeoutSignal(ms: number, reason: string): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(reason), ms);
  return controller.signal;
}

async function runWithExternalSignal(
  signal: AbortSignal,
  output: string[] = []
): Promise<CancellationRunResult> {
  if (signal.aborted) {
    return {
      status: "cancelled",
      output,
      reason: signal.reason,
      cleanupLog: [],
    };
  }

  return new Promise((resolve) => {
    const finish = () => {
      resolve({
        status: "cancelled",
        output,
        reason: signal.reason,
        cleanupLog: [],
      });
    };
    signal.addEventListener("abort", finish, { once: true });
  });
}

describe("agent run cancellation", () => {
  let journal: InMemoryRunJournal;

  beforeEach(() => {
    journal = new InMemoryRunJournal();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("ConcreteRunHandle cancel result contract", () => {
    it("cancels a running run with an aborted status", async () => {
      const handle = new ConcreteRunHandle("run-cancel-1", "running", journal);
      await handle.cancel("user stop");
      const result = await handle.result();
      expect(result.status).toBe("cancelled");
    });

    it("stores the optional cancellation reason as the result error", async () => {
      const handle = new ConcreteRunHandle("run-cancel-2", "running", journal);
      const resultPromise = handle.result();
      await handle.cancel("operator cancelled");
      await expect(resultPromise).resolves.toMatchObject({
        error: "operator cancelled",
      });
    });

    it("omits the cancellation error when no reason is provided", async () => {
      const handle = new ConcreteRunHandle("run-cancel-3", "running", journal);
      await handle.cancel();
      const result = await handle.result();
      expect("error" in result).toBe(false);
    });

    it("transitions the current status to cancelled", async () => {
      const handle = new ConcreteRunHandle("run-cancel-4", "running", journal);
      await handle.cancel("stop");
      expect(handle.currentStatus).toBe("cancelled");
    });

    it("returns cancelled from the async status reader", async () => {
      const handle = new ConcreteRunHandle("run-cancel-5", "running", journal);
      await handle.cancel("stop");
      await expect(handle.status()).resolves.toBe("cancelled");
    });

    it("appends a run_cancelled journal entry", async () => {
      const handle = new ConcreteRunHandle("run-cancel-6", "running", journal);
      await handle.cancel("journal reason");
      const entries = await journal.getAll("run-cancel-6");
      expect(entries.map((entry) => entry.type)).toEqual(["run_cancelled"]);
    });

    it("persists the cancellation reason in the journal entry data", async () => {
      const handle = new ConcreteRunHandle("run-cancel-7", "running", journal);
      await handle.cancel("persist me");
      const [entry] = await journal.getAll("run-cancel-7");
      expect(entry.data).toMatchObject({ reason: "persist me" });
    });

    it("resolves a result waiter that started before cancellation", async () => {
      const handle = new ConcreteRunHandle("run-cancel-8", "running", journal);
      const result = handle.result();
      await handle.cancel("late stop");
      await expect(result).resolves.toMatchObject({ status: "cancelled" });
    });

    it("resolves a result waiter that starts after cancellation", async () => {
      const handle = new ConcreteRunHandle("run-cancel-9", "running", journal);
      await handle.cancel("early stop");
      await expect(handle.result()).resolves.toMatchObject({
        status: "cancelled",
      });
    });

    it("keeps the same result promise across cancellation observers", async () => {
      const handle = new ConcreteRunHandle("run-cancel-10", "running", journal);
      const first = handle.result();
      const second = handle.result();
      await handle.cancel("shared");
      expect(await first).toEqual(await second);
    });

    it("treats repeated cancel on a cancelled run as a no-op", async () => {
      const handle = new ConcreteRunHandle("run-cancel-11", "running", journal);
      await handle.cancel("first");
      await handle.cancel("second");
      const entries = await journal.getAll("run-cancel-11");
      expect(entries).toHaveLength(1);
    });

    it("does not convert a completed run into cancelled after a later cancel", async () => {
      const handle = new ConcreteRunHandle<string>(
        "run-cancel-12",
        "running",
        journal
      );
      const resultPromise = handle.result();
      handle._complete("done");
      await handle.cancel("too late");
      const result = await resultPromise;
      expect(result).toMatchObject({ status: "completed", output: "done" });
    });

    it("does not convert a failed run into cancelled after a later cancel", async () => {
      const handle = new ConcreteRunHandle<string>(
        "run-cancel-13",
        "running",
        journal
      );
      const resultPromise = handle.result();
      handle._fail("model failed");
      await handle.cancel("too late");
      const result = await resultPromise;
      expect(result).toMatchObject({ status: "failed", error: "model failed" });
    });

    it("does not convert a rejected run into cancelled after a later cancel", async () => {
      const handle = new ConcreteRunHandle(
        "run-cancel-14",
        "rejected",
        journal
      );
      await handle.cancel("too late");
      expect(handle.currentStatus).toBe("rejected");
    });

    it("allows cancellation from pending state", async () => {
      const handle = new ConcreteRunHandle("run-cancel-15", "pending", journal);
      await handle.cancel("pending stop");
      await expect(handle.result()).resolves.toMatchObject({
        status: "cancelled",
      });
    });

    it("allows cancellation from paused state", async () => {
      const handle = new ConcreteRunHandle("run-cancel-16", "paused", journal);
      await handle.cancel("paused stop");
      expect(handle.currentStatus).toBe("cancelled");
    });

    it("allows cancellation from suspended state", async () => {
      const handle = new ConcreteRunHandle(
        "run-cancel-17",
        "suspended",
        journal
      );
      await handle.cancel("suspended stop");
      await expect(handle.status()).resolves.toBe("cancelled");
    });

    it("reconstructs cancelled status from the journal", async () => {
      const handle = new ConcreteRunHandle("run-cancel-18", "running", journal);
      await handle.cancel("rebuild");
      const rebuilt = await ConcreteRunHandle.fromRunId(
        "run-cancel-18",
        journal
      );
      expect(rebuilt.currentStatus).toBe("cancelled");
    });

    it("does not emit a synthetic completion event when cancelling", async () => {
      const handle = new ConcreteRunHandle("run-cancel-19", "running", journal);
      const handler = vi.fn();
      handle.subscribe("run_completed", handler);
      await handle.cancel("stop");
      expect(handler).not.toHaveBeenCalled();
    });

    it("does not emit a synthetic failure event when cancelling", async () => {
      const handle = new ConcreteRunHandle("run-cancel-20", "running", journal);
      const handler = vi.fn();
      handle.subscribe("run_failed", handler);
      await handle.cancel("stop");
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("AbortController graceful abort", () => {
    it("returns cancelled for a pre-aborted AbortSignal", async () => {
      const controller = new AbortController();
      controller.abort("pre stop");
      await expect(
        runWithExternalSignal(controller.signal)
      ).resolves.toMatchObject({
        status: "cancelled",
        reason: "pre stop",
      });
    });

    it("preserves partial output for a pre-aborted observer", async () => {
      const controller = new AbortController();
      controller.abort("pre stop");
      const result = await runWithExternalSignal(controller.signal, ["draft"]);
      expect(result.output).toEqual(["draft"]);
    });

    it("returns the exact AbortSignal reason object", async () => {
      const controller = new AbortController();
      const reason = { code: "operator" };
      controller.abort(reason);
      const result = await runWithExternalSignal(controller.signal);
      expect(result.reason).toBe(reason);
    });

    it("resolves when a pending AbortSignal aborts", async () => {
      const controller = new AbortController();
      const result = runWithExternalSignal(controller.signal);
      controller.abort("later stop");
      await expect(result).resolves.toMatchObject({ reason: "later stop" });
    });

    it("keeps a completed local run completed when AbortSignal aborts later", async () => {
      const controller = new AbortController();
      const harness = new RunCancellationHarness();
      const result = await harness.run([{ id: "tool-a", output: "done" }]);
      controller.abort("late");
      expect(result.status).toBe("completed");
    });

    it("does not run cleanup for a pre-aborted signal with no in-flight tool", async () => {
      const controller = new AbortController();
      controller.abort("stop");
      const result = await runWithExternalSignal(controller.signal);
      expect(result.cleanupLog).toEqual([]);
    });

    it("marks the underlying signal as aborted after cancel", () => {
      const harness = new RunCancellationHarness();
      harness.cancel("manual");
      expect(harness.signal.aborted).toBe(true);
    });

    it("exposes the cancellation reason through the underlying signal", () => {
      const harness = new RunCancellationHarness();
      harness.cancel("manual reason");
      expect(harness.signal.reason).toBe("manual reason");
    });

    it("keeps repeated AbortController abort reasons stable", () => {
      const controller = new AbortController();
      controller.abort("first");
      controller.abort("second");
      expect(controller.signal.reason).toBe("first");
    });

    it("does not emit duplicate abort listener calls when registered once", () => {
      const controller = new AbortController();
      const handler = vi.fn();
      controller.signal.addEventListener("abort", handler, { once: true });
      controller.abort("first");
      controller.abort("second");
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("cancels before the first tool output when requested before output", async () => {
      const harness = new RunCancellationHarness();
      const result = await harness.run([
        { id: "tool-a", output: "a", cancelBeforeOutput: true },
      ]);
      expect(result.output).toEqual([]);
    });

    it("cancels after retaining the current tool output when requested after output", async () => {
      const harness = new RunCancellationHarness();
      const result = await harness.run([
        { id: "tool-a", output: "a", cancelAfterOutput: true },
      ]);
      expect(result.output).toEqual(["a"]);
    });

    it("stops later tools after an abort", async () => {
      const harness = new RunCancellationHarness();
      const result = await harness.run([
        { id: "tool-a", output: "a", cancelAfterOutput: true },
        { id: "tool-b", output: "b" },
      ]);
      expect(result.output).toEqual(["a"]);
    });

    it("returns cancelled status for cancel-before-output runs", async () => {
      const harness = new RunCancellationHarness();
      const result = await harness.run([
        { id: "tool-a", output: "a", cancelBeforeOutput: true },
      ]);
      expect(result.status).toBe("cancelled");
    });

    it("returns cancelled status for cancel-after-output runs", async () => {
      const harness = new RunCancellationHarness();
      const result = await harness.run([
        { id: "tool-a", output: "a", cancelAfterOutput: true },
      ]);
      expect(result.status).toBe("cancelled");
    });
  });

  describe("in-flight tool cleanup on cancel", () => {
    it("runs cleanup for the tool cancelled before output", async () => {
      const cleanup = vi.fn();
      const harness = new RunCancellationHarness();
      await harness.run([
        { id: "tool-a", output: "a", cleanup, cancelBeforeOutput: true },
      ]);
      expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it("runs cleanup for the tool cancelled after output", async () => {
      const cleanup = vi.fn();
      const harness = new RunCancellationHarness();
      await harness.run([
        { id: "tool-a", output: "a", cleanup, cancelAfterOutput: true },
      ]);
      expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it("records only the cancelled in-flight tool in cleanupLog", async () => {
      const harness = new RunCancellationHarness();
      const result = await harness.run([
        { id: "tool-a", output: "a" },
        { id: "tool-b", output: "b", cancelBeforeOutput: true },
      ]);
      expect(result.cleanupLog).toEqual(["tool-b"]);
    });

    it("does not cleanup a completed prior tool when a later tool cancels", async () => {
      const cleanupA = vi.fn();
      const cleanupB = vi.fn();
      const harness = new RunCancellationHarness();
      await harness.run([
        { id: "tool-a", output: "a", cleanup: cleanupA },
        {
          id: "tool-b",
          output: "b",
          cleanup: cleanupB,
          cancelBeforeOutput: true,
        },
      ]);
      expect(cleanupA).not.toHaveBeenCalled();
      expect(cleanupB).toHaveBeenCalledTimes(1);
    });

    it("does not cleanup a future tool that never starts", async () => {
      const cleanup = vi.fn();
      const harness = new RunCancellationHarness();
      await harness.run([
        { id: "tool-a", output: "a", cancelBeforeOutput: true },
        { id: "tool-b", output: "b", cleanup },
      ]);
      expect(cleanup).not.toHaveBeenCalled();
    });

    it("does not call cleanup when no tool is in flight", () => {
      const harness = new RunCancellationHarness();
      harness.cancel("idle");
      expect(harness.cleanupLog).toEqual([]);
    });

    it("does not call cleanup twice on repeated cancel", async () => {
      const cleanup = vi.fn();
      const harness = new RunCancellationHarness();
      await harness.run([
        { id: "tool-a", output: "a", cleanup, cancelBeforeOutput: true },
      ]);
      harness.cancel("again");
      expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it("clears in-flight cleanup after it runs", async () => {
      const harness = new RunCancellationHarness();
      await harness.run([
        { id: "tool-a", output: "a", cancelBeforeOutput: true },
      ]);
      harness.cancel("again");
      expect(harness.cleanupLog).toEqual(["tool-a"]);
    });

    it("still records cleanup when a tool has no cleanup hook", async () => {
      const harness = new RunCancellationHarness();
      const result = await harness.run([
        { id: "tool-a", output: "a", cancelBeforeOutput: true },
      ]);
      expect(result.cleanupLog).toEqual(["tool-a"]);
    });

    it("preserves cleanup order for the single active tool", async () => {
      const cleanup = vi.fn();
      const harness = new RunCancellationHarness();
      const result = await harness.run([
        { id: "tool-a", output: "a", cleanup, cancelAfterOutput: true },
      ]);
      expect(result.cleanupLog).toEqual(["tool-a"]);
    });

    it("leaves cleanupLog empty for successful runs", async () => {
      const harness = new RunCancellationHarness();
      const result = await harness.run([{ id: "tool-a", output: "a" }]);
      expect(result.cleanupLog).toEqual([]);
    });

    it("leaves cleanup hook unused for successful runs", async () => {
      const cleanup = vi.fn();
      const harness = new RunCancellationHarness();
      await harness.run([{ id: "tool-a", output: "a", cleanup }]);
      expect(cleanup).not.toHaveBeenCalled();
    });

    it("does not cleanup when cancellation arrives after successful completion", async () => {
      const cleanup = vi.fn();
      const harness = new RunCancellationHarness();
      await harness.run([{ id: "tool-a", output: "a", cleanup }]);
      harness.cancel("late");
      expect(cleanup).not.toHaveBeenCalled();
    });

    it("records cleanup before returning the cancelled result", async () => {
      const harness = new RunCancellationHarness();
      const result = await harness.run([
        { id: "tool-a", output: "a", cancelBeforeOutput: true },
      ]);
      expect(result.cleanupLog).toEqual(["tool-a"]);
    });

    it("keeps cleanup scoped to the harness instance", async () => {
      const first = new RunCancellationHarness();
      const second = new RunCancellationHarness();
      await first.run([
        { id: "tool-a", output: "a", cancelBeforeOutput: true },
      ]);
      const result = await second.run([{ id: "tool-b", output: "b" }]);
      expect(result.cleanupLog).toEqual([]);
    });
  });

  describe("partial result return when cancelled mid-run", () => {
    it("returns output from tools completed before cancellation", async () => {
      const harness = new RunCancellationHarness();
      const result = await harness.run([
        { id: "tool-a", output: "a" },
        { id: "tool-b", output: "b", cancelBeforeOutput: true },
      ]);
      expect(result.output).toEqual(["a"]);
    });

    it("includes the current output when cancellation occurs after output", async () => {
      const harness = new RunCancellationHarness();
      const result = await harness.run([
        { id: "tool-a", output: "a" },
        { id: "tool-b", output: "b", cancelAfterOutput: true },
      ]);
      expect(result.output).toEqual(["a", "b"]);
    });

    it("excludes the current output when cancellation occurs before output", async () => {
      const harness = new RunCancellationHarness();
      const result = await harness.run([
        { id: "tool-a", output: "a" },
        { id: "tool-b", output: "b", cancelBeforeOutput: true },
      ]);
      expect(result.output).not.toContain("b");
    });

    it("does not include outputs from tools skipped after cancellation", async () => {
      const harness = new RunCancellationHarness();
      const result = await harness.run([
        { id: "tool-a", output: "a", cancelAfterOutput: true },
        { id: "tool-b", output: "b" },
        { id: "tool-c", output: "c" },
      ]);
      expect(result.output).toEqual(["a"]);
    });

    it("returns an empty partial result when the first tool cancels before output", async () => {
      const harness = new RunCancellationHarness();
      const result = await harness.run([
        { id: "tool-a", output: "a", cancelBeforeOutput: true },
      ]);
      expect(result.output).toEqual([]);
    });

    it("returns completed status with all output when no cancellation occurs", async () => {
      const harness = new RunCancellationHarness();
      const result = await harness.run([
        { id: "tool-a", output: "a" },
        { id: "tool-b", output: "b" },
      ]);
      expect(result).toMatchObject({ status: "completed", output: ["a", "b"] });
    });

    it("does not mark a successful run as cancelled after a later cancel observer", async () => {
      const harness = new RunCancellationHarness();
      const result = await harness.run([{ id: "tool-a", output: "a" }]);
      harness.cancel("late");
      expect(result.status).toBe("completed");
    });

    it("keeps successful output stable after a later cancel observer", async () => {
      const harness = new RunCancellationHarness();
      const result = await harness.run([{ id: "tool-a", output: "a" }]);
      harness.cancel("late");
      expect(result.output).toEqual(["a"]);
    });

    it("copies partial output instead of returning a mutable buffer", async () => {
      const harness = new RunCancellationHarness();
      const result = await harness.run([
        { id: "tool-a", output: "a", cancelAfterOutput: true },
      ]);
      harness.output.push("mutation");
      expect(result.output).toEqual(["a"]);
    });

    it("copies cleanupLog instead of returning a mutable buffer", async () => {
      const harness = new RunCancellationHarness();
      const result = await harness.run([
        { id: "tool-a", output: "a", cancelBeforeOutput: true },
      ]);
      harness.cleanupLog.push("mutation");
      expect(result.cleanupLog).toEqual(["tool-a"]);
    });

    it("returns the cancellation reason with the partial result", async () => {
      const harness = new RunCancellationHarness();
      const result = await harness.run([
        { id: "tool-a", output: "a", cancelAfterOutput: true },
      ]);
      expect(result.reason).toBe("cancel after tool-a");
    });

    it("does not include a reason for successful full result", async () => {
      const harness = new RunCancellationHarness();
      const result = await harness.run([{ id: "tool-a", output: "a" }]);
      expect("reason" in result).toBe(false);
    });

    it("preserves output order before cancellation", async () => {
      const harness = new RunCancellationHarness();
      const result = await harness.run([
        { id: "tool-a", output: "first" },
        { id: "tool-b", output: "second" },
        { id: "tool-c", output: "third", cancelBeforeOutput: true },
      ]);
      expect(result.output).toEqual(["first", "second"]);
    });

    it("preserves mixed primitive output strings without normalization", async () => {
      const harness = new RunCancellationHarness();
      const result = await harness.run([
        { id: "tool-a", output: "" },
        { id: "tool-b", output: "0", cancelAfterOutput: true },
      ]);
      expect(result.output).toEqual(["", "0"]);
    });

    it("returns cancelled rather than failed for a cooperative mid-run cancel", async () => {
      const harness = new RunCancellationHarness();
      const result = await harness.run([
        { id: "tool-a", output: "a", cancelAfterOutput: true },
      ]);
      expect(result.status).toBe("cancelled");
    });
  });

  describe("timeout-triggered cancellation", () => {
    it("aborts a signal when the timeout expires", async () => {
      const signal = timeoutSignal(100, "deadline");
      const result = runWithExternalSignal(signal);
      await vi.advanceTimersByTimeAsync(100);
      await expect(result).resolves.toMatchObject({ status: "cancelled" });
    });

    it("uses the timeout reason as the cancellation reason", async () => {
      const signal = timeoutSignal(100, "deadline exceeded");
      const result = runWithExternalSignal(signal);
      await vi.advanceTimersByTimeAsync(100);
      await expect(result).resolves.toMatchObject({
        reason: "deadline exceeded",
      });
    });

    it("does not abort before the timeout expires", async () => {
      const signal = timeoutSignal(100, "deadline");
      await vi.advanceTimersByTimeAsync(99);
      expect(signal.aborted).toBe(false);
    });

    it("aborts exactly when the timeout reaches the deadline", async () => {
      const signal = timeoutSignal(100, "deadline");
      await vi.advanceTimersByTimeAsync(100);
      expect(signal.aborted).toBe(true);
    });

    it("preserves partial output when timeout cancellation fires", async () => {
      const signal = timeoutSignal(50, "deadline");
      const result = runWithExternalSignal(signal, ["partial"]);
      await vi.advanceTimersByTimeAsync(50);
      await expect(result).resolves.toMatchObject({ output: ["partial"] });
    });

    it("does not convert a completed run after a later timeout fires", async () => {
      const handle = new ConcreteRunHandle<string>(
        "run-timeout-1",
        "running",
        journal
      );
      const signal = timeoutSignal(50, "deadline");
      handle._complete("done");
      await vi.advanceTimersByTimeAsync(50);
      expect(signal.aborted).toBe(true);
      await expect(handle.result()).resolves.toMatchObject({
        status: "completed",
      });
    });

    it("does not append run_cancelled for a completed run after timeout", async () => {
      const handle = new ConcreteRunHandle<string>(
        "run-timeout-2",
        "running",
        journal
      );
      timeoutSignal(50, "deadline");
      handle._complete("done");
      await vi.advanceTimersByTimeAsync(50);
      const entries = await journal.getAll("run-timeout-2");
      expect(entries).toEqual([]);
    });

    it("allows timeout cancellation to drive ConcreteRunHandle cancel", async () => {
      const handle = new ConcreteRunHandle("run-timeout-3", "running", journal);
      const resultPromise = handle.result();
      const signal = timeoutSignal(50, "deadline");
      signal.addEventListener("abort", () => {
        void handle.cancel(String(signal.reason));
      });
      await vi.advanceTimersByTimeAsync(50);
      await expect(resultPromise).resolves.toMatchObject({
        status: "cancelled",
        error: "deadline",
      });
    });

    it("keeps timeout-driven cancel idempotent if manual cancel already happened", async () => {
      const handle = new ConcreteRunHandle("run-timeout-4", "running", journal);
      const signal = timeoutSignal(50, "deadline");
      signal.addEventListener("abort", () => {
        void handle.cancel(String(signal.reason));
      });
      await handle.cancel("manual");
      await vi.advanceTimersByTimeAsync(50);
      const entries = await journal.getAll("run-timeout-4");
      expect(entries).toHaveLength(1);
    });

    it("keeps the manual cancellation reason when timeout fires later", async () => {
      const handle = new ConcreteRunHandle("run-timeout-5", "running", journal);
      const resultPromise = handle.result();
      const signal = timeoutSignal(50, "deadline");
      signal.addEventListener("abort", () => {
        void handle.cancel(String(signal.reason));
      });
      await handle.cancel("manual");
      await vi.advanceTimersByTimeAsync(50);
      await expect(resultPromise).resolves.toMatchObject({ error: "manual" });
    });
  });
});
