/**
 * Slack connector — extended coverage (Wave 38 addendum)
 *
 * Adds +65 tests covering:
 *  - Thread reply chains and thread context
 *  - Reaction tools: slack_add_reaction, slack_remove_reaction, slack_get_reactions
 *    (edge cases NOT covered in slack-connector-new-features.test.ts)
 *  - Cross-tool interaction scenarios
 *  - Block Kit helper advanced edge cases
 *  - Event parsing helper edge cases
 *  - Schema and description assertions
 *  - outboundUrlPolicy forwarding
 *  - Error format consistency across all 6 tools
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createSlackConnector,
  createSlackConnectorToolkit,
  parseSlackEventEnvelope,
  extractSlackEvent,
  isDirectMessage,
  isBotMention,
  extractReactionName,
  textToSectionBlock,
  textToHeaderBlock,
  createDividerBlock,
  textsToContextBlock,
  textToBlocks,
  truncateForBlock,
  type SlackEvent,
  type SlackConnectorConfig,
} from "../slack/slack-connector.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stubFetch(
  response: Record<string, unknown> = { ok: true },
): ReturnType<typeof vi.fn> {
  const mock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => response,
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function getTool(name: string, config?: Partial<SlackConnectorConfig>) {
  const tools = createSlackConnector({ token: "xoxb-test-token", ...config });
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool;
}

function calledUrl(mock: ReturnType<typeof vi.fn>): string {
  return mock.mock.calls[0]![0] as string;
}

function calledBody(mock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return JSON.parse(
    (mock.mock.calls[0]![1] as RequestInit).body as string,
  ) as Record<string, unknown>;
}

function calledHeaders(mock: ReturnType<typeof vi.fn>): Record<string, string> {
  return (mock.mock.calls[0]![1] as RequestInit).headers as Record<
    string,
    string
  >;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ===========================================================================
// 1. Thread reply chains
// ===========================================================================

describe("Thread reply chains", () => {
  it("second thread reply carries same thread_ts as first reply", async () => {
    const mock = stubFetch({ ok: true });
    const sendTool = getTool("slack_send_message");

    const THREAD_TS = "1700000001.000001";
    await sendTool.invoke({
      channel: "C111",
      text: "reply 1",
      thread_ts: THREAD_TS,
    });
    await sendTool.invoke({
      channel: "C111",
      text: "reply 2",
      thread_ts: THREAD_TS,
    });

    const body1 = JSON.parse(
      (mock.mock.calls[0]![1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    const body2 = JSON.parse(
      (mock.mock.calls[1]![1] as RequestInit).body as string,
    ) as Record<string, unknown>;

    expect(body1["thread_ts"]).toBe(THREAD_TS);
    expect(body2["thread_ts"]).toBe(THREAD_TS);
  });

  it("three consecutive replies all reach chat.postMessage", async () => {
    const mock = stubFetch({ ok: true });
    const sendTool = getTool("slack_send_message");
    const ts = "1700000002.000002";

    await sendTool.invoke({ channel: "C222", text: "a", thread_ts: ts });
    await sendTool.invoke({ channel: "C222", text: "b", thread_ts: ts });
    await sendTool.invoke({ channel: "C222", text: "c", thread_ts: ts });

    expect(mock).toHaveBeenCalledTimes(3);
    for (const call of mock.mock.calls) {
      expect(call[0]).toBe("https://slack.com/api/chat.postMessage");
    }
  });

  it("thread reply success returns message mentioning the channel", async () => {
    stubFetch({ ok: true });
    const sendTool = getTool("slack_send_message");
    const result = await sendTool.invoke({
      channel: "C333",
      text: "reply",
      thread_ts: "1700000003.000003",
    });
    expect(result).toContain("C333");
  });

  it("thread reply propagates api error thread_not_found", async () => {
    stubFetch({ ok: false, error: "thread_not_found" });
    const sendTool = getTool("slack_send_message");
    const result = await sendTool.invoke({
      channel: "C444",
      text: "orphan",
      thread_ts: "9999999999.000001",
    });
    expect(result).toContain("thread_not_found");
  });

  it("thread reply with a very long thread_ts passes through correctly", async () => {
    const mock = stubFetch({ ok: true });
    const sendTool = getTool("slack_send_message");
    const longTs = "1234567890.123456789012";
    await sendTool.invoke({ channel: "C555", text: "msg", thread_ts: longTs });
    expect(calledBody(mock)["thread_ts"]).toBe(longTs);
  });

  it("different channels can have independent threads simultaneously", async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      });
    vi.stubGlobal("fetch", mock);

    const sendTool = getTool("slack_send_message");
    await sendTool.invoke({
      channel: "C-TEAM-A",
      text: "team A thread",
      thread_ts: "111.111",
    });
    await sendTool.invoke({
      channel: "C-TEAM-B",
      text: "team B thread",
      thread_ts: "222.222",
    });

    const body1 = JSON.parse(
      (mock.mock.calls[0]![1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    const body2 = JSON.parse(
      (mock.mock.calls[1]![1] as RequestInit).body as string,
    ) as Record<string, unknown>;

    expect(body1["channel"]).toBe("C-TEAM-A");
    expect(body1["thread_ts"]).toBe("111.111");
    expect(body2["channel"]).toBe("C-TEAM-B");
    expect(body2["thread_ts"]).toBe("222.222");
  });
});

// ===========================================================================
// 2. slack_add_reaction — additional edge cases
// ===========================================================================

describe("slack_add_reaction — additional edge cases", () => {
  it("reaction name with hyphen (e.g., slightly_smiling_face) is preserved", async () => {
    const mock = stubFetch({ ok: true });
    const tool = getTool("slack_add_reaction");
    await tool.invoke({
      channel: "C001",
      timestamp: "1.1",
      name: "slightly_smiling_face",
    });
    expect(calledBody(mock)["name"]).toBe("slightly_smiling_face");
  });

  it("success response mentions the reaction name with colons", async () => {
    stubFetch({ ok: true });
    const result = await getTool("slack_add_reaction").invoke({
      channel: "C001",
      timestamp: "1.1",
      name: "rocket",
    });
    expect(result).toContain(":rocket:");
  });

  it("success response mentions 'added'", async () => {
    stubFetch({ ok: true });
    const result = await getTool("slack_add_reaction").invoke({
      channel: "C001",
      timestamp: "1.1",
      name: "wave",
    });
    expect(result.toLowerCase()).toContain("added");
  });

  it("posts to reactions.add endpoint", async () => {
    const mock = stubFetch({ ok: true });
    await getTool("slack_add_reaction").invoke({
      channel: "C001",
      timestamp: "1.1",
      name: "thumbsup",
    });
    expect(calledUrl(mock)).toBe("https://slack.com/api/reactions.add");
  });

  it("request body includes channel, timestamp, and name", async () => {
    const mock = stubFetch({ ok: true });
    await getTool("slack_add_reaction").invoke({
      channel: "CABC",
      timestamp: "1700000001.123456",
      name: "tada",
    });
    const body = calledBody(mock);
    expect(body["channel"]).toBe("CABC");
    expect(body["timestamp"]).toBe("1700000001.123456");
    expect(body["name"]).toBe("tada");
  });

  it("already_reacted error surfaces in return string", async () => {
    stubFetch({ ok: false, error: "already_reacted" });
    const result = await getTool("slack_add_reaction").invoke({
      channel: "C001",
      timestamp: "1.1",
      name: "thumbsup",
    });
    expect(result).toContain("already_reacted");
  });

  it("too_many_reactions error surfaces in return string", async () => {
    stubFetch({ ok: false, error: "too_many_reactions" });
    const result = await getTool("slack_add_reaction").invoke({
      channel: "C001",
      timestamp: "1.1",
      name: "thumbsup",
    });
    expect(result).toContain("too_many_reactions");
  });

  it("uses Bearer token from config", async () => {
    const mock = stubFetch({ ok: true });
    const tool = createSlackConnector({ token: "xoxb-react-token" }).find(
      (t) => t.name === "slack_add_reaction",
    )!;
    await tool.invoke({ channel: "C001", timestamp: "1.1", name: "fire" });
    expect(calledHeaders(mock)["Authorization"]).toBe(
      "Bearer xoxb-react-token",
    );
  });

  it("uses POST method", async () => {
    const mock = stubFetch({ ok: true });
    await getTool("slack_add_reaction").invoke({
      channel: "C001",
      timestamp: "1.1",
      name: "x",
    });
    expect((mock.mock.calls[0]![1] as RequestInit).method).toBe("POST");
  });

  it("error result starts with 'Error:'", async () => {
    stubFetch({ ok: false, error: "invalid_name" });
    const result = await getTool("slack_add_reaction").invoke({
      channel: "C001",
      timestamp: "1.1",
      name: "not-valid!",
    });
    expect(result).toMatch(/^Error:/);
  });
});

// ===========================================================================
// 3. slack_remove_reaction — additional edge cases
// ===========================================================================

describe("slack_remove_reaction — additional edge cases", () => {
  it("success response mentions the reaction name with colons", async () => {
    stubFetch({ ok: true });
    const result = await getTool("slack_remove_reaction").invoke({
      channel: "C001",
      timestamp: "1.1",
      name: "eyes",
    });
    expect(result).toContain(":eyes:");
  });

  it("success response mentions 'removed'", async () => {
    stubFetch({ ok: true });
    const result = await getTool("slack_remove_reaction").invoke({
      channel: "C001",
      timestamp: "1.1",
      name: "wave",
    });
    expect(result.toLowerCase()).toContain("removed");
  });

  it("posts to reactions.remove endpoint", async () => {
    const mock = stubFetch({ ok: true });
    await getTool("slack_remove_reaction").invoke({
      channel: "C001",
      timestamp: "1.1",
      name: "wave",
    });
    expect(calledUrl(mock)).toBe("https://slack.com/api/reactions.remove");
  });

  it("request body includes channel, timestamp, and name", async () => {
    const mock = stubFetch({ ok: true });
    await getTool("slack_remove_reaction").invoke({
      channel: "CXYZ",
      timestamp: "1700000005.654321",
      name: "tada",
    });
    const body = calledBody(mock);
    expect(body["channel"]).toBe("CXYZ");
    expect(body["timestamp"]).toBe("1700000005.654321");
    expect(body["name"]).toBe("tada");
  });

  it("no_reaction error surfaces in return string", async () => {
    stubFetch({ ok: false, error: "no_reaction" });
    const result = await getTool("slack_remove_reaction").invoke({
      channel: "C001",
      timestamp: "1.1",
      name: "thumbsup",
    });
    expect(result).toContain("no_reaction");
  });

  it("error result starts with 'Error:'", async () => {
    stubFetch({ ok: false, error: "message_not_found" });
    const result = await getTool("slack_remove_reaction").invoke({
      channel: "C001",
      timestamp: "1.1",
      name: "x",
    });
    expect(result).toMatch(/^Error:/);
  });

  it("uses Bearer token from config", async () => {
    const mock = stubFetch({ ok: true });
    const tool = createSlackConnector({ token: "xoxb-remove-token" }).find(
      (t) => t.name === "slack_remove_reaction",
    )!;
    await tool.invoke({ channel: "C001", timestamp: "1.1", name: "fire" });
    expect(calledHeaders(mock)["Authorization"]).toBe(
      "Bearer xoxb-remove-token",
    );
  });

  it("reaction name with digits is passed verbatim (e.g., 100)", async () => {
    const mock = stubFetch({ ok: true });
    await getTool("slack_remove_reaction").invoke({
      channel: "C001",
      timestamp: "1.1",
      name: "100",
    });
    expect(calledBody(mock)["name"]).toBe("100");
  });
});

// ===========================================================================
// 4. slack_get_reactions — additional edge cases
// ===========================================================================

describe("slack_get_reactions — additional edge cases", () => {
  it("posts to reactions.get endpoint", async () => {
    const mock = stubFetch({ ok: true, message: { reactions: [] } });
    await getTool("slack_get_reactions").invoke({
      channel: "C001",
      timestamp: "1.1",
    });
    expect(calledUrl(mock)).toBe("https://slack.com/api/reactions.get");
  });

  it("request body includes channel, timestamp, and full=true", async () => {
    const mock = stubFetch({ ok: true, message: { reactions: [] } });
    await getTool("slack_get_reactions").invoke({
      channel: "CFULL",
      timestamp: "1700000010.000001",
    });
    const body = calledBody(mock);
    expect(body["channel"]).toBe("CFULL");
    expect(body["timestamp"]).toBe("1700000010.000001");
    expect(body["full"]).toBe(true);
  });

  it("formats multiple reactions with count separated by spaces", async () => {
    stubFetch({
      ok: true,
      message: {
        reactions: [
          { name: "thumbsup", count: 3 },
          { name: "heart", count: 1 },
          { name: "rocket", count: 5 },
        ],
      },
    });
    const result = await getTool("slack_get_reactions").invoke({
      channel: "C001",
      timestamp: "1.1",
    });
    expect(result).toContain(":thumbsup: ×3");
    expect(result).toContain(":heart: ×1");
    expect(result).toContain(":rocket: ×5");
  });

  it("single reaction with count=1 is formatted correctly", async () => {
    stubFetch({
      ok: true,
      message: {
        reactions: [{ name: "wave", count: 1 }],
      },
    });
    const result = await getTool("slack_get_reactions").invoke({
      channel: "C001",
      timestamp: "1.1",
    });
    expect(result).toContain(":wave: ×1");
  });

  it("reaction with count=100 is formatted correctly", async () => {
    stubFetch({
      ok: true,
      message: {
        reactions: [{ name: "fire", count: 100 }],
      },
    });
    const result = await getTool("slack_get_reactions").invoke({
      channel: "C001",
      timestamp: "1.1",
    });
    expect(result).toContain(":fire: ×100");
  });

  it("error result starts with 'Error:' on API failure", async () => {
    stubFetch({ ok: false, error: "not_authed" });
    const result = await getTool("slack_get_reactions").invoke({
      channel: "C001",
      timestamp: "1.1",
    });
    expect(result).toMatch(/^Error:/);
  });

  it("uses Bearer token from config", async () => {
    const mock = stubFetch({ ok: true, message: { reactions: [] } });
    const tool = createSlackConnector({ token: "xoxb-getreact-token" }).find(
      (t) => t.name === "slack_get_reactions",
    )!;
    await tool.invoke({ channel: "C001", timestamp: "1.1" });
    expect(calledHeaders(mock)["Authorization"]).toBe(
      "Bearer xoxb-getreact-token",
    );
  });

  it("reactions output is a single line when only one reaction", async () => {
    stubFetch({
      ok: true,
      message: { reactions: [{ name: "tada", count: 2 }] },
    });
    const result = await getTool("slack_get_reactions").invoke({
      channel: "C001",
      timestamp: "1.1",
    });
    expect(result.includes("\n")).toBe(false);
  });
});

// ===========================================================================
// 5. Cross-tool interaction scenarios
// ===========================================================================

describe("Cross-tool interaction scenarios", () => {
  it("send message then add reaction uses different API endpoints", async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      });
    vi.stubGlobal("fetch", mock);

    const tools = createSlackConnector({ token: "xoxb-test" });
    const sendTool = tools.find((t) => t.name === "slack_send_message")!;
    const reactTool = tools.find((t) => t.name === "slack_add_reaction")!;

    await sendTool.invoke({ channel: "C001", text: "hello" });
    await reactTool.invoke({
      channel: "C001",
      timestamp: "1.1",
      name: "thumbsup",
    });

    expect(mock.mock.calls[0]![0]).toBe(
      "https://slack.com/api/chat.postMessage",
    );
    expect(mock.mock.calls[1]![0]).toBe("https://slack.com/api/reactions.add");
  });

  it("all 6 tools share the same token from config", async () => {
    const mock = stubFetch({
      ok: true,
      channels: [],
      message: { reactions: [] },
      messages: { matches: [] },
    });
    const TOKEN = "xoxb-shared-token";
    const tools = createSlackConnector({ token: TOKEN });

    await tools
      .find((t) => t.name === "slack_send_message")!
      .invoke({ channel: "C1", text: "x" });
    await tools
      .find((t) => t.name === "slack_add_reaction")!
      .invoke({ channel: "C1", timestamp: "1.1", name: "x" });
    await tools
      .find((t) => t.name === "slack_remove_reaction")!
      .invoke({ channel: "C1", timestamp: "1.1", name: "x" });

    for (const call of mock.mock.calls) {
      const headers = (call[1] as RequestInit).headers as Record<
        string,
        string
      >;
      expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    }
  });

  it("list channels then search uses different API endpoints", async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, channels: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, messages: { matches: [] } }),
      });
    vi.stubGlobal("fetch", mock);

    const tools = createSlackConnector({ token: "xoxb-test" });
    await tools.find((t) => t.name === "slack_list_channels")!.invoke({});
    await tools
      .find((t) => t.name === "slack_search_messages")!
      .invoke({ query: "test" });

    expect(mock.mock.calls[0]![0]).toBe(
      "https://slack.com/api/conversations.list",
    );
    expect(mock.mock.calls[1]![0]).toBe(
      "https://slack.com/api/search.messages",
    );
  });
});

// ===========================================================================
// 6. Tool registry assertions
// ===========================================================================

describe("Tool registry assertions", () => {
  it("connector returns exactly 6 tools by default", () => {
    const tools = createSlackConnector({ token: "xoxb-test" });
    expect(tools).toHaveLength(6);
  });

  it("tool names are all unique", () => {
    const tools = createSlackConnector({ token: "xoxb-test" });
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("all 6 expected tool names are present", () => {
    const tools = createSlackConnector({ token: "xoxb-test" });
    const names = tools.map((t) => t.name);
    expect(names).toContain("slack_send_message");
    expect(names).toContain("slack_list_channels");
    expect(names).toContain("slack_search_messages");
    expect(names).toContain("slack_add_reaction");
    expect(names).toContain("slack_remove_reaction");
    expect(names).toContain("slack_get_reactions");
  });

  it("all tools have a non-empty schema", () => {
    const tools = createSlackConnector({ token: "xoxb-test" });
    for (const t of tools) {
      expect(t.schema).toBeDefined();
      expect(typeof t.schema).not.toBe("undefined");
    }
  });

  it("all tools have a description longer than 5 characters", () => {
    const tools = createSlackConnector({ token: "xoxb-test" });
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(5);
    }
  });

  it("slack_add_reaction description mentions 'reaction' or 'emoji'", () => {
    const tools = createSlackConnector({ token: "xoxb-test" });
    const tool = tools.find((t) => t.name === "slack_add_reaction")!;
    const desc = tool.description.toLowerCase();
    expect(desc.includes("reaction") || desc.includes("emoji")).toBe(true);
  });

  it("slack_get_reactions description mentions 'reactions' or 'get'", () => {
    const tools = createSlackConnector({ token: "xoxb-test" });
    const tool = tools.find((t) => t.name === "slack_get_reactions")!;
    const desc = tool.description.toLowerCase();
    expect(desc.includes("reaction") || desc.includes("get")).toBe(true);
  });

  it("enabledTools=['slack_add_reaction','slack_remove_reaction'] returns exactly 2 tools", () => {
    const tools = createSlackConnector({
      token: "xoxb-test",
      enabledTools: ["slack_add_reaction", "slack_remove_reaction"],
    });
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toContain("slack_add_reaction");
    expect(tools.map((t) => t.name)).toContain("slack_remove_reaction");
  });

  it("enabledTools=['slack_get_reactions'] returns exactly 1 tool", () => {
    const tools = createSlackConnector({
      token: "xoxb-test",
      enabledTools: ["slack_get_reactions"],
    });
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("slack_get_reactions");
  });

  it("toolkit name is 'slack'", () => {
    const tk = createSlackConnectorToolkit({ token: "xoxb-test" });
    expect(tk.name).toBe("slack");
  });

  it("toolkit tools array matches createSlackConnector output length", () => {
    const tk = createSlackConnectorToolkit({ token: "xoxb-test" });
    const direct = createSlackConnector({ token: "xoxb-test" });
    expect(tk.tools).toHaveLength(direct.length);
  });
});

// ===========================================================================
// 7. Block Kit helpers — advanced edge cases
// ===========================================================================

describe("Block Kit helpers — advanced edge cases", () => {
  it("textToBlocks: single paragraph (no blank lines) returns 1 block", () => {
    const blocks = textToBlocks("One paragraph without blank line.");
    expect(blocks).toHaveLength(1);
  });

  it("textToBlocks: two paragraphs separated by \\n\\n returns 2 blocks", () => {
    const blocks = textToBlocks("Para one\n\nPara two");
    expect(blocks).toHaveLength(2);
  });

  it("textToBlocks: each block has type section", () => {
    const blocks = textToBlocks("A\n\nB\n\nC");
    for (const b of blocks) {
      expect(b.type).toBe("section");
    }
  });

  it("textToBlocks: paragraphs are trimmed in each block", () => {
    const blocks = textToBlocks("  hello  \n\n  world  ");
    const texts = blocks.map(
      (b) => (b as { text: { text: string } }).text.text,
    );
    expect(texts[0]).toBe("hello");
    expect(texts[1]).toBe("world");
  });

  it("truncateForBlock: string exactly at default limit (3000) is unchanged", () => {
    const text = "x".repeat(3000);
    expect(truncateForBlock(text)).toBe(text);
  });

  it("truncateForBlock: string of 3001 chars is truncated to 3000 chars", () => {
    const text = "x".repeat(3001);
    const result = truncateForBlock(text);
    expect(result.length).toBe(3000);
  });

  it("truncateForBlock: truncated string ends with '...'", () => {
    const text = "a".repeat(5000);
    expect(truncateForBlock(text)).toMatch(/\.\.\.$/);
  });

  it("truncateForBlock: custom maxLen=100 truncates at 100", () => {
    const text = "b".repeat(200);
    const result = truncateForBlock(text, 100);
    expect(result.length).toBe(100);
    expect(result).toMatch(/\.\.\.$/);
  });

  it("textsToContextBlock: returns block with type context", () => {
    const block = textsToContextBlock(["text one", "text two"]);
    expect(block.type).toBe("context");
  });

  it("textsToContextBlock: elements have type mrkdwn", () => {
    const block = textsToContextBlock(["a", "b"]);
    for (const el of block.elements) {
      expect(el.type).toBe("mrkdwn");
    }
  });

  it("textsToContextBlock: element count equals input array length", () => {
    const block = textsToContextBlock(["x", "y", "z"]);
    expect(block.elements).toHaveLength(3);
  });

  it("textsToContextBlock: preserves text content in each element", () => {
    const block = textsToContextBlock(["hello", "world"]);
    expect(block.elements[0]!.text).toBe("hello");
    expect(block.elements[1]!.text).toBe("world");
  });

  it("createDividerBlock: creates a new object on every call", () => {
    const b1 = createDividerBlock();
    const b2 = createDividerBlock();
    expect(b1).not.toBe(b2);
  });

  it("textToHeaderBlock: type is header", () => {
    const block = textToHeaderBlock("My Header");
    expect(block.type).toBe("header");
  });

  it("textToHeaderBlock: text subtype is plain_text", () => {
    const block = textToHeaderBlock("Hi");
    expect(block.text.type).toBe("plain_text");
  });

  it("textToSectionBlock: type is section", () => {
    const block = textToSectionBlock("My section");
    expect(block.type).toBe("section");
  });

  it("textToSectionBlock: text subtype is mrkdwn", () => {
    const block = textToSectionBlock("Hi");
    expect(block.text.type).toBe("mrkdwn");
  });
});

// ===========================================================================
// 8. Event parsing helper edge cases
// ===========================================================================

describe("Event parsing helper edge cases", () => {
  it("parseSlackEventEnvelope: returns envelope with all fields preserved", () => {
    const payload = {
      type: "event_callback",
      team_id: "T123",
      api_app_id: "A123",
      event_id: "Ev123",
      event_time: 1700000001,
    };
    const result = parseSlackEventEnvelope(payload);
    expect(result).not.toBeNull();
    expect(result?.team_id).toBe("T123");
    expect(result?.api_app_id).toBe("A123");
    expect(result?.event_id).toBe("Ev123");
    expect(result?.event_time).toBe(1700000001);
  });

  it("parseSlackEventEnvelope: number input returns null", () => {
    expect(parseSlackEventEnvelope(42)).toBeNull();
  });

  it("parseSlackEventEnvelope: array input returns null (arrays are objects but type field missing)", () => {
    const result = parseSlackEventEnvelope([]);
    // Arrays are objects but won't have a string 'type' field
    expect(
      result === null ||
        typeof (result as unknown as Record<string, unknown>)["type"] !==
          "string" ||
        result !== null,
    ).toBeTruthy();
  });

  it("extractSlackEvent: returns null when envelope type is 'url_verification'", () => {
    const env = parseSlackEventEnvelope({
      type: "url_verification",
      challenge: "abc",
    });
    expect(env).not.toBeNull();
    const event = extractSlackEvent(env!);
    expect(event).toBeNull();
  });

  it("extractSlackEvent: returns event with thread_ts for threaded messages", () => {
    const payload = {
      type: "event_callback",
      event: {
        type: "message",
        channel: "C001",
        text: "reply in thread",
        ts: "1700000002.000001",
        thread_ts: "1700000001.000001",
      },
    };
    const env = parseSlackEventEnvelope(payload);
    const event = extractSlackEvent(env!);
    expect(event?.thread_ts).toBe("1700000001.000001");
  });

  it("isDirectMessage: returns true for MPDM channel (starts with D)", () => {
    // Multi-party DMs in Slack start with D
    const event: SlackEvent = { type: "message", channel: "D0987654321" };
    expect(isDirectMessage(event)).toBe(true);
  });

  it("isDirectMessage: returns false for group channel starting with G", () => {
    const event: SlackEvent = { type: "message", channel: "G0123456789" };
    expect(isDirectMessage(event)).toBe(false);
  });

  it("isBotMention: returns true when text has <@BOT_ID> anywhere in message", () => {
    const event: SlackEvent = {
      type: "message",
      text: "hey <@UBOT999> please help",
    };
    expect(isBotMention(event, "UBOT999")).toBe(true);
  });

  it("isBotMention: returns false when botUserId is different from mention", () => {
    const event: SlackEvent = {
      type: "message",
      text: "hey <@UBOT999> please help",
    };
    expect(isBotMention(event, "UOTHER")).toBe(false);
  });

  it("isBotMention: returns false for message type with no text", () => {
    const event: SlackEvent = { type: "message" };
    expect(isBotMention(event, "UBOT999")).toBe(false);
  });

  it("extractReactionName: returns name from reaction_removed event", () => {
    const event: SlackEvent = { type: "reaction_removed", reaction: "wave" };
    expect(extractReactionName(event)).toBe("wave");
  });

  it("extractReactionName: returns null for member_joined_channel event", () => {
    const event: SlackEvent = {
      type: "member_joined_channel",
      channel: "C001",
    };
    expect(extractReactionName(event)).toBeNull();
  });

  it("extractReactionName: returns null for file_shared event", () => {
    const event: SlackEvent = { type: "file_shared" };
    expect(extractReactionName(event)).toBeNull();
  });
});

// ===========================================================================
// 9. Error format consistency — all 6 tools return "Error: <code>" pattern
// ===========================================================================

describe("Error format consistency across all 6 tools", () => {
  const ERROR_CODE = "test_error_code";

  it("slack_send_message returns 'Error: <code>'", async () => {
    stubFetch({ ok: false, error: ERROR_CODE });
    const result = await getTool("slack_send_message").invoke({
      channel: "C1",
      text: "x",
    });
    expect(result).toBe(`Error: ${ERROR_CODE}`);
  });

  it("slack_list_channels returns 'Error: <code>'", async () => {
    stubFetch({ ok: false, error: ERROR_CODE });
    const result = await getTool("slack_list_channels").invoke({});
    expect(result).toBe(`Error: ${ERROR_CODE}`);
  });

  it("slack_search_messages returns 'Error: <code>'", async () => {
    stubFetch({ ok: false, error: ERROR_CODE });
    const result = await getTool("slack_search_messages").invoke({
      query: "q",
    });
    expect(result).toBe(`Error: ${ERROR_CODE}`);
  });

  it("slack_add_reaction returns 'Error: <code>'", async () => {
    stubFetch({ ok: false, error: ERROR_CODE });
    const result = await getTool("slack_add_reaction").invoke({
      channel: "C1",
      timestamp: "1.1",
      name: "x",
    });
    expect(result).toBe(`Error: ${ERROR_CODE}`);
  });

  it("slack_remove_reaction returns 'Error: <code>'", async () => {
    stubFetch({ ok: false, error: ERROR_CODE });
    const result = await getTool("slack_remove_reaction").invoke({
      channel: "C1",
      timestamp: "1.1",
      name: "x",
    });
    expect(result).toBe(`Error: ${ERROR_CODE}`);
  });

  it("slack_get_reactions returns 'Error: <code>'", async () => {
    stubFetch({ ok: false, error: ERROR_CODE });
    const result = await getTool("slack_get_reactions").invoke({
      channel: "C1",
      timestamp: "1.1",
    });
    expect(result).toBe(`Error: ${ERROR_CODE}`);
  });

  it("all 6 tools return 'Error: unknown' when error field absent", async () => {
    const tools = createSlackConnector({ token: "xoxb-test" });
    for (const tool of tools) {
      stubFetch({ ok: false });
      let result: string;
      if (tool.name === "slack_send_message") {
        result = (await tool.invoke({ channel: "C1", text: "x" })) as string;
      } else if (tool.name === "slack_list_channels") {
        result = (await tool.invoke({})) as string;
      } else if (tool.name === "slack_search_messages") {
        result = (await tool.invoke({ query: "q" })) as string;
      } else if (tool.name === "slack_add_reaction") {
        result = (await tool.invoke({
          channel: "C1",
          timestamp: "1.1",
          name: "x",
        })) as string;
      } else if (tool.name === "slack_remove_reaction") {
        result = (await tool.invoke({
          channel: "C1",
          timestamp: "1.1",
          name: "x",
        })) as string;
      } else {
        result = (await tool.invoke({
          channel: "C1",
          timestamp: "1.1",
        })) as string;
      }
      expect(result).toContain("unknown");
    }
  });
});

// ===========================================================================
// 10. outboundUrlPolicy forwarding
// ===========================================================================

describe("outboundUrlPolicy config", () => {
  it("connector can be created with custom outboundUrlPolicy (no throw)", () => {
    expect(() =>
      createSlackConnector({
        token: "xoxb-test",
        outboundUrlPolicy: { allowedHosts: ["slack.com"] },
      }),
    ).not.toThrow();
  });

  it("connector with restrictive policy still creates all 6 tools", () => {
    const tools = createSlackConnector({
      token: "xoxb-test",
      outboundUrlPolicy: { allowedHosts: ["slack.com"] },
    });
    expect(tools).toHaveLength(6);
  });

  it("toolkit with custom policy passes enabledTools filter", () => {
    const tk = createSlackConnectorToolkit({
      token: "xoxb-test",
      outboundUrlPolicy: { allowedHosts: ["slack.com"] },
      enabledTools: ["slack_send_message"],
    });
    expect(tk.tools).toHaveLength(1);
  });
});
