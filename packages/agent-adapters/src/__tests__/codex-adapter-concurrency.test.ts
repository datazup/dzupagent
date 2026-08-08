/**
 * Codex adapter concurrency characterization + isolation tests (Packet A).
 *
 * Proves that two concurrent runs through ONE CodexAdapter instance must not
 * share provider session identity, current input, resume state, or abort
 * controllers — and that aborting/completing one run cannot affect the other.
 *
 * Written FIRST as failing characterization tests against the adapter-wide
 * mutable state (`currentSessionId`, `currentInput`, `currentIsResume`,
 * `abortController`), then kept green by the run-local CodexRunContext.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentEvent, AgentInput } from "../types.js";

// ---------------------------------------------------------------------------
// SDK mock
// ---------------------------------------------------------------------------

interface MockStreamEvent {
  type: string;
  thread_id?: string;
  usage?: { input_tokens: number; output_tokens: number };
  item?: Record<string, unknown>;
  error?: string;
  message?: string;
}

const mockStartThread = vi.fn();
const mockResumeThread = vi.fn();
const mockCodexCtor = vi.fn().mockImplementation(() => ({
  startThread: mockStartThread,
  resumeThread: mockResumeThread,
}));

vi.mock("@openai/codex-sdk", () => ({
  Codex: mockCodexCtor,
}));

const { CodexAdapter } = await import("../codex/codex-adapter.js");

// ---------------------------------------------------------------------------
// Controllable stream helpers
// ---------------------------------------------------------------------------

interface Gate {
  promise: Promise<void>;
  open: () => void;
  fail: (err: Error) => void;
}

function makeGate(): Gate {
  let open!: () => void;
  let fail!: (err: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  // Avoid unhandled-rejection noise when a gate is failed after its consumer
  // already returned.
  promise.catch(() => undefined);
  return { promise, open, fail };
}

/**
 * A thread whose stream yields `head` events, then waits on `gate`, then
 * yields `tail` events. If `wireSignal` is set, the captured runStreamed
 * abort signal also rejects the gate wait with an AbortError (mirroring the
 * real SDK, which throws when its signal fires).
 */
function makeGatedThread(options: {
  head: MockStreamEvent[];
  tail?: MockStreamEvent[];
  gate: Gate;
  wireSignal?: boolean;
}) {
  const captured: { signal: AbortSignal | undefined } = { signal: undefined };
  const thread = {
    runStreamed: vi
      .fn()
      .mockImplementation(
        (_prompt: string, opts?: { signal?: AbortSignal }) => {
          captured.signal = opts?.signal;
          return Promise.resolve({
            events: (async function* () {
              for (const e of options.head) yield e;
              if (options.wireSignal) {
                await Promise.race([
                  options.gate.promise,
                  new Promise<never>((_resolve, reject) => {
                    const signal = captured.signal;
                    if (!signal) return;
                    if (signal.aborted) {
                      reject(new DOMException("Aborted", "AbortError"));
                      return;
                    }
                    signal.addEventListener(
                      "abort",
                      () => reject(new DOMException("Aborted", "AbortError")),
                      { once: true },
                    );
                  }),
                ]);
              } else {
                await options.gate.promise;
              }
              for (const e of options.tail ?? []) yield e;
            })(),
          });
        },
      ),
  };
  return { thread, captured };
}

/** Drain a generator into `sink`, resolving when the generator finishes. */
function drain(
  gen: AsyncGenerator<AgentEvent, void, undefined>,
  sink: AgentEvent[],
): Promise<void> {
  return (async () => {
    for await (const event of gen) sink.push(event);
  })();
}

