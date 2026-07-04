import { describe, it, expect, vi } from "vitest";
import {
  HumanMessage,
  AIMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { autoCompress } from "../auto-compress.js";
import type { OffloadSink } from "../context-eviction.js";

function createMockModel(response: string): BaseChatModel {
  return {
    invoke: vi.fn().mockResolvedValue(new AIMessage(response)),
  } as unknown as BaseChatModel;
}

function makeConversation(pairs: number): BaseMessage[] {
  const msgs: BaseMessage[] = [];
  for (let i = 0; i < pairs; i++) {
    msgs.push(new HumanMessage(`Question ${i}`));
    msgs.push(new AIMessage(`Answer ${i}`));
  }
  return msgs;
}

function memorySink(): OffloadSink & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async write(path, content) {
      files.set(path, content);
    },
    async append(path, content) {
      files.set(path, (files.get(path) ?? "") + content);
    },
  };
}

describe("autoCompress offload", () => {
  it("appends destroyed messages to the sink and names the path in the summary", async () => {
    const model = createMockModel("## Goal\nSummarized content");
    const msgs = makeConversation(16); // 32 messages > default 30
    const sink = memorySink();

    const result = await autoCompress(msgs, null, model, {
      offload: { sink },
    });

    expect(result.compressed).toBe(true);
    const [path, content] = [...sink.files.entries()][0]!;
    expect(path).toBe(".dzup/history/conversation.log");
    expect(content).toContain("Question 0");
    expect(
      result.messages.some(
        (m) => typeof m.content === "string" && m.content.includes("Question 0")
      )
    ).toBe(false);
    expect(result.summary).toContain(path);
    expect(result.summary).toContain("read_file");
  });

  it("is best-effort: a throwing sink degrades to legacy (no-offload) behavior", async () => {
    const model = createMockModel("## Goal\nSummarized content");
    const msgs = makeConversation(16);
    const throwingSink: OffloadSink = {
      write: async () => {
        throw new Error("disk full");
      },
      append: async () => {
        throw new Error("disk full");
      },
    };

    const withOffload = await autoCompress(
      msgs,
      null,
      createMockModel("## Goal\nSummarized content"),
      {
        offload: { sink: throwingSink },
      }
    );
    const legacy = await autoCompress(msgs, null, model);

    expect(withOffload.messages).toEqual(legacy.messages);
    expect(withOffload.summary).toBe(legacy.summary);
  });

  it("still invokes a user-supplied onBeforeSummarize alongside offload", async () => {
    const model = createMockModel("## Goal\nSummarized content");
    const msgs = makeConversation(16);
    const sink = memorySink();
    const onBeforeSummarize = vi.fn();

    await autoCompress(msgs, null, model, {
      offload: { sink },
      onBeforeSummarize,
    });

    expect(onBeforeSummarize).toHaveBeenCalledTimes(1);
    expect(sink.files.size).toBe(1);
  });

  it("respects a custom offload path", async () => {
    const model = createMockModel("## Goal\nSummarized content");
    const msgs = makeConversation(16);
    const sink = memorySink();

    const result = await autoCompress(msgs, null, model, {
      offload: { sink, path: ".dzup/history/custom.log" },
    });

    expect(sink.files.has(".dzup/history/custom.log")).toBe(true);
    expect(result.summary).toContain(".dzup/history/custom.log");
  });
});
