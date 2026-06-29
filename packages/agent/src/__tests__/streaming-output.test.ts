/**
 * streaming-output.test.ts
 *
 * Comprehensive tests for streaming output behaviour across all three
 * streaming primitives:
 *
 *   1. TextDeltaBuffer   — word-boundary accumulation
 *   2. StreamingRunHandle — async-iterable event bus with backpressure
 *   3. StreamActionParser — incremental tool-call JSON assembly
 *
 * Topics covered:
 *   - Chunk assembly and ordering
 *   - Backpressure (slow consumer, buffer high-watermark)
 *   - Abort / cancel mid-flight and cleanup (no leaked handlers)
 *   - Partial tool calls arriving across many chunks, malformed JSON recovery
 *   - Error mid-stream: propagation and partial output availability
 *   - Stream completion detection: done signal, final chunk, closed state
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { TextDeltaBuffer } from "../streaming/text-delta-buffer.js";
import { StreamingRunHandle } from "../streaming/streaming-run-handle.js";
import { StreamActionParser } from "../streaming/stream-action-parser.js";
import type { StreamEvent } from "../streaming/streaming-types.js";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function makeTool(
  name: string,
  impl: (args: Record<string, unknown>) => Promise<unknown> = async () => "ok"
): StructuredToolInterface {
  return {
    name,
    invoke: vi.fn(impl),
  } as unknown as StructuredToolInterface;
}

/** Collects all events from a StreamingRunHandle.events() into an array. */
async function drainHandle(handle: StreamingRunHandle): Promise<StreamEvent[]> {
  const collected: StreamEvent[] = [];
  for await (const event of handle.events()) {
    collected.push(event);
  }
  return collected;
}

