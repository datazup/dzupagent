/**
 * M-12 — per-tool-call audit record tests for AdapterStreamRunner.
 *
 * Covers:
 *   - Two sequential tool calls → two ToolCallAuditRecord entries emitted
 *     with correct toolName, resultStatus:'success', durationMs >= 0.
 *   - A tool call that never receives a result (stream error) → emitted with
 *     resultStatus:'error'.
 *   - toolCallAuditSink not set → no records emitted (no crash).
 *   - Sink errors are swallowed and do not break the stream.
 */

import { describe, it, expect, vi } from "vitest";
import { AdapterStreamRunner } from "../base/stream-runner.js";
import type {
  AdapterStreamSource,
  StreamContext,
} from "../base/stream-runner.js";
import type { AgentEvent, AgentInput } from "../types.js";
import type { ToolCallAuditRecord } from "@dzupagent/core/events";

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function makeInput(overrides: Partial<AgentInput> = {}): AgentInput {
  return {
    prompt: "test prompt",
    systemPrompt: "system",
    correlationId: "corr-1",
    ...overrides,
  };
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const results: AgentEvent[] = [];
  for await (const ev of gen) results.push(ev);
  return results;
}

/** Build a minimal source that replays a fixed list of pre-built AgentEvents. */
function makeEventSource(
  events: AgentEvent[]
): AdapterStreamSource<AgentEvent> {
  return {
    providerId: "claude",
    async *open() {
      for (const ev of events) yield ev;
    },
    mapRawEvent(raw: AgentEvent, _ctx: StreamContext): AgentEvent {
      return raw;
    },
  };
}

/** Convenience: build an adapter:tool_call event. */
function toolCall(
  toolName: string,
  toolCallId: string,
  input: unknown = { arg: "x" }
): AgentEvent {
  return {
    type: "adapter:tool_call",
    providerId: "claude",
    toolName,
    toolCallId,
    input,
    timestamp: Date.now(),
  };
}

/** Convenience: build an adapter:tool_result event. */
function toolResult(
  toolName: string,
  toolCallId: string,
  output = "ok"
): AgentEvent {
  return {
    type: "adapter:tool_result",
    providerId: "claude",
    toolName,
    toolCallId,
    output,
    durationMs: 5,
    timestamp: Date.now(),
  };
}

/** Convenience: terminal completed event. */
function completed(): AgentEvent {
  return {
    type: "adapter:completed",
    providerId: "claude",
    sessionId: "sess-1",
    result: "done",
    durationMs: 100,
    timestamp: Date.now(),
  };
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe("AdapterStreamRunner — tool-call audit (M-12)", () => {
  it("emits two ToolCallAuditRecords for two sequential tool calls", async () => {
    const sink = vi.fn<[ToolCallAuditRecord], void>();
    const runner = new AdapterStreamRunner({ toolCallAuditSink: sink });

    const source = makeEventSource([
      toolCall("read_file", "tc-1"),
      toolResult("read_file", "tc-1", "contents"),
      toolCall("write_file", "tc-2"),
      toolResult("write_file", "tc-2", "written"),
      completed(),
    ]);

    await collect(runner.run(source, makeInput()));

    expect(sink).toHaveBeenCalledTimes(2);

    const [first, second] = sink.mock.calls.map((c) => c[0]);

    expect(first).toMatchObject({
      type: "tool_call",
      toolName: "read_file",
      resultStatus: "success",
    });
    expect(first?.durationMs).toBeGreaterThanOrEqual(0);

    expect(second).toMatchObject({
      type: "tool_call",
      toolName: "write_file",
      resultStatus: "success",
    });
    expect(second?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("emits resultStatus:error for a tool call whose stream throws before result", async () => {
    const sink = vi.fn<[ToolCallAuditRecord], void>();
    const runner = new AdapterStreamRunner({ toolCallAuditSink: sink });

    // Source emits a tool_call then throws — no tool_result is ever emitted
    const source: AdapterStreamSource<AgentEvent> = {
      providerId: "claude",
      async *open() {
        yield toolCall("exploding_tool", "tc-err");
        throw new Error("SDK crash");
      },
      mapRawEvent(raw: AgentEvent): AgentEvent {
        return raw;
      },
    };

    const events = await collect(runner.run(source, makeInput()));

    // The runner should have swallowed the error and yielded adapter:failed
    expect(events.some((e) => e.type === "adapter:failed")).toBe(true);

    // The pending tool call is flushed as an error record
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]?.[0]).toMatchObject({
      type: "tool_call",
      toolName: "exploding_tool",
      resultStatus: "error",
    });
    expect(sink.mock.calls[0]?.[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("does not emit any records when toolCallAuditSink is not configured", async () => {
    // No toolCallAuditSink → should not crash, no records
    const runner = new AdapterStreamRunner();

    const source = makeEventSource([
      toolCall("git_status", "tc-1"),
      toolResult("git_status", "tc-1"),
      completed(),
    ]);

    // Should complete without throwing
    await expect(
      collect(runner.run(source, makeInput()))
    ).resolves.toHaveLength(3);
  });

  it("swallows a sink error and does not break the stream", async () => {
    const throwingSink = vi.fn(() => {
      throw new Error("sink crashed");
    });
    const runner = new AdapterStreamRunner({
      toolCallAuditSink: throwingSink as unknown as (
        r: ToolCallAuditRecord
      ) => void,
    });

    const source = makeEventSource([
      toolCall("risky_tool", "tc-1"),
      toolResult("risky_tool", "tc-1"),
      completed(),
    ]);

    // Stream should still complete normally despite sink throwing
    const events = await collect(runner.run(source, makeInput()));
    expect(events.some((e) => e.type === "adapter:completed")).toBe(true);
    expect(throwingSink).toHaveBeenCalledTimes(1);
  });

  it("populates argsHash and toolCallId on the audit record", async () => {
    const sink = vi.fn<[ToolCallAuditRecord], void>();
    const runner = new AdapterStreamRunner({ toolCallAuditSink: sink });

    const source = makeEventSource([
      toolCall("search", "tc-abc", { query: "hello world" }),
      toolResult("search", "tc-abc", "result"),
      completed(),
    ]);

    await collect(runner.run(source, makeInput()));

    expect(sink).toHaveBeenCalledTimes(1);
    const record = sink.mock.calls[0]?.[0];
    expect(record?.toolCallId).toBe("tc-abc");
    expect(typeof record?.argsHash).toBe("string");
    expect(record?.argsHash.length).toBeGreaterThan(0);
    expect(typeof record?.startedAt).toBe("string");
  });

  it("argsHash reflects tool INPUT args, not the tool output (M-12)", async () => {
    const sink = vi.fn<[ToolCallAuditRecord], void>();
    const runner = new AdapterStreamRunner({ toolCallAuditSink: sink });

    // Use clearly distinct input and output so we can assert which one was hashed.
    const inputArgs = { file: "/src/index.ts", line: 42 };
    const outputText = "COMPLETELY_DIFFERENT_OUTPUT_VALUE";

    const source = makeEventSource([
      toolCall("read_file", "tc-input", inputArgs),
      toolResult("read_file", "tc-input", outputText),
      completed(),
    ]);

    await collect(runner.run(source, makeInput()));

    expect(sink).toHaveBeenCalledTimes(1);
    const record = sink.mock.calls[0]?.[0];

    // argsHash must contain a representation of the input args
    expect(record?.argsHash).toContain("/src/index.ts");
    // argsHash must NOT contain the tool output
    expect(record?.argsHash).not.toContain(outputText);
  });
});
