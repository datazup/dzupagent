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

describe("autoCompress offload — sink failure", () => {
  it("reports the offload failure instead of returning a clean compaction", async () => {
    const model = createMockModel("## Goal\nSummarized content");
    const msgs = makeConversation(16);
    const failing: OffloadSink = {
      async write() {
        throw new Error("disk full");
      },
      async append() {
        throw new Error("disk full");
      },
    };

    const result = await autoCompress(msgs, null, model, {
      offload: { sink: failing },
    });

    // The messages are destroyed either way. Previously the only effect of a
    // sink failure was dropping the recovery pointer from the summary, so the
    // caller saw compressed:true with no fallbackReason -- permanent
    // transcript loss reported as an ordinary successful compaction.
    expect(result.compressed).toBe(true);
    expect(result.fallbackReason).toContain("offload-failed");
    expect(result.fallbackReason).toContain("disk full");
    // And it must still not name a path that was never written.
    expect(result.summary ?? "").not.toContain("conversation.log");
  });

  it("leaves fallbackReason unset when the sink succeeds", async () => {
    const model = createMockModel("## Goal\nSummarized content");
    const result = await autoCompress(makeConversation(16), null, model, {
      offload: { sink: memorySink() },
    });

    expect(result.compressed).toBe(true);
    expect(result.fallbackReason).toBeUndefined();
  });

  it("reports both truncation and the offload failure when the budget also bites", async () => {
    const model = createMockModel("## Goal\nSummarized content");
    const failing: OffloadSink = {
      async write() {
        throw new Error("disk full");
      },
      async append() {
        throw new Error("disk full");
      },
    };

    const result = await autoCompress(makeConversation(16), null, model, {
      offload: { sink: failing },
      budget: 5,
    });

    // The truncation path returns early; it must not overwrite the offload
    // failure with its own reason, or the transcript loss goes unreported.
    expect(result.fallbackReason).toContain("truncation");
    expect(result.fallbackReason).toContain("offload-failed");
  });
});