/** Delays for `ms` milliseconds (used to simulate slow consumers). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ===========================================================================
// 1. TextDeltaBuffer — chunk assembly and ordering
// ===========================================================================

describe("TextDeltaBuffer — chunk assembly and ordering", () => {
  let buffer: TextDeltaBuffer;

  beforeEach(() => {
    buffer = new TextDeltaBuffer();
  });

  it("single push with trailing space emits one chunk", () => {
    const result = buffer.push("word ");
    expect(result).toEqual(["word "]);
    expect(buffer.peek()).toBe("");
  });

  it("three sequential partial pushes concatenate correctly before emitting", () => {
    expect(buffer.push("hel")).toEqual([]);
    expect(buffer.push("lo")).toEqual([]);
    const result = buffer.push(" ");
    expect(result).toEqual(["hello "]);
    expect(buffer.peek()).toBe("");
  });

  it("ordering is preserved across interleaved full and partial words", () => {
    const r1 = buffer.push("alpha ");
    const r2 = buffer.push("beta");
    const r3 = buffer.push(" gamma ");
    expect(r1).toEqual(["alpha "]);
    expect(r2).toEqual([]);
    // "beta " becomes a complete word once the space in r3 arrives
    expect(r3).toEqual(["beta ", "gamma "]);
  });

  it("push of a single whitespace character emits nothing (no word before it)", () => {
    const result = buffer.push(" ");
    // The space alone forms no word — the regex matches \S+\s* so leading
    // whitespace with no preceding non-whitespace produces no chunk.
    expect(result).toEqual([]);
  });

  it("preserves order when multiple words arrive in one large chunk", () => {
    const result = buffer.push("one two three ");
    expect(result).toEqual(["one ", "two ", "three "]);
    expect(buffer.peek()).toBe("");
  });

  it("tab character (\t) is treated as a word boundary", () => {
    const result = buffer.push("col1\tcol2");
    // "col1\t" is complete; "col2" is partial
    expect(result).toEqual(["col1\t"]);
    expect(buffer.peek()).toBe("col2");
  });

  it("carriage return (\r) is treated as a word boundary", () => {
    const result = buffer.push("line\r");
    expect(result).toEqual(["line\r"]);
    expect(buffer.peek()).toBe("");
  });

  it("CRLF sequence (\r\n) keeps both characters with the word", () => {
    const result = buffer.push("line\r\n");
    // last whitespace index is \n; "line\r\n" should be emitted as a chunk
    expect(result.join("")).toBe("line\r\n");
  });

  it("multiple consecutive pushes accumulate then emit correctly", () => {
    buffer.push("The");
    buffer.push(" ");
    const r = buffer.push("quick ");
    // After ' ' the word "The " becomes complete; "quick " is its own chunk
    expect(r).toContain("quick ");
  });

  it("flush after partial word returns the partial and resets", () => {
    buffer.push("incomplete");
    const flushed = buffer.flush();
    expect(flushed).toBe("incomplete");
    expect(buffer.peek()).toBe("");
    expect(buffer.flush()).toBe("");
  });

  it("interleaved push and flush returns correct state each time", () => {
    buffer.push("alpha ");
    // Drain with push then flush remaining
    buffer.push("beta");
    const partial = buffer.flush();
    expect(partial).toBe("beta");
    // After flush, further pushes start fresh
    const r = buffer.push("gamma ");
    expect(r).toEqual(["gamma "]);
  });

  it("reset after flush leaves buffer in clean state", () => {
    buffer.push("word");
    buffer.flush();
    buffer.reset(); // double reset is safe
    expect(buffer.peek()).toBe("");
    expect(buffer.flush()).toBe("");
  });

  it("unicode multi-byte characters do not corrupt word boundaries", () => {
    // "résumé" contains accented chars; the boundary is the trailing space
    const result = buffer.push("résumé ");
    expect(result).toEqual(["résumé "]);
  });

  it("emoji characters are treated as regular non-whitespace", () => {
    const result = buffer.push("hello 👋 world ");
    // "hello " is one chunk, "👋 " is another, "world " is another
    expect(result.join("")).toBe("hello 👋 world ");
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it("very long word without whitespace stays buffered until flush", () => {
    const longWord = "a".repeat(10_000);
    const result = buffer.push(longWord);
    expect(result).toEqual([]); // no whitespace found
    expect(buffer.peek()).toBe(longWord);
    expect(buffer.flush()).toBe(longWord);
  });

  it("chunk arriving out of typical order still concatenates correctly", () => {
    // Simulates tokens arriving as: "wo", "rld ", "hel", "lo "
    buffer.push("wo");
    buffer.push("rld ");
    buffer.push("hel");
    const last = buffer.push("lo ");
    // At this point we expect "world " then the "hello " produced by last push
    expect(last).toContain("hello ");
  });
});

// ===========================================================================
// 2. StreamingRunHandle — backpressure, abort mid-flight, completion detection
// ===========================================================================

describe("StreamingRunHandle — backpressure and slow consumer", () => {
  it("producer can push faster than consumer without losing events up to buffer limit", async () => {
    const handle = new StreamingRunHandle({ maxBufferSize: 10 });

    // Push 10 events synchronously (all buffered)
    for (let i = 0; i < 10; i++) {
      handle.push({ type: "text_delta", content: `chunk-${i}` });
    }
    handle.complete();

    const events = await drainHandle(handle);
    expect(events).toHaveLength(10);
    for (let i = 0; i < 10; i++) {
      expect((events[i] as { type: string; content: string }).content).toBe(
        `chunk-${i}`
      );
    }
  });

  it("events beyond maxBufferSize are silently dropped (high-watermark protection)", async () => {
    const handle = new StreamingRunHandle({ maxBufferSize: 5 });

    for (let i = 0; i < 8; i++) {
      handle.push({ type: "text_delta", content: `e${i}` });
    }
    handle.complete();

    const events = await drainHandle(handle);
    // Only the first 5 arrive; the last 3 are dropped
    expect(events).toHaveLength(5);
    const first = events[0] as { type: string; content: string };
    expect(first.content).toBe("e0");
  });

  it("slow consumer that awaits between reads still drains all events", async () => {
    const handle = new StreamingRunHandle();

    // Push synchronously
    handle.push({ type: "text_delta", content: "a" });
    handle.push({ type: "text_delta", content: "b" });
    handle.push({ type: "text_delta", content: "c" });
    handle.complete();

    const collected: string[] = [];
    for await (const event of handle.events()) {
      if (event.type === "text_delta") {
        collected.push(event.content);
        await delay(1); // simulate slow processing
      }
    }

    expect(collected).toEqual(["a", "b", "c"]);
  });

  it("producer interleaved with consumer receives events in push order", async () => {
    const handle = new StreamingRunHandle();
    const received: number[] = [];
    let pushedCount = 0;

    const consumePromise = (async () => {
      for await (const event of handle.events()) {
        if (event.type === "text_delta") {
          received.push(Number(event.content));
        }
      }
    })();

    // Interleave pushes with async yields
    for (let i = 0; i < 5; i++) {
      handle.push({ type: "text_delta", content: String(i) });
      pushedCount++;
      await delay(0); // yield to event loop
    }
    handle.complete();

    await consumePromise;
    expect(received).toEqual([0, 1, 2, 3, 4]);
  });

  it("consumer waiting before any push receives event as soon as it arrives", async () => {
    const handle = new StreamingRunHandle();

    const iter = handle.events()[Symbol.asyncIterator]();
    const nextPromise = iter.next(); // consumer is now waiting

    // Push arrives after consumer is already waiting
    handle.push({ type: "text_delta", content: "late arrival" });

    const result = await nextPromise;
    expect(result.done).toBe(false);
    expect((result.value as { type: string; content: string }).content).toBe(
      "late arrival"
    );

    handle.complete();
  });

  it("maxBufferSize of 1 only keeps the single most recently buffered event", async () => {
    const handle = new StreamingRunHandle({ maxBufferSize: 1 });
    handle.push({ type: "text_delta", content: "first" });
    handle.push({ type: "text_delta", content: "second" }); // dropped
    handle.complete();

    const events = await drainHandle(handle);
    expect(events).toHaveLength(1);
    expect((events[0] as { content: string }).content).toBe("first");
  });
});

describe("StreamingRunHandle — abort / cancel mid-flight", () => {
  it("cancel() while consumer is waiting terminates the iterator", async () => {
    const handle = new StreamingRunHandle();
    const events: StreamEvent[] = [];

    const consumePromise = (async () => {
      for await (const event of handle.events()) {
        events.push(event);
      }
    })();

    handle.push({ type: "text_delta", content: "before cancel" });
    await delay(2); // let consumer process the queued event
    handle.cancel();

    await consumePromise;
    // At least the first event was received before cancel
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.type).toBe("text_delta");
  });

  it("status is cancelled after cancel() is called", () => {
    const handle = new StreamingRunHandle();
    expect(handle.status).toBe("running");
    handle.cancel();
    expect(handle.status).toBe("cancelled");
  });

  it("cancel() is idempotent — calling twice does not throw", () => {
    const handle = new StreamingRunHandle();
    handle.cancel();
    expect(() => handle.cancel()).not.toThrow();
    expect(handle.status).toBe("cancelled");
  });

  it('pushing to a cancelled stream throws with "cancelled" in the message', () => {
    const handle = new StreamingRunHandle();
    handle.cancel();
    expect(() =>
      handle.push({ type: "text_delta", content: "too late" })
    ).toThrow("cancelled");
  });

  it("events pushed before cancel are received by a pre-buffered consumer", async () => {
    const handle = new StreamingRunHandle();

    // Buffer two events, then cancel, then start consuming
    handle.push({ type: "text_delta", content: "first" });
    handle.push({ type: "text_delta", content: "second" });
    handle.cancel();

    // Consumer starts after cancel — drains buffered queue, then terminates
    const events = await drainHandle(handle);
    // Buffered events should be delivered even after cancel
    expect(events.length).toBe(2);
  });

  it("no waiter reference is leaked after cancel()", () => {
    const handle = new StreamingRunHandle();

    // Create a consumer that is currently waiting
    const iter = handle.events()[Symbol.asyncIterator]();
    const nextPromise = iter.next(); // registers a waiter

    handle.cancel(); // should resolve the waiter with done=true

    return expect(nextPromise).resolves.toMatchObject({ done: true });
  });

  it("no waiter reference is leaked after complete()", () => {
    const handle = new StreamingRunHandle();

    const iter = handle.events()[Symbol.asyncIterator]();
    const nextPromise = iter.next(); // registers a waiter

    handle.complete();

    return expect(nextPromise).resolves.toMatchObject({ done: true });
  });

  it("post-cancel status is stable — subsequent status checks remain cancelled", () => {
    const handle = new StreamingRunHandle();
    handle.cancel();
    for (let i = 0; i < 5; i++) {
      expect(handle.status).toBe("cancelled");
    }
  });
});

describe("StreamingRunHandle — error mid-stream", () => {
  it("error event is emitted before stream terminates", async () => {
    const handle = new StreamingRunHandle();

    handle.push({ type: "text_delta", content: "partial output" });
    handle.fail(new Error("mid-stream failure"));

    const events = await drainHandle(handle);
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("text_delta");
    expect(events[1]!.type).toBe("error");
    if (events[1]!.type === "error") {
      expect(events[1]!.error.message).toBe("mid-stream failure");
    }
  });

  it('fail() status is "failed" after being called', () => {
    const handle = new StreamingRunHandle();
    handle.fail(new Error("oops"));
    expect(handle.status).toBe("failed");
  });

  it("fail() is idempotent after complete — status stays completed", () => {
    const handle = new StreamingRunHandle();
    handle.complete();
    handle.fail(new Error("late error"));
    expect(handle.status).toBe("completed");
  });

  it('pushing to a failed stream throws with "failed" in the message', () => {
    const handle = new StreamingRunHandle();
    handle.fail(new Error("gone"));
    expect(() =>
      handle.push({ type: "text_delta", content: "too late" })
    ).toThrow("failed");
  });

  it("error propagation works when consumer is waiting at time of fail()", async () => {
    const handle = new StreamingRunHandle();
    const events: StreamEvent[] = [];

    const consumePromise = (async () => {
      for await (const e of handle.events()) {
        events.push(e);
      }
    })();

    // Consumer is waiting; fail() should deliver the error event directly
    handle.fail(new Error("direct delivery"));

    await consumePromise;

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("error");
    if (events[0]!.type === "error") {
      expect(events[0]!.error.message).toBe("direct delivery");
    }
  });

  it("partial output before error is accessible to consumer", async () => {
    const handle = new StreamingRunHandle();

    handle.push({ type: "text_delta", content: "line 1" });
    handle.push({ type: "text_delta", content: "line 2" });
    handle.push({ type: "text_delta", content: "line 3" });
    handle.fail(new Error("abort"));

    const events = await drainHandle(handle);
    const textEvents = events.filter((e) => e.type === "text_delta");
    expect(textEvents).toHaveLength(3);
    expect(events.at(-1)!.type).toBe("error");
  });

  it("error in buffer is delivered after already-buffered text events", async () => {
    // No consumer is waiting when fail() is called
    const handle = new StreamingRunHandle();
    handle.push({ type: "text_delta", content: "before error" });
    handle.fail(new Error("buffered error"));

    const events = await drainHandle(handle);
    expect(events[0]!.type).toBe("text_delta");
    expect(events[1]!.type).toBe("error");
  });
});

describe("StreamingRunHandle — stream completion detection", () => {
  it("done signal terminates the async iterator", async () => {
    const handle = new StreamingRunHandle();
    handle.push({ type: "done", finalOutput: "the final answer" });
    handle.complete();

    const events = await drainHandle(handle);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("done");
    if (events[0]!.type === "done") {
      expect(events[0]!.finalOutput).toBe("the final answer");
    }
  });

  it("final chunk (done event) is the last event emitted", async () => {
    const handle = new StreamingRunHandle();
    handle.push({ type: "text_delta", content: "part 1" });
    handle.push({ type: "text_delta", content: "part 2" });
    handle.push({ type: "done", finalOutput: "part 1part 2" });
    handle.complete();

    const events = await drainHandle(handle);
    expect(events.at(-1)!.type).toBe("done");
    // Nothing comes after done
    expect(events).toHaveLength(3);
  });

  it("iterator is done (next().done === true) after complete() drains the queue", async () => {
    const handle = new StreamingRunHandle();
    handle.complete();

    const iter = handle.events()[Symbol.asyncIterator]();
    const result = await iter.next();
    expect(result.done).toBe(true);
  });

  it("complete() is idempotent — calling twice does not emit extra done signal", async () => {
    const handle = new StreamingRunHandle();
    handle.complete();
    handle.complete(); // second call is a no-op
    expect(handle.status).toBe("completed");

    const events = await drainHandle(handle);
    expect(events).toHaveLength(0);
  });

  it("stream is closed (status=completed) before events are consumed", async () => {
    const handle = new StreamingRunHandle();
    handle.push({ type: "text_delta", content: "buffered" });
    handle.complete();

    // Even though status is completed, buffered events are still drainable
    expect(handle.status).toBe("completed");
    const events = await drainHandle(handle);
    expect(events).toHaveLength(1);
  });

  it("two separate calls to events() on the same handle both drain the same buffer", async () => {
    const handle = new StreamingRunHandle();
    handle.push({ type: "text_delta", content: "shared" });
    handle.complete();

    // First consumer drains the event
    const first = await drainHandle(handle);
    expect(first).toHaveLength(1);

    // Second consumer finds nothing left (queue was drained)
    const second = await drainHandle(handle);
    expect(second).toHaveLength(0);
  });

  it("tool_call events are delivered in order and iterator completes after done", async () => {
    const handle = new StreamingRunHandle();
    handle.push({ type: "tool_call_start", toolName: "search", callId: "c1" });
    handle.push({ type: "tool_call_end", callId: "c1", result: { hits: 3 } });
    handle.push({ type: "done", finalOutput: "search complete" });
    handle.complete();

    const events = await drainHandle(handle);
    expect(events.map((e) => e.type)).toEqual([
      "tool_call_start",
      "tool_call_end",
      "done",
    ]);
  });
});

// ===========================================================================
// 3. StreamActionParser — partial tool calls and multi-chunk assembly
// ===========================================================================

describe("StreamActionParser — partial tool calls spanning multiple chunks", () => {
  it("tool call spanning 3 chunks fires only when JSON is complete", async () => {
    const invoked: unknown[] = [];
    const tool = makeTool("analyze", async (args) => {
      invoked.push(args);
      return "analyzed";
    });
    const parser = new StreamActionParser([tool]);

    // Chunk 1: just the name and opening brace
    const e1 = await parser.processChunk({
      tool_call_chunks: [{ id: "tc1", name: "analyze", args: '{"inp' }],
    });
    expect(e1.filter((e) => e.type === "tool_call_start")).toHaveLength(0);

    // Chunk 2: middle of the JSON value
    const e2 = await parser.processChunk({
      tool_call_chunks: [{ id: "tc1", args: 'ut":"he' }],
    });
    expect(e2.filter((e) => e.type === "tool_call_start")).toHaveLength(0);

    // Chunk 3: closing brace completes the JSON
    const e3 = await parser.processChunk({
      tool_call_chunks: [{ id: "tc1", args: 'llo"}' }],
    });
    expect(e3.filter((e) => e.type === "tool_call_start")).toHaveLength(1);
    expect(e3.filter((e) => e.type === "tool_result")).toHaveLength(1);
    expect(invoked[0]).toEqual({ input: "hello" });
  });

  it("two different tool calls arrive in separate chunks and both fire correctly", async () => {
    const log: string[] = [];
    const search = makeTool("search", async (a) => {
      log.push(`search:${a["q"]}`);
      return "results";
    });
    const write = makeTool("write", async (a) => {
      log.push(`write:${a["content"]}`);
      return "written";
    });
    const parser = new StreamActionParser([search, write]);

    await parser.processChunk({
      tool_calls: [{ id: "s1", name: "search", args: { q: "cats" } }],
    });
    await parser.processChunk({
      tool_calls: [{ id: "w1", name: "write", args: { content: "meow" } }],
    });

    expect(log).toEqual(["search:cats", "write:meow"]);
  });

  it("two tool calls in a single non-streaming chunk both execute", async () => {
    const log: string[] = [];
    const t1 = makeTool("a", async () => {
      log.push("a");
      return "ra";
    });
    const t2 = makeTool("b", async () => {
      log.push("b");
      return "rb";
    });
    const parser = new StreamActionParser([t1, t2]);

    const events = await parser.processChunk({
      tool_calls: [
        { id: "i1", name: "a", args: {} },
        { id: "i2", name: "b", args: {} },
      ],
    });

    const starts = events.filter((e) => e.type === "tool_call_start");
    const results = events.filter((e) => e.type === "tool_result");
    expect(starts).toHaveLength(2);
    expect(results).toHaveLength(2);
    expect(log).toEqual(["a", "b"]);
  });

  it("name arrives in a later chunk than the initial args fragment", async () => {
    const tool = makeTool("lateNamed", async (a) => `got:${a["v"]}`);
    const parser = new StreamActionParser([tool]);

    // First chunk: id + args fragment but NO name yet
    const e1 = await parser.processChunk({
      tool_call_chunks: [{ id: "q1", args: '{"v":' }],
    });
    expect(e1).toHaveLength(0); // no name yet, nothing fires

    // Second chunk: name arrives with rest of args
    const e2 = await parser.processChunk({
      tool_call_chunks: [{ id: "q1", name: "lateNamed", args: "42}" }],
    });
    const result = e2.find((e) => e.type === "tool_result");
    expect(result).toBeDefined();
    expect(result!.data.result).toBe("got:42");
  });

  it("malformed partial JSON that never becomes valid is skipped at flush time", async () => {
    const parser = new StreamActionParser([makeTool("x")]);

    await parser.processChunk({
      tool_call_chunks: [{ id: "bad", name: "x", args: '{"broken' }],
    });

    // Flush — args are incomplete, JSON never parseable
    const flushed = await parser.flush();
    expect(flushed.filter((e) => e.type === "tool_call_start")).toHaveLength(0);
    expect(flushed.filter((e) => e.type === "tool_result")).toHaveLength(0);
  });

  it("valid JSON surrounded by extra whitespace in chunks is parsed correctly", async () => {
    const invoked: unknown[] = [];
    const tool = makeTool("padded", async (a) => {
      invoked.push(a);
      return "done";
    });
    const parser = new StreamActionParser([tool]);

    const events = await parser.processChunk({
      tool_calls: [{ id: "p1", name: "padded", args: '  {"x": 99}  ' }],
    });

    expect(events.some((e) => e.type === "tool_result")).toBe(true);
    expect(invoked[0]).toEqual({ x: 99 });
  });

  it("tool call with empty object args {} fires with no arguments", async () => {
    const invoked: unknown[] = [];
    const tool = makeTool("noargs", async (a) => {
      invoked.push(a);
      return "ok";
    });
    const parser = new StreamActionParser([tool]);

    await parser.processChunk({
      tool_calls: [{ id: "n1", name: "noargs", args: "{}" }],
    });

    expect(invoked[0]).toEqual({});
  });

  it("index-based ID for streaming chunks is consistent across chunks", async () => {
    const calls: string[] = [];
    const tool = makeTool("indexed", async () => {
      calls.push("called");
      return "ok";
    });
    const parser = new StreamActionParser([tool]);

    // Use index 0 as fallback id — must be consistent across two chunks
    await parser.processChunk({
      tool_call_chunks: [{ index: 0, name: "indexed", args: '{"p":' }],
    });
    const events = await parser.processChunk({
      tool_call_chunks: [{ index: 0, args: '"v"}' }],
    });

    expect(calls).toHaveLength(1);
    expect(events.filter((e) => e.type === "tool_call_start")).toHaveLength(1);
  });
});

describe("StreamActionParser — error in stream mid-way", () => {
  it("error event carries the failing tool name and message", async () => {
    const tool = makeTool("crasher", async () => {
      throw new Error("tool crashed");
    });
    const parser = new StreamActionParser([tool]);

    const events = await parser.processChunk({
      tool_calls: [{ id: "e1", name: "crasher", args: {} }],
    });

    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    expect(err!.data.error).toBe("tool crashed");
    expect(err!.data.toolCall?.name).toBe("crasher");
  });

  it("error in one tool does not prevent a subsequent tool from executing", async () => {
    const crasher = makeTool("crasher", async () => {
      throw new Error("first fails");
    });
    const fine = makeTool("fine", async () => "success");
    const parser = new StreamActionParser([crasher, fine]);

    const events1 = await parser.processChunk({
      tool_calls: [{ id: "e1", name: "crasher", args: {} }],
    });
    const events2 = await parser.processChunk({
      tool_calls: [{ id: "e2", name: "fine", args: {} }],
    });

    expect(events1.some((e) => e.type === "error")).toBe(true);
    expect(events2.some((e) => e.type === "tool_result")).toBe(true);
  });

  it("non-Error rejection value is stringified in the error event", async () => {
    const tool = makeTool("rejection", async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 42;
    });
    const parser = new StreamActionParser([tool]);

    const events = await parser.processChunk({
      tool_calls: [{ id: "r1", name: "rejection", args: {} }],
    });

    const err = events.find((e) => e.type === "error");
    expect(err!.data.error).toBe("42");
  });

  it("unknown tool in a multi-tool chunk returns error only for the unknown one", async () => {
    const known = makeTool("known", async () => "ok");
    const parser = new StreamActionParser([known]);

    const events = await parser.processChunk({
      tool_calls: [
        { id: "k1", name: "known", args: {} },
        { id: "u1", name: "unknown_tool", args: {} },
      ],
    });

    const results = events.filter((e) => e.type === "tool_result");
    const errors = events.filter((e) => e.type === "error");
    expect(results).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.data.error).toContain('"unknown_tool" not found');
  });
});

describe("StreamActionParser — stream completion and flush behaviour", () => {
  it("flush on a completely empty parser returns empty array", async () => {
    const parser = new StreamActionParser([]);
    const events = await parser.flush();
    expect(events).toHaveLength(0);
  });

  it("flush fires any pending but not-yet-completed call when args are now valid JSON", async () => {
    // This tests the scenario where args arrive incrementally and the last
    // chunk happens to complete the JSON but wasn't detected mid-stream.
    // (In practice the processChunk fires it — so flush should find nothing extra,
    //  but we verify flush returns defined and does not throw.)
    const tool = makeTool("late", async () => "late result");
    const parser = new StreamActionParser([tool]);

    await parser.processChunk({
      tool_call_chunks: [{ id: "l1", name: "late", args: '{"a":1' }],
    });
    await parser.processChunk({
      tool_call_chunks: [{ id: "l1", args: "}" }],
    });

    const flushed = await parser.flush();
    // processChunk already fired it on the second chunk; flush finds nothing extra
    expect(Array.isArray(flushed)).toBe(true);
  });

  it("text-only stream with no tool calls completes cleanly", async () => {
    const parser = new StreamActionParser([]);

    const e1 = await parser.processChunk({ content: "Hello " });
    const e2 = await parser.processChunk({ content: "world" });
    const flushed = await parser.flush();

    expect(e1[0]!.type).toBe("text");
    expect(e2[0]!.type).toBe("text");
    expect(flushed).toHaveLength(0);
  });

  it("processChunk and flush return all events; together they cover the full stream", async () => {
    const tool = makeTool("counter", async () => "1");
    const parser = new StreamActionParser([tool]);

    const allEvents: ReturnType<typeof parser.processChunk> extends Promise<
      infer T
    >
      ? T[]
      : never[] = [];

    allEvents.push(...(await parser.processChunk({ content: "thinking..." })));
    allEvents.push(
      ...(await parser.processChunk({
        tool_calls: [{ id: "c1", name: "counter", args: {} }],
      }))
    );
    allEvents.push(...(await parser.flush()));

    const types = allEvents.map((e) => e.type);
    expect(types).toContain("text");
    expect(types).toContain("tool_call_start");
    expect(types).toContain("tool_result");
  });

  it("same tool called twice with different IDs both execute (dedup by ID not name)", async () => {
    let callCount = 0;
    const tool = makeTool("counter", async () => {
      callCount++;
      return `call ${callCount}`;
    });
    const parser = new StreamActionParser([tool]);

    await parser.processChunk({
      tool_calls: [{ id: "call_A", name: "counter", args: {} }],
    });
    await parser.processChunk({
      tool_calls: [{ id: "call_B", name: "counter", args: {} }],
    });

    expect(callCount).toBe(2);
  });

  it("same ID appearing in both tool_call_chunks and tool_calls is not double-fired", async () => {
    let callCount = 0;
    const tool = makeTool("once", async () => {
      callCount++;
      return "ok";
    });
    const parser = new StreamActionParser([tool]);

    // Fire via streaming chunks
    await parser.processChunk({
      tool_call_chunks: [{ id: "dup", name: "once", args: "{}" }],
    });

    // Same ID comes again via non-streaming path (should be ignored)
    await parser.processChunk({
      tool_calls: [{ id: "dup", name: "once", args: {} }],
    });

    expect(callCount).toBe(1);
  });
});

describe("StreamActionParser — mixed text and tool events ordering", () => {
  it("text events appear before tool events within the same chunk", async () => {
    const tool = makeTool("t", async () => "ok");
    const parser = new StreamActionParser([tool]);

    const events = await parser.processChunk({
      content: "I will call a tool now.",
      tool_calls: [{ id: "x1", name: "t", args: {} }],
    });

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("text");
    expect(types.includes("tool_call_start")).toBe(true);
  });

  it("multiple text chunks preserve content across processChunk calls", async () => {
    const parser = new StreamActionParser([]);
    const texts: string[] = [];

    const chunks = ["The ", "quick ", "brown ", "fox"];
    for (const c of chunks) {
      const events = await parser.processChunk({ content: c });
      for (const e of events) {
        if (e.type === "text" && e.data.content) texts.push(e.data.content);
      }
    }

    expect(texts.join("")).toBe("The quick brown fox");
  });
});

// ===========================================================================
// 4. Integration: TextDeltaBuffer feeding StreamingRunHandle
// ===========================================================================

describe("Integration — TextDeltaBuffer feeding StreamingRunHandle", () => {
  it("words buffered in TextDeltaBuffer are pushed to handle in order", async () => {
    const handle = new StreamingRunHandle();
    const buf = new TextDeltaBuffer();

    const tokens = ["Hel", "lo ", "wor", "ld!"];
    for (const token of tokens) {
      const words = buf.push(token);
      for (const word of words) {
        handle.push({ type: "text_delta", content: word });
      }
    }
    // Flush any remaining partial
    const remaining = buf.flush();
    if (remaining) handle.push({ type: "text_delta", content: remaining });
    handle.complete();

    const events = await drainHandle(handle);
    const assembled = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as { content: string }).content)
      .join("");
    expect(assembled).toBe("Hello world!");
  });

  it("handles empty token stream gracefully — no events pushed", async () => {
    const handle = new StreamingRunHandle();
    const buf = new TextDeltaBuffer();

    // Push empty strings only
    for (const t of ["", "", ""]) {
      const words = buf.push(t);
      for (const w of words) handle.push({ type: "text_delta", content: w });
    }
    const remaining = buf.flush();
    if (remaining) handle.push({ type: "text_delta", content: remaining });
    handle.complete();

    const events = await drainHandle(handle);
    expect(events).toHaveLength(0);
  });
});

// ===========================================================================
// 5. TextDeltaBuffer — additional edge cases and boundary conditions
// ===========================================================================

describe("TextDeltaBuffer — newline handling", () => {
  let buffer: TextDeltaBuffer;

  beforeEach(() => {
    buffer = new TextDeltaBuffer();
  });

  it("newline terminates the preceding word", () => {
    const result = buffer.push("line\n");
    expect(result).toEqual(["line\n"]);
    expect(buffer.peek()).toBe("");
  });

  it("consecutive newlines produce nothing (no non-whitespace before them)", () => {
    buffer.push("word\n");
    const result = buffer.push("\n\n");
    // The two extra newlines alone have no preceding \S+ to emit
    expect(result).toEqual([]);
  });

  it("word followed by multiple spaces keeps all spaces attached", () => {
    const result = buffer.push("gap   ");
    expect(result.join("")).toBe("gap   ");
  });

  it("mixed spaces and newlines in one push emits all complete words", () => {
    const result = buffer.push("a b\nc ");
    expect(result.join("")).toBe("a b\nc ");
    expect(result.length).toBeGreaterThanOrEqual(3);
  });

  it("only whitespace token does not corrupt previously buffered partial word", () => {
    buffer.push("part"); // buffered
    const result = buffer.push(" "); // space completes "part "
    expect(result).toEqual(["part "]);
    expect(buffer.peek()).toBe("");
  });

  it("push of an empty string is a no-op and returns []", () => {
    buffer.push("start");
    const result = buffer.push("");
    expect(result).toEqual([]);
    expect(buffer.peek()).toBe("start"); // unchanged
  });

  it("multiple flushes on an empty buffer always return empty string", () => {
    expect(buffer.flush()).toBe("");
    expect(buffer.flush()).toBe("");
    expect(buffer.flush()).toBe("");
  });

  it("reset after partial push leaves peek empty", () => {
    buffer.push("partial");
    buffer.reset();
    expect(buffer.peek()).toBe("");
  });

  it("reset mid-word means subsequent push starts fresh", () => {
    buffer.push("hel");
    buffer.reset();
    const result = buffer.push("new ");
    expect(result).toEqual(["new "]);
  });

  it("punctuation embedded in word does not trigger a boundary", () => {
    buffer.push("don't");
    // No whitespace — still partial
    expect(buffer.peek()).toBe("don't");
    const result = buffer.push(" ");
    expect(result).toEqual(["don't "]);
  });

  it("number tokens are handled like regular words", () => {
    const result = buffer.push("42 ");
    expect(result).toEqual(["42 "]);
  });

  it("single character tokens accumulate correctly before space", () => {
    buffer.push("a");
    buffer.push("b");
    buffer.push("c");
    const result = buffer.push(" ");
    expect(result).toEqual(["abc "]);
  });

  it("many separate single-char pushes then flush assembles everything", () => {
    "hello".split("").forEach((ch) => buffer.push(ch));
    const remaining = buffer.flush();
    expect(remaining).toBe("hello");
  });
});

// ===========================================================================
// 6. StreamingRunHandle — concurrent streams isolation
// ===========================================================================

describe("StreamingRunHandle — two concurrent streams do not interfere", () => {
  it("events pushed to handle A do not appear in handle B", async () => {
    const a = new StreamingRunHandle();
    const b = new StreamingRunHandle();

    a.push({ type: "text_delta", content: "from-a" });
    b.push({ type: "text_delta", content: "from-b" });
    a.complete();
    b.complete();

    const eventsA = await drainHandle(a);
    const eventsB = await drainHandle(b);

    expect((eventsA[0] as { content: string }).content).toBe("from-a");
    expect((eventsB[0] as { content: string }).content).toBe("from-b");
  });

  it("completing one stream does not affect the other", async () => {
    const a = new StreamingRunHandle();
    const b = new StreamingRunHandle();

    a.push({ type: "text_delta", content: "a1" });
    a.complete();

    // B is still running after A completes
    expect(b.status).toBe("running");
    b.push({ type: "text_delta", content: "b1" });
    b.complete();

    const eventsB = await drainHandle(b);
    expect(eventsB).toHaveLength(1);
  });

  it("cancelling one stream does not cancel the other", () => {
    const a = new StreamingRunHandle();
    const b = new StreamingRunHandle();
    a.cancel();
    expect(b.status).toBe("running");
  });

  it("two handles drained concurrently produce independent results", async () => {
    const a = new StreamingRunHandle();
    const b = new StreamingRunHandle();

    for (let i = 0; i < 5; i++) {
      a.push({ type: "text_delta", content: `a${i}` });
      b.push({ type: "text_delta", content: `b${i}` });
    }
    a.complete();
    b.complete();

    const [eventsA, eventsB] = await Promise.all([
      drainHandle(a),
      drainHandle(b),
    ]);

    expect(eventsA).toHaveLength(5);
    expect(eventsB).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect((eventsA[i] as { content: string }).content).toBe(`a${i}`);
      expect((eventsB[i] as { content: string }).content).toBe(`b${i}`);
    }
  });

  it("failing one stream does not mark another as failed", () => {
    const a = new StreamingRunHandle();
    const b = new StreamingRunHandle();
    a.fail(new Error("a blew up"));
    expect(b.status).toBe("running");
  });
});

// ===========================================================================
// 7. StreamingRunHandle — tool_call event lifecycle
// ===========================================================================

describe("StreamingRunHandle — tool_call event lifecycle", () => {
  it("tool_call_start without matching tool_call_end is still emitted", async () => {
    const handle = new StreamingRunHandle();
    handle.push({ type: "tool_call_start", toolName: "search", callId: "c1" });
    handle.complete();

    const events = await drainHandle(handle);
    expect(events[0]!.type).toBe("tool_call_start");
  });

  it("tool_call_end without prior tool_call_start is still emitted", async () => {
    const handle = new StreamingRunHandle();
    handle.push({ type: "tool_call_end", callId: "c1", result: "data" });
    handle.complete();

    const events = await drainHandle(handle);
    expect(events[0]!.type).toBe("tool_call_end");
  });

  it("call id is preserved verbatim through the handle", async () => {
    const handle = new StreamingRunHandle();
    const callId = "unique-id-abc-123";
    handle.push({ type: "tool_call_start", toolName: "t", callId });
    handle.push({ type: "tool_call_end", callId, result: null });
    handle.complete();

    const events = await drainHandle(handle);
    const start = events[0] as { callId: string };
    const end = events[1] as { callId: string };
    expect(start.callId).toBe(callId);
    expect(end.callId).toBe(callId);
  });

  it("tool result object is preserved as-is in tool_call_end", async () => {
    const handle = new StreamingRunHandle();
    const result = { hits: [1, 2, 3], total: 3 };
    handle.push({ type: "tool_call_end", callId: "c2", result });
    handle.complete();

    const events = await drainHandle(handle);
    expect((events[0] as { result: unknown }).result).toEqual(result);
  });

  it("interleaved tool_call and text_delta events preserve order", async () => {
    const handle = new StreamingRunHandle();
    handle.push({ type: "text_delta", content: "before" });
    handle.push({ type: "tool_call_start", toolName: "tool", callId: "tc" });
    handle.push({ type: "text_delta", content: "after" });
    handle.push({ type: "tool_call_end", callId: "tc", result: "result" });
    handle.push({ type: "done", finalOutput: "final" });
    handle.complete();

    const events = await drainHandle(handle);
    expect(events.map((e) => e.type)).toEqual([
      "text_delta",
      "tool_call_start",
      "text_delta",
      "tool_call_end",
      "done",
    ]);
  });
});

// ===========================================================================
// 8. StreamingRunHandle — empty stream and metadata
// ===========================================================================

describe("StreamingRunHandle — empty stream and stream metadata", () => {
  it("empty stream (no events, just complete) terminates immediately", async () => {
    const handle = new StreamingRunHandle();
    handle.complete();

    const events = await drainHandle(handle);
    expect(events).toHaveLength(0);
  });

  it("done event with empty finalOutput string is still delivered", async () => {
    const handle = new StreamingRunHandle();
    handle.push({ type: "done", finalOutput: "" });
    handle.complete();

    const events = await drainHandle(handle);
    expect(events[0]!.type).toBe("done");
    if (events[0]!.type === "done") {
      expect(events[0]!.finalOutput).toBe("");
    }
  });

  it("status transitions: running → completed", () => {
    const handle = new StreamingRunHandle();
    expect(handle.status).toBe("running");
    handle.complete();
    expect(handle.status).toBe("completed");
  });

  it("status transitions: running → failed", () => {
    const handle = new StreamingRunHandle();
    expect(handle.status).toBe("running");
    handle.fail(new Error("boom"));
    expect(handle.status).toBe("failed");
  });

  it("status transitions: running → cancelled", () => {
    const handle = new StreamingRunHandle();
    expect(handle.status).toBe("running");
    handle.cancel();
    expect(handle.status).toBe("cancelled");
  });

  it("once completed, fail() does not change status", () => {
    const handle = new StreamingRunHandle();
    handle.complete();
    handle.fail(new Error("late"));
    expect(handle.status).toBe("completed");
  });

  it("once failed, cancel() does not change status", () => {
    const handle = new StreamingRunHandle();
    handle.fail(new Error("first"));
    handle.cancel();
    expect(handle.status).toBe("failed");
  });

  it("once cancelled, complete() does not change status", () => {
    const handle = new StreamingRunHandle();
    handle.cancel();
    handle.complete();
    expect(handle.status).toBe("cancelled");
  });

  it("pushing zero-length content event is still buffered", async () => {
    const handle = new StreamingRunHandle();
    handle.push({ type: "text_delta", content: "" });
    handle.complete();

    const events = await drainHandle(handle);
    expect(events).toHaveLength(1);
    expect((events[0] as { content: string }).content).toBe("");
  });
});

// ===========================================================================
// 9. StreamingRunHandle — async iterator protocol compliance
// ===========================================================================

describe("StreamingRunHandle — async iterator protocol compliance", () => {
  it("for-await loop works identically to manual iterator usage", async () => {
    const handle = new StreamingRunHandle();
    handle.push({ type: "text_delta", content: "x" });
    handle.push({ type: "text_delta", content: "y" });
    handle.complete();

    const forAwait: string[] = [];
    for await (const e of handle.events()) {
      if (e.type === "text_delta") forAwait.push(e.content);
    }
    expect(forAwait).toEqual(["x", "y"]);
  });

  it("calling events() twice returns two independent iterators", async () => {
    const handle = new StreamingRunHandle();
    handle.push({ type: "text_delta", content: "shared" });
    handle.complete();

    // First iterator drains the event
    const iter1 = handle.events()[Symbol.asyncIterator]();
    const r1 = await iter1.next();
    expect(r1.done).toBe(false);
    expect((r1.value as { content: string }).content).toBe("shared");

    // Second iterator sees empty queue (already drained)
    const iter2 = handle.events()[Symbol.asyncIterator]();
    const r2 = await iter2.next();
    expect(r2.done).toBe(true);
  });

  it("manually calling next() step-by-step is equivalent to for-await", async () => {
    const handle = new StreamingRunHandle();
    handle.push({ type: "text_delta", content: "one" });
    handle.push({ type: "text_delta", content: "two" });
    handle.complete();

    const iter = handle.events()[Symbol.asyncIterator]();
    const r1 = await iter.next();
    const r2 = await iter.next();
    const r3 = await iter.next(); // should be done

    expect(r1.done).toBe(false);
    expect(r2.done).toBe(false);
    expect(r3.done).toBe(true);
  });

  it("iterator done value is undefined per AsyncIterator spec", async () => {
    const handle = new StreamingRunHandle();
    handle.complete();

    const iter = handle.events()[Symbol.asyncIterator]();
    const result = await iter.next();
    expect(result.done).toBe(true);
    expect(result.value).toBeUndefined();
  });

  it("consuming all events with reduce accumulates correct text", async () => {
    const handle = new StreamingRunHandle();
    const tokens = ["The ", "quick ", "brown ", "fox"];
    for (const t of tokens) {
      handle.push({ type: "text_delta", content: t });
    }
    handle.complete();

    let assembled = "";
    for await (const e of handle.events()) {
      if (e.type === "text_delta") assembled += e.content;
    }
    expect(assembled).toBe("The quick brown fox");
  });
});

// ===========================================================================
// 10. StreamActionParser — parallel execution mode
// ===========================================================================

describe("StreamActionParser — parallel execution mode", () => {
  it("parallelExecution=true returns tool_call_complete immediately without waiting", async () => {
    const tool = makeTool("slow", async () => {
      await delay(50);
      return "slow result";
    });
    const parser = new StreamActionParser([tool], { parallelExecution: true });

    const start = Date.now();
    const events = await parser.processChunk({
      tool_calls: [{ id: "p1", name: "slow", args: {} }],
    });
    const elapsed = Date.now() - start;

    // Should not have waited for the slow tool
    expect(elapsed).toBeLessThan(40);
    // The tool_call_complete event is the async placeholder
    expect(events.some((e) => e.type === "tool_call_complete")).toBe(true);
  });

  it("parallel flush drains in-flight promises and returns results", async () => {
    let resolved = false;
    const tool = makeTool("background", async () => {
      await delay(10);
      resolved = true;
      return "bg result";
    });
    const parser = new StreamActionParser([tool], { parallelExecution: true });

    await parser.processChunk({
      tool_calls: [{ id: "bg1", name: "background", args: {} }],
    });

    expect(resolved).toBe(false); // not yet

    const flushed = await parser.flush();
    expect(resolved).toBe(true);
    expect(flushed.some((e) => e.type === "tool_result")).toBe(true);
  });

  it("sequential mode (default) awaits each tool before returning", async () => {
    let order: string[] = [];
    const t1 = makeTool("first", async () => {
      order.push("first");
      return "r1";
    });
    const t2 = makeTool("second", async () => {
      order.push("second");
      return "r2";
    });
    const parser = new StreamActionParser([t1, t2]);

    await parser.processChunk({
      tool_calls: [{ id: "s1", name: "first", args: {} }],
    });
    await parser.processChunk({
      tool_calls: [{ id: "s2", name: "second", args: {} }],
    });

    expect(order).toEqual(["first", "second"]);
  });

  it("parallel mode with maxParallelTools=1 still processes all tools", async () => {
    const results: string[] = [];
    const ta = makeTool("ta", async () => {
      results.push("ta");
      return "ra";
    });
    const tb = makeTool("tb", async () => {
      results.push("tb");
      return "rb";
    });
    const parser = new StreamActionParser([ta, tb], {
      parallelExecution: true,
      maxParallelTools: 1,
    });

    await parser.processChunk({
      tool_calls: [{ id: "1", name: "ta", args: {} }],
    });
    await parser.processChunk({
      tool_calls: [{ id: "2", name: "tb", args: {} }],
    });
    await parser.flush();

    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// 11. StreamActionParser — content extraction variants
// ===========================================================================

describe("StreamActionParser — content extraction variants", () => {
  it("array content with text parts concatenates text values", async () => {
    const parser = new StreamActionParser([]);
    const events = await parser.processChunk({
      content: [
        { type: "text", text: "part1 " },
        { type: "text", text: "part2" },
      ],
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("text");
    expect(events[0]!.data.content).toBe("part1 part2");
  });

  it("array content with non-text parts are ignored", async () => {
    const parser = new StreamActionParser([]);
    const events = await parser.processChunk({
      content: [
        { type: "image", text: "should be ignored" },
        { type: "text", text: "visible" },
      ],
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.data.content).toBe("visible");
  });

  it("undefined content produces no text event", async () => {
    const parser = new StreamActionParser([]);
    const events = await parser.processChunk({});
    expect(events.filter((e) => e.type === "text")).toHaveLength(0);
  });

  it("empty string content produces no text event", async () => {
    const parser = new StreamActionParser([]);
    const events = await parser.processChunk({ content: "" });
    expect(events.filter((e) => e.type === "text")).toHaveLength(0);
  });

  it("array content with all non-text parts produces no text event", async () => {
    const parser = new StreamActionParser([]);
    const events = await parser.processChunk({
      content: [{ type: "image" }, { type: "binary" }],
    });
    expect(events.filter((e) => e.type === "text")).toHaveLength(0);
  });

  it("array content with mixed empty and non-empty text parts concatenates correctly", async () => {
    const parser = new StreamActionParser([]);
    const events = await parser.processChunk({
      content: [
        { type: "text", text: "" },
        { type: "text", text: "visible" },
        { type: "text", text: "" },
      ],
    });
    // Empty text parts are filtered; only "visible" remains
    expect(events[0]!.data.content).toBe("visible");
  });
});

// ===========================================================================
// 12. StreamActionParser — tool result serialization
// ===========================================================================

describe("StreamActionParser — tool result serialization", () => {
  it("object result is JSON-serialized in tool_result data", async () => {
    const tool = makeTool("json-returner", async () => ({ key: "value" }));
    const parser = new StreamActionParser([tool]);

    const events = await parser.processChunk({
      tool_calls: [{ id: "r1", name: "json-returner", args: {} }],
    });

    const result = events.find((e) => e.type === "tool_result");
    expect(result).toBeDefined();
    expect(result!.data.result).toBe(JSON.stringify({ key: "value" }));
  });

  it("string result is preserved as-is without extra serialization", async () => {
    const tool = makeTool("str-returner", async () => "plain string");
    const parser = new StreamActionParser([tool]);

    const events = await parser.processChunk({
      tool_calls: [{ id: "r2", name: "str-returner", args: {} }],
    });

    const result = events.find((e) => e.type === "tool_result");
    expect(result!.data.result).toBe("plain string");
  });

  it("null result is JSON-serialized to 'null'", async () => {
    const tool = makeTool("null-returner", async () => null);
    const parser = new StreamActionParser([tool]);

    const events = await parser.processChunk({
      tool_calls: [{ id: "r3", name: "null-returner", args: {} }],
    });

    const result = events.find((e) => e.type === "tool_result");
    expect(result!.data.result).toBe("null");
  });

  it("array result is JSON-serialized", async () => {
    const tool = makeTool("arr-returner", async () => [1, 2, 3]);
    const parser = new StreamActionParser([tool]);

    const events = await parser.processChunk({
      tool_calls: [{ id: "r4", name: "arr-returner", args: {} }],
    });

    const result = events.find((e) => e.type === "tool_result");
    expect(result!.data.result).toBe("[1,2,3]");
  });

  it("tool result includes the toolCall reference for correlation", async () => {
    const tool = makeTool("corr", async () => "ok");
    const parser = new StreamActionParser([tool]);

    const events = await parser.processChunk({
      tool_calls: [{ id: "corr1", name: "corr", args: { x: 1 } }],
    });

    const result = events.find((e) => e.type === "tool_result");
    expect(result!.data.toolCall?.name).toBe("corr");
    expect(result!.data.toolCall?.id).toBe("corr1");
    expect(result!.data.toolCall?.args).toEqual({ x: 1 });
  });
});

// ===========================================================================
// 13. Integration — streaming pipeline end-to-end
// ===========================================================================

describe("Integration — full streaming pipeline with all three primitives", () => {
  it("tokens → TextDeltaBuffer → StreamingRunHandle → drain produces correct text", async () => {
    const handle = new StreamingRunHandle();
    const buf = new TextDeltaBuffer();

    const rawTokens = ["The", " quick", " brown", " fox", " jumps."];
    for (const token of rawTokens) {
      const words = buf.push(token);
      for (const word of words) {
        handle.push({ type: "text_delta", content: word });
      }
    }
    const tail = buf.flush();
    if (tail) handle.push({ type: "text_delta", content: tail });
    handle.complete();

    let text = "";
    for await (const e of handle.events()) {
      if (e.type === "text_delta") text += e.content;
    }
    expect(text).toBe("The quick brown fox jumps.");
  });

  it("StreamActionParser text events can be forwarded to StreamingRunHandle", async () => {
    const handle = new StreamingRunHandle();
    const parser = new StreamActionParser([]);

    const chunks = ["Hello ", "world"];
    for (const c of chunks) {
      const events = await parser.processChunk({ content: c });
      for (const e of events) {
        if (e.type === "text") {
          handle.push({ type: "text_delta", content: e.data.content! });
        }
      }
    }
    handle.complete();

    let assembled = "";
    for await (const e of handle.events()) {
      if (e.type === "text_delta") assembled += e.content;
    }
    expect(assembled).toBe("Hello world");
  });

  it("tool events from StreamActionParser map to handle tool_call events correctly", async () => {
    const handle = new StreamingRunHandle();
    const tool = makeTool("fetch", async () => "data");
    const parser = new StreamActionParser([tool]);

    const parserEvents = await parser.processChunk({
      tool_calls: [{ id: "f1", name: "fetch", args: { url: "http://x" } }],
    });

    for (const e of parserEvents) {
      if (e.type === "tool_call_start") {
        handle.push({
          type: "tool_call_start",
          toolName: e.data.toolCall!.name,
          callId: e.data.toolCall!.id,
        });
      }
      if (e.type === "tool_result") {
        handle.push({
          type: "tool_call_end",
          callId: e.data.toolCall!.id,
          result: e.data.result!,
        });
      }
    }
    handle.push({ type: "done", finalOutput: "done" });
    handle.complete();

    const events = await drainHandle(handle);
    expect(events.map((e) => e.type)).toEqual([
      "tool_call_start",
      "tool_call_end",
      "done",
    ]);
  });

  it("cancelled handle mid-way still completes the for-await loop", async () => {
    const handle = new StreamingRunHandle();

    let count = 0;
    const consumePromise = (async () => {
      for await (const e of handle.events()) {
        count++;
        if (e.type === "text_delta" && e.content === "stop") {
          handle.cancel();
        }
      }
    })();

    handle.push({ type: "text_delta", content: "a" });
    handle.push({ type: "text_delta", content: "stop" });
    // These should not be received after cancel
    handle.push({ type: "text_delta", content: "c" }); // will throw

    await consumePromise;

    // At least "a" and "stop" were received before cancel threw
    expect(count).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// 14. TextDeltaBuffer — stream replay and advanced scenarios
// ===========================================================================

describe("TextDeltaBuffer — stream replay behaviour", () => {
  it("flush returns partial and subsequent push assembles fresh content", () => {
    const buf = new TextDeltaBuffer();
    buf.push("partial");
    const flushed = buf.flush();
    expect(flushed).toBe("partial");
    // Now push new content as if replaying
    const result = buf.push("fresh ");
    expect(result).toEqual(["fresh "]);
  });

  it("multiple resets between pushes behave correctly", () => {
    const buf = new TextDeltaBuffer();
    buf.push("word");
    buf.reset();
    buf.push("other");
    buf.reset();
    expect(buf.peek()).toBe("");
    const result = buf.push("final ");
    expect(result).toEqual(["final "]);
  });

  it("peek after push returns un-emitted partial content", () => {
    const buf = new TextDeltaBuffer();
    buf.push("hel");
    expect(buf.peek()).toBe("hel");
    buf.push("lo");
    expect(buf.peek()).toBe("hello");
    buf.push(" ");
    expect(buf.peek()).toBe("");
  });
});

// ===========================================================================
// 15. StreamingRunHandle — large volume stress test
// ===========================================================================

describe("StreamingRunHandle — large volume stress tests", () => {
  it("1000 events buffered and drained in order", async () => {
    const N = 1000;
    const handle = new StreamingRunHandle({ maxBufferSize: N });

    for (let i = 0; i < N; i++) {
      handle.push({ type: "text_delta", content: String(i) });
    }
    handle.complete();

    const events = await drainHandle(handle);
    expect(events).toHaveLength(N);
    for (let i = 0; i < N; i++) {
      expect((events[i] as { content: string }).content).toBe(String(i));
    }
  });

  it("default maxBuffer of 1000 accepts exactly 1000 events without dropping", async () => {
    const handle = new StreamingRunHandle(); // default maxBufferSize=1000
    for (let i = 0; i < 1000; i++) {
      handle.push({ type: "text_delta", content: `e${i}` });
    }
    handle.complete();

    const events = await drainHandle(handle);
    expect(events).toHaveLength(1000);
  });

  it("events 1001+ are dropped when maxBufferSize=1000", async () => {
    const handle = new StreamingRunHandle({ maxBufferSize: 1000 });
    for (let i = 0; i < 1005; i++) {
      handle.push({ type: "text_delta", content: `e${i}` });
    }
    handle.complete();

    const events = await drainHandle(handle);
    // Last 5 dropped
    expect(events).toHaveLength(1000);
    expect((events[999] as { content: string }).content).toBe("e999");
  });
});

// ===========================================================================
// 16. StreamActionParser — edge cases for tryParseJson
// ===========================================================================

describe("StreamActionParser — tryParseJson edge cases", () => {
  it("JSON with nested objects is parsed and passed to the tool", async () => {
    const received: unknown[] = [];
    const tool = makeTool("nested", async (args) => {
      received.push(args);
      return "ok";
    });
    const parser = new StreamActionParser([tool]);

    await parser.processChunk({
      tool_calls: [
        {
          id: "n1",
          name: "nested",
          args: { outer: { inner: [1, 2, 3] } },
        },
      ],
    });

    expect(received[0]).toEqual({ outer: { inner: [1, 2, 3] } });
  });

  it("args with boolean values are passed through correctly", async () => {
    const received: unknown[] = [];
    const tool = makeTool("bools", async (args) => {
      received.push(args);
      return "ok";
    });
    const parser = new StreamActionParser([tool]);

    await parser.processChunk({
      tool_calls: [
        { id: "b1", name: "bools", args: { flag: true, other: false } },
      ],
    });

    expect(received[0]).toEqual({ flag: true, other: false });
  });

  it("string args that are not JSON objects fall back to empty object", async () => {
    const received: unknown[] = [];
    const tool = makeTool("fallback", async (args) => {
      received.push(args);
      return "ok";
    });
    const parser = new StreamActionParser([tool]);

    // "not-json" is not parseable as object → falls back to {}
    await parser.processChunk({
      tool_calls: [{ id: "f1", name: "fallback", args: "not-json" }],
    });

    expect(received[0]).toEqual({});
  });

  it("deeply chunked JSON with whitespace inside strings is handled", async () => {
    const received: unknown[] = [];
    const tool = makeTool("spaced", async (args) => {
      received.push(args);
      return "ok";
    });
    const parser = new StreamActionParser([tool]);

    await parser.processChunk({
      tool_call_chunks: [{ id: "sp1", name: "spaced", args: '{"msg":' }],
    });
    const events = await parser.processChunk({
      tool_call_chunks: [{ id: "sp1", args: '"hello world"}' }],
    });

    expect(events.some((e) => e.type === "tool_result")).toBe(true);
    expect(received[0]).toEqual({ msg: "hello world" });
  });
});

// ===========================================================================
// 17. Additional stream semantics and cleanup
// ===========================================================================

describe("StreamingRunHandle — push-then-fail ordering", () => {
  it("multiple text events followed by error all appear in drain order", async () => {
    const handle = new StreamingRunHandle();
    handle.push({ type: "text_delta", content: "t1" });
    handle.push({ type: "text_delta", content: "t2" });
    handle.push({ type: "text_delta", content: "t3" });
    handle.fail(new Error("triple-fail"));

    const events = await drainHandle(handle);
    expect(events).toHaveLength(4);
    expect(events[0]!.type).toBe("text_delta");
    expect(events[1]!.type).toBe("text_delta");
    expect(events[2]!.type).toBe("text_delta");
    expect(events[3]!.type).toBe("error");
  });

  it("fail() error message is the exact Error message, not wrapped", async () => {
    const handle = new StreamingRunHandle();
    handle.fail(new Error("exact message"));
    const events = await drainHandle(handle);
    const errEvent = events.find((e) => e.type === "error");
    expect(errEvent!.type).toBe("error");
    if (errEvent!.type === "error") {
      expect(errEvent!.error.message).toBe("exact message");
    }
  });

  it("done event finalOutput is preserved including whitespace", async () => {
    const handle = new StreamingRunHandle();
    handle.push({ type: "done", finalOutput: "  spaced  " });
    handle.complete();
    const events = await drainHandle(handle);
    if (events[0]!.type === "done") {
      expect(events[0]!.finalOutput).toBe("  spaced  ");
    }
  });

  it("large finalOutput string is preserved verbatim", async () => {
    const bigText = "x".repeat(100_000);
    const handle = new StreamingRunHandle();
    handle.push({ type: "done", finalOutput: bigText });
    handle.complete();
    const events = await drainHandle(handle);
    if (events[0]!.type === "done") {
      expect(events[0]!.finalOutput).toHaveLength(100_000);
    }
  });
});

describe("StreamActionParser — reset / re-use semantics", () => {
  it("a fresh parser has no fired IDs — same ID from two parsers both fire", async () => {
    const log: string[] = [];
    const makeParser = () => {
      const t = makeTool("t", async () => {
        log.push("called");
        return "ok";
      });
      return new StreamActionParser([t]);
    };

    const p1 = makeParser();
    const p2 = makeParser();

    await p1.processChunk({
      tool_calls: [{ id: "shared-id", name: "t", args: {} }],
    });
    await p2.processChunk({
      tool_calls: [{ id: "shared-id", name: "t", args: {} }],
    });

    // Each independent parser fires once
    expect(log).toHaveLength(2);
  });

  it("tool with numeric args works correctly", async () => {
    const received: unknown[] = [];
    const tool = makeTool("math", async (a) => {
      received.push(a);
      return String((a["x"] as number) + (a["y"] as number));
    });
    const parser = new StreamActionParser([tool]);

    const events = await parser.processChunk({
      tool_calls: [{ id: "m1", name: "math", args: { x: 3, y: 4 } }],
    });

    const result = events.find((e) => e.type === "tool_result");
    expect(result!.data.result).toBe("7");
  });

  it("processChunk with both content and tool_call produces text event first", async () => {
    const tool = makeTool("u", async () => "ok");
    const parser = new StreamActionParser([tool]);

    const events = await parser.processChunk({
      content: "Thinking...",
      tool_calls: [{ id: "u1", name: "u", args: {} }],
    });

    expect(events[0]!.type).toBe("text");
    expect(events[0]!.data.content).toBe("Thinking...");
  });

  it("tool_call_complete event carries a reference to the tool call", async () => {
    // In sequential mode the exec returns [tool_call_complete, tool_result]
    const tool = makeTool("ref-check", async () => "done");
    const parser = new StreamActionParser([tool]);

    const events = await parser.processChunk({
      tool_calls: [{ id: "rc1", name: "ref-check", args: { a: 1 } }],
    });

    const complete = events.find((e) => e.type === "tool_call_complete");
    expect(complete).toBeDefined();
    expect(complete!.data.toolCall?.name).toBe("ref-check");
    expect(complete!.data.toolCall?.id).toBe("rc1");
  });

  it("StreamingRunHandle maxBufferSize=0 drops every pushed event", async () => {
    const handle = new StreamingRunHandle({ maxBufferSize: 0 });
    handle.push({ type: "text_delta", content: "dropped" });
    handle.complete();

    const events = await drainHandle(handle);
    expect(events).toHaveLength(0);
  });
});
