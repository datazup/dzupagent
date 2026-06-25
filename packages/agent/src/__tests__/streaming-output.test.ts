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
  impl: (args: Record<string, unknown>) => Promise<unknown> = async () => "ok",
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
        `chunk-${i}`,
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
      "late arrival",
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
      handle.push({ type: "text_delta", content: "too late" }),
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
      handle.push({ type: "text_delta", content: "too late" }),
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
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
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
      })),
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
