import { describe, it, expect } from "vitest";
import { HumanMessage, type AIMessageChunk } from "@langchain/core/messages";
import { MockChatModel } from "../mock-model.js";

describe("MockChatModel", () => {
  it("returns responses in order", async () => {
    const model = new MockChatModel(["first", "second", "third"]);

    const r1 = await model.invoke([new HumanMessage("hello")]);
    expect(r1.content).toBe("first");

    const r2 = await model.invoke([new HumanMessage("world")]);
    expect(r2.content).toBe("second");
  });

  it("cycles back to first response after exhausting all", async () => {
    const model = new MockChatModel(["a", "b"]);

    await model.invoke([new HumanMessage("1")]);
    await model.invoke([new HumanMessage("2")]);
    const r3 = await model.invoke([new HumanMessage("3")]);
    expect(r3.content).toBe("a"); // cycles
  });

  it("tracks call count", async () => {
    const model = new MockChatModel(["resp"]);
    expect(model.callCount).toBe(0);

    await model.invoke([new HumanMessage("x")]);
    expect(model.callCount).toBe(1);

    await model.invoke([new HumanMessage("y")]);
    expect(model.callCount).toBe(2);
  });

  it("records call log with messages", async () => {
    const model = new MockChatModel(["resp"]);
    await model.invoke([new HumanMessage("test message")]);

    expect(model.callLog).toHaveLength(1);
    expect(model.callLog[0]!.messages[0]!.content).toBe("test message");
  });

  it("reset() clears call state", async () => {
    const model = new MockChatModel(["a", "b"]);
    await model.invoke([new HumanMessage("x")]);
    await model.invoke([new HumanMessage("y")]);
    expect(model.callCount).toBe(2);

    model.reset();
    expect(model.callCount).toBe(0);
    expect(model.callLog).toHaveLength(0);

    const r = await model.invoke([new HumanMessage("z")]);
    expect(r.content).toBe("a"); // back to first
  });

  it("accepts MockResponse objects with tool_calls", async () => {
    const model = new MockChatModel([
      {
        content: "I will use the tool",
        tool_calls: [{ id: "tc1", name: "read_file", args: { path: "a.ts" } }],
      },
    ]);

    const result = await model.invoke([new HumanMessage("read the file")]);
    expect(result.content).toBe("I will use the tool");
  });

  it("handles empty response array gracefully", async () => {
    const model = new MockChatModel([]);
    const r = await model.invoke([new HumanMessage("hello")]);
    expect(r.content).toBe("");
  });

  it("returns correct _llmType", () => {
    const model = new MockChatModel(["x"]);
    expect(model._llmType()).toBe("mock");
  });
});

/**
 * C-03 — a mock that yields ONE chunk lets a consumer that overwrites
 * (instead of concatenating) deltas pass every streaming test. These
 * cover the multi-delta script that makes such a bug observable.
 */
describe("MockChatModel.stream()", () => {
  it("yields one delta per stream_chunks entry", async () => {
    const model = new MockChatModel([
      {
        content: "",
        stream_chunks: [
          { content: "Hel" },
          { content: "lo " },
          { content: "world" },
        ],
      },
    ]);

    const chunks = [];
    for await (const chunk of await model.stream([new HumanMessage("hi")])) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.content).join("")).toBe("Hello world");
  });

  it("splits tool-call args across deltas and assembles them via concat", async () => {
    const model = new MockChatModel([
      {
        content: "",
        stream_chunks: [
          {
            content: "work",
            usage_metadata: {
              input_tokens: 42,
              output_tokens: 8,
              total_tokens: 50,
            },
            tool_call_chunks: [
              { id: "tc1", name: "read_file", args: '{"pa', index: 0 },
            ],
          },
          { tool_call_chunks: [{ id: "tc1", args: 'th":"a', index: 0 }] },
          { tool_call_chunks: [{ id: "tc1", args: '.ts"}', index: 0 }] },
          // Terminal delta carries NO tool-call data and NO usage.
          { content: "ing" },
        ],
      },
    ]);

    let assembled: AIMessageChunk | null = null;
    for await (const chunk of await model.stream([
      new HumanMessage("read a.ts"),
    ])) {
      assembled = assembled === null ? chunk : assembled.concat(chunk);
    }

    expect(assembled).not.toBeNull();
    expect(assembled!.content).toBe("working");
    expect(assembled!.tool_calls).toHaveLength(1);
    expect(assembled!.tool_calls![0]!.name).toBe("read_file");
    expect(assembled!.tool_calls![0]!.args).toEqual({ path: "a.ts" });
    // Usage arrived on a non-terminal delta and must survive assembly.
    expect(assembled!.usage_metadata?.input_tokens).toBe(42);
    expect(assembled!.usage_metadata?.output_tokens).toBe(8);
  });

  it("synthesises a single delta when no stream_chunks are declared", async () => {
    const model = new MockChatModel([
      {
        content: "plain",
        tool_calls: [{ id: "tc1", name: "read_file", args: { path: "a.ts" } }],
      },
    ]);

    const chunks = [];
    for await (const chunk of await model.stream([new HumanMessage("go")])) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toBe("plain");
    expect(chunks[0]!.tool_calls?.[0]?.args).toEqual({ path: "a.ts" });
  });

  it("advances the response cursor and call log like invoke()", async () => {
    const model = new MockChatModel(["first", "second"]);

    for await (const _ of await model.stream([new HumanMessage("a")])) {
      /* drain */
    }
    expect(model.callCount).toBe(1);

    const second = await model.invoke([new HumanMessage("b")]);
    expect(second.content).toBe("second");
  });
});