/** Wait until `sink` contains an event matching `predicate` (or time out). */
async function waitFor(
  sink: AgentEvent[],
  predicate: (e: AgentEvent) => boolean,
  timeoutMs = 2_000,
): Promise<AgentEvent> {
  const start = Date.now();
  for (;;) {
    const found = sink.find(predicate);
    if (found) return found;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `waitFor timed out; saw types: ${sink.map((e) => e.type).join(", ")}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function threadStarted(threadId: string): MockStreamEvent {
  return { type: "thread.started", thread_id: threadId };
}

function agentMessage(text: string): MockStreamEvent {
  return {
    type: "item.completed",
    item: { type: "agent_message", id: `m-${text}`, text },
  };
}

function turnCompleted(): MockStreamEvent {
  return {
    type: "turn.completed",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function makeInput(
  prompt: string,
  overrides: Partial<AgentInput> = {},
): AgentInput {
  return { prompt, ...overrides };
}

// ---------------------------------------------------------------------------
// Tests — one shared adapter instance, two concurrent runs
// ---------------------------------------------------------------------------

describe("CodexAdapter concurrency isolation", () => {
  let adapter: InstanceType<typeof CodexAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new CodexAdapter();
  });

  it("run B failing before thread.started does not inherit run A's session id", async () => {
    // Run A: streams thread.started(thread-A) then holds mid-stream.
    const gateA = makeGate();
    const { thread: threadA } = makeGatedThread({
      head: [threadStarted("thread-A")],
      tail: [turnCompleted()],
      gate: gateA,
    });
    // Run B: runStreamed rejects before any stream event.
    const threadB = {
      runStreamed: vi
        .fn()
        .mockRejectedValue(new Error("B exploded pre-stream")),
    };
    mockStartThread.mockReturnValueOnce(threadA).mockReturnValueOnce(threadB);

    const eventsA: AgentEvent[] = [];
    const doneA = drain(adapter.execute(makeInput("prompt A")), eventsA);
    // A is mid-stream with its provider session id assigned.
    await waitFor(eventsA, (e) => e.type === "adapter:started");

    const eventsB: AgentEvent[] = [];
    await drain(adapter.execute(makeInput("prompt B")), eventsB);

    const failedB = eventsB.find((e) => e.type === "adapter:failed");
    expect(failedB).toBeDefined();
    if (failedB?.type === "adapter:failed") {
      // Adapter-wide `currentSessionId` leaks thread-A into B's failure here.
      expect(failedB.sessionId).not.toBe("thread-A");
      expect(failedB.error).toBe("B exploded pre-stream");
    }

    gateA.open();
    await doneA;
    const completedA = eventsA.find((e) => e.type === "adapter:completed");
    expect(completedA).toBeDefined();
    if (completedA?.type === "adapter:completed") {
      expect(completedA.sessionId).toBe("thread-A");
    }
  });

  it("run A's started event carries run A's own prompt even when B starts in between", async () => {
    // A's runStreamed stays pending until we release it, so B can start first.
    let releaseA!: (value: { events: AsyncIterable<MockStreamEvent> }) => void;
    const pendingA = new Promise<{ events: AsyncIterable<MockStreamEvent> }>(
      (resolve) => {
        releaseA = resolve;
      },
    );
    const threadA = { runStreamed: vi.fn().mockReturnValue(pendingA) };

    const gateB = makeGate();
    const { thread: threadB } = makeGatedThread({
      head: [threadStarted("thread-B")],
      tail: [turnCompleted()],
      gate: gateB,
    });
    mockStartThread.mockReturnValueOnce(threadA).mockReturnValueOnce(threadB);

    const eventsA: AgentEvent[] = [];
    const doneA = drain(adapter.execute(makeInput("prompt A")), eventsA);
    // Let A reach its pending runStreamed await.
    await new Promise((resolve) => setTimeout(resolve, 10));

    // B starts and holds mid-stream — adapter-wide currentInput now points at B.
    const eventsB: AgentEvent[] = [];
    const doneB = drain(adapter.execute(makeInput("prompt B")), eventsB);
    await waitFor(eventsB, (e) => e.type === "adapter:started");

    // Release A's stream now.
    releaseA({
      events: (async function* () {
        yield threadStarted("thread-A");
        yield turnCompleted();
      })(),
    });

    const startedA = await waitFor(
      eventsA,
      (e) => e.type === "adapter:started",
    );
    if (startedA.type === "adapter:started") {
      expect(startedA.prompt).toBe("prompt A");
      expect(startedA.sessionId).toBe("thread-A");
    }

    gateB.open();
    await Promise.all([doneA, doneB]);
  });

  it("run A's timeout aborts run A only — run B streams to its own terminal event", async () => {
    const gateA = makeGate();
    const { thread: threadA } = makeGatedThread({
      head: [threadStarted("thread-A")],
      gate: gateA,
      wireSignal: true,
    });
    const gateB = makeGate();
    const { thread: threadB } = makeGatedThread({
      head: [threadStarted("thread-B"), agentMessage("B done")],
      tail: [turnCompleted()],
      gate: gateB,
      wireSignal: true,
    });
    mockStartThread.mockReturnValueOnce(threadA).mockReturnValueOnce(threadB);

    const eventsA: AgentEvent[] = [];
    const doneA = drain(
      adapter.execute(makeInput("prompt A", { options: { timeoutMs: 40 } })),
      eventsA,
    );
    await waitFor(eventsA, (e) => e.type === "adapter:started");

    const eventsB: AgentEvent[] = [];
    const doneB = drain(adapter.execute(makeInput("prompt B")), eventsB);
    await waitFor(eventsB, (e) => e.type === "adapter:started");

    // A's timeout fires. With adapter-wide abort routing this aborts B instead.
    const failedA = await waitFor(eventsA, (e) => e.type === "adapter:failed");
    if (failedA.type === "adapter:failed") {
      expect(failedA.code).toBe("ADAPTER_TIMEOUT");
      expect(failedA.sessionId).toBe("thread-A");
    }
    await doneA;

    // Give any mis-routed abort time to hit B, then let B finish normally.
    await new Promise((resolve) => setTimeout(resolve, 50));
    gateB.open();
    await doneB;

    const completedB = eventsB.find((e) => e.type === "adapter:completed");
    expect(completedB).toBeDefined();
    if (completedB?.type === "adapter:completed") {
      expect(completedB.result).toBe("B done");
      expect(completedB.sessionId).toBe("thread-B");
    }
  });

  it("completion of run A cannot clear run B's controller — interrupt() still reaches B", async () => {
    // A holds mid-stream, then completes once released.
    const gateA = makeGate();
    const { thread: threadA } = makeGatedThread({
      head: [threadStarted("thread-A")],
      tail: [turnCompleted()],
      gate: gateA,
    });
    // B hangs, abortable via its combined run signal.
    const gateB = makeGate();
    const { thread: threadB } = makeGatedThread({
      head: [threadStarted("thread-B")],
      gate: gateB,
      wireSignal: true,
    });
    mockStartThread.mockReturnValueOnce(threadA).mockReturnValueOnce(threadB);

    const eventsA: AgentEvent[] = [];
    const doneA = drain(adapter.execute(makeInput("prompt A")), eventsA);
    await waitFor(eventsA, (e) => e.type === "adapter:started");

    // B starts while A is still live...
    const eventsB: AgentEvent[] = [];
    const doneB = drain(adapter.execute(makeInput("prompt B")), eventsB);
    await waitFor(eventsB, (e) => e.type === "adapter:started");

    // ...then A completes. Its cleanup must not clear B's controller.
    gateA.open();
    await doneA;
    expect(eventsA.some((e) => e.type === "adapter:completed")).toBe(true);

    // Emergency adapter-wide interrupt must still abort the live run B, even
    // though A's finally block already ran.
    adapter.interrupt();

    const outcome = await Promise.race([
      doneB.then(() => "terminated" as const),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 500)),
    ]);
    if (outcome === "hung") {
      // Clean up the hung generator before failing.
      gateB.fail(new DOMException("Aborted", "AbortError"));
      await doneB.catch(() => undefined);
    }
    expect(outcome).toBe("terminated");
    const completedB = eventsB.find((e) => e.type === "adapter:completed");
    if (completedB?.type === "adapter:completed") {
      expect(completedB.result).toBe("(interrupted)");
    }
  });

  it("caller AbortSignal cancels its own run only (authoritative per-turn cancellation)", async () => {
    const acA = new AbortController();
    const gateA = makeGate();
    const { thread: threadA } = makeGatedThread({
      head: [threadStarted("thread-A")],
      gate: gateA,
      wireSignal: true,
    });
    const gateB = makeGate();
    const { thread: threadB } = makeGatedThread({
      head: [threadStarted("thread-B"), agentMessage("B survives")],
      tail: [turnCompleted()],
      gate: gateB,
      wireSignal: true,
    });
    mockStartThread.mockReturnValueOnce(threadA).mockReturnValueOnce(threadB);

    const eventsA: AgentEvent[] = [];
    const doneA = drain(
      adapter.execute(makeInput("prompt A", { signal: acA.signal })),
      eventsA,
    );
    await waitFor(eventsA, (e) => e.type === "adapter:started");

    const eventsB: AgentEvent[] = [];
    const doneB = drain(adapter.execute(makeInput("prompt B")), eventsB);
    await waitFor(eventsB, (e) => e.type === "adapter:started");

    acA.abort();
    await doneA;
    const completedA = eventsA.find((e) => e.type === "adapter:completed");
    expect(completedA).toBeDefined();
    if (completedA?.type === "adapter:completed") {
      expect(completedA.result).toBe("(interrupted)");
    }

    gateB.open();
    await doneB;
    const completedB = eventsB.find((e) => e.type === "adapter:completed");
    expect(completedB).toBeDefined();
    if (completedB?.type === "adapter:completed") {
      expect(completedB.result).toBe("B survives");
    }
  });

  it("a concurrent resume(A) does not leak its resume session id into execute(B)", async () => {
    const gateA = makeGate();
    const { thread: threadA } = makeGatedThread({
      head: [threadStarted("resume-A")],
      tail: [turnCompleted()],
      gate: gateA,
    });
    mockResumeThread.mockReturnValueOnce(threadA);
    // B fails before any stream event → uses its initial session id.
    const threadB = {
      runStreamed: vi.fn().mockRejectedValue(new Error("B failed early")),
    };
    mockStartThread.mockReturnValueOnce(threadB);

    const eventsA: AgentEvent[] = [];
    const doneA = drain(
      adapter.resumeSession("resume-A", makeInput("prompt A")),
      eventsA,
    );
    await waitFor(eventsA, (e) => e.type === "adapter:started");

    const eventsB: AgentEvent[] = [];
    await drain(adapter.execute(makeInput("prompt B")), eventsB);
    const failedB = eventsB.find((e) => e.type === "adapter:failed");
    expect(failedB).toBeDefined();
    if (failedB?.type === "adapter:failed") {
      expect(failedB.sessionId).not.toBe("resume-A");
    }

    gateA.open();
    await doneA;
    const completedA = eventsA.find((e) => e.type === "adapter:completed");
    expect(completedA).toBeDefined();
    if (completedA?.type === "adapter:completed") {
      expect(completedA.sessionId).toBe("resume-A");
      expect(completedA.durationMs).toBeGreaterThanOrEqual(0);
    }
    const startedA = eventsA.find((e) => e.type === "adapter:started");
    if (startedA?.type === "adapter:started") {
      expect(startedA.isResume).toBe(true);
    }
  });
});
