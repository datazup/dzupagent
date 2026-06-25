/**
 * Slack connector — new features test suite.
 *
 * Covers:
 *  - Reaction tools: slack_add_reaction, slack_remove_reaction, slack_get_reactions
 *  - Webhook event parsing helpers
 *  - Block Kit message formatting helpers
 *  - Extended toolkit tool set (now 6 tools)
 *  - Edge cases for new tools
 *
 * All HTTP calls are mocked — no real Slack API requests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createSlackConnector,
  createSlackConnectorToolkit,
  textToSectionBlock,
  textToHeaderBlock,
  createDividerBlock,
  textsToContextBlock,
  textToBlocks,
  truncateForBlock,
  parseSlackEventEnvelope,
  extractSlackEvent,
  isDirectMessage,
  isBotMention,
  extractReactionName,
} from "../slack/slack-connector.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetch(response: Record<string, unknown>, httpOk = true) {
  const mock = vi.fn().mockResolvedValue({
    ok: httpOk,
    status: httpOk ? 200 : 400,
    json: async () => response,
    headers: new Headers(),
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function parsedBody(
  mock: ReturnType<typeof vi.fn>,
  callIndex = 0,
): Record<string, unknown> {
  return JSON.parse(
    (mock.mock.calls[callIndex]![1] as RequestInit).body as string,
  ) as Record<string, unknown>;
}

function calledUrl(mock: ReturnType<typeof vi.fn>, callIndex = 0): string {
  return mock.mock.calls[callIndex]![0] as string;
}

function getTool(name: string) {
  const tools = createSlackConnector({ token: "xoxb-test-token" });
  const t = tools.find((t) => t.name === name);
  if (!t) throw new Error(`Tool ${name} not found`);
  return t;
}

// ---------------------------------------------------------------------------
// 1. Reaction tools — slack_add_reaction
// ---------------------------------------------------------------------------

describe("Slack connector — new features", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("slack_add_reaction", () => {
    it("returns success message with emoji name on ok=true", async () => {
      mockFetch({ ok: true });
      const result = await getTool("slack_add_reaction").invoke({
        channel: "C001",
        timestamp: "1617000000.000001",
        name: "thumbsup",
      });
      expect(result).toContain(":thumbsup:");
      expect(result).toContain("added");
    });

    it("calls reactions.add endpoint", async () => {
      const mock = mockFetch({ ok: true });
      await getTool("slack_add_reaction").invoke({
        channel: "C001",
        timestamp: "1617000000.000001",
        name: "rocket",
      });
      expect(calledUrl(mock)).toBe("https://slack.com/api/reactions.add");
    });

    it("sends channel, timestamp, and name in request body", async () => {
      const mock = mockFetch({ ok: true });
      await getTool("slack_add_reaction").invoke({
        channel: "C123",
        timestamp: "1617000000.123456",
        name: "white_check_mark",
      });
      const body = parsedBody(mock);
      expect(body["channel"]).toBe("C123");
      expect(body["timestamp"]).toBe("1617000000.123456");
      expect(body["name"]).toBe("white_check_mark");
    });

    it("returns error string on already_reacted", async () => {
      mockFetch({ ok: false, error: "already_reacted" });
      const result = await getTool("slack_add_reaction").invoke({
        channel: "C001",
        timestamp: "123.456",
        name: "thumbsup",
      });
      expect(result).toContain("already_reacted");
    });

    it("returns error string on invalid_name", async () => {
      mockFetch({ ok: false, error: "invalid_name" });
      const result = await getTool("slack_add_reaction").invoke({
        channel: "C001",
        timestamp: "123.456",
        name: "not-a-real-emoji",
      });
      expect(result).toContain("invalid_name");
    });

    it("returns error string on message_not_found", async () => {
      mockFetch({ ok: false, error: "message_not_found" });
      const result = await getTool("slack_add_reaction").invoke({
        channel: "C001",
        timestamp: "000.000",
        name: "wave",
      });
      expect(result).toContain("message_not_found");
    });

    it("returns error: unknown when Slack omits error field", async () => {
      mockFetch({ ok: false });
      const result = await getTool("slack_add_reaction").invoke({
        channel: "C001",
        timestamp: "123.456",
        name: "smile",
      });
      expect(result).toBe("Error: unknown");
    });

    it("propagates network error as thrown exception", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("network down")),
      );
      await expect(
        getTool("slack_add_reaction").invoke({
          channel: "C001",
          timestamp: "123.456",
          name: "wave",
        }),
      ).rejects.toThrow("network down");
    });

    it("sends Bearer token in Authorization header", async () => {
      const mock = mockFetch({ ok: true });
      const tools = createSlackConnector({ token: "xoxb-reactions-token" });
      await tools
        .find((t) => t.name === "slack_add_reaction")!
        .invoke({
          channel: "C001",
          timestamp: "123.456",
          name: "fire",
        });
      const headers = (mock.mock.calls[0]![1] as RequestInit).headers as Record<
        string,
        string
      >;
      expect(headers["Authorization"]).toBe("Bearer xoxb-reactions-token");
    });

    it("emoji with underscore (e.g., +1) is passed verbatim", async () => {
      const mock = mockFetch({ ok: true });
      await getTool("slack_add_reaction").invoke({
        channel: "C001",
        timestamp: "123.456",
        name: "+1",
      });
      expect(parsedBody(mock)["name"]).toBe("+1");
    });

    it("timestamp with microsecond precision is preserved", async () => {
      const mock = mockFetch({ ok: true });
      const ts = "1617123456.789012";
      await getTool("slack_add_reaction").invoke({
        channel: "C001",
        timestamp: ts,
        name: "ok",
      });
      expect(parsedBody(mock)["timestamp"]).toBe(ts);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Reaction tools — slack_remove_reaction
  // ---------------------------------------------------------------------------

  describe("slack_remove_reaction", () => {
    it("returns success message with emoji name on ok=true", async () => {
      mockFetch({ ok: true });
      const result = await getTool("slack_remove_reaction").invoke({
        channel: "C001",
        timestamp: "1617000000.000001",
        name: "thumbsup",
      });
      expect(result).toContain(":thumbsup:");
      expect(result).toContain("removed");
    });

    it("calls reactions.remove endpoint", async () => {
      const mock = mockFetch({ ok: true });
      await getTool("slack_remove_reaction").invoke({
        channel: "C001",
        timestamp: "123.456",
        name: "thumbsup",
      });
      expect(calledUrl(mock)).toBe("https://slack.com/api/reactions.remove");
    });

    it("sends channel, timestamp, and name in request body", async () => {
      const mock = mockFetch({ ok: true });
      await getTool("slack_remove_reaction").invoke({
        channel: "C999",
        timestamp: "9999.000001",
        name: "tada",
      });
      const body = parsedBody(mock);
      expect(body["channel"]).toBe("C999");
      expect(body["timestamp"]).toBe("9999.000001");
      expect(body["name"]).toBe("tada");
    });

    it("returns error on no_reaction (reaction was not present)", async () => {
      mockFetch({ ok: false, error: "no_reaction" });
      const result = await getTool("slack_remove_reaction").invoke({
        channel: "C001",
        timestamp: "123.456",
        name: "thumbsup",
      });
      expect(result).toContain("no_reaction");
    });

    it("returns error on message_not_found", async () => {
      mockFetch({ ok: false, error: "message_not_found" });
      const result = await getTool("slack_remove_reaction").invoke({
        channel: "C001",
        timestamp: "000.000",
        name: "wave",
      });
      expect(result).toContain("message_not_found");
    });

    it("returns error: unknown when Slack omits error field", async () => {
      mockFetch({ ok: false });
      const result = await getTool("slack_remove_reaction").invoke({
        channel: "C001",
        timestamp: "123.456",
        name: "smile",
      });
      expect(result).toBe("Error: unknown");
    });

    it("propagates network failure as thrown exception", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("socket hang up")),
      );
      await expect(
        getTool("slack_remove_reaction").invoke({
          channel: "C001",
          timestamp: "123.456",
          name: "wave",
        }),
      ).rejects.toThrow("socket hang up");
    });

    it("POST method is used for reactions.remove", async () => {
      const mock = mockFetch({ ok: true });
      await getTool("slack_remove_reaction").invoke({
        channel: "C001",
        timestamp: "123.456",
        name: "heart",
      });
      expect((mock.mock.calls[0]![1] as RequestInit).method).toBe("POST");
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Reaction tools — slack_get_reactions
  // ---------------------------------------------------------------------------

  describe("slack_get_reactions", () => {
    it("returns formatted reactions string on success", async () => {
      mockFetch({
        ok: true,
        message: {
          reactions: [
            { name: "thumbsup", count: 3 },
            { name: "rocket", count: 1 },
          ],
        },
      });
      const result = await getTool("slack_get_reactions").invoke({
        channel: "C001",
        timestamp: "123.456",
      });
      expect(result).toContain(":thumbsup: ×3");
      expect(result).toContain(":rocket: ×1");
    });

    it("calls reactions.get endpoint", async () => {
      const mock = mockFetch({ ok: true, message: { reactions: [] } });
      await getTool("slack_get_reactions").invoke({
        channel: "C001",
        timestamp: "123.456",
      });
      expect(calledUrl(mock)).toBe("https://slack.com/api/reactions.get");
    });

    it("sends channel and timestamp with full=true in request body", async () => {
      const mock = mockFetch({ ok: true, message: { reactions: [] } });
      await getTool("slack_get_reactions").invoke({
        channel: "C123",
        timestamp: "9999.000001",
      });
      const body = parsedBody(mock);
      expect(body["channel"]).toBe("C123");
      expect(body["timestamp"]).toBe("9999.000001");
      expect(body["full"]).toBe(true);
    });

    it('returns "No reactions" when reactions array is empty', async () => {
      mockFetch({ ok: true, message: { reactions: [] } });
      const result = await getTool("slack_get_reactions").invoke({
        channel: "C001",
        timestamp: "123.456",
      });
      expect(result).toBe("No reactions");
    });

    it('returns "No reactions" when message has no reactions key', async () => {
      mockFetch({ ok: true, message: {} });
      const result = await getTool("slack_get_reactions").invoke({
        channel: "C001",
        timestamp: "123.456",
      });
      expect(result).toBe("No reactions");
    });

    it('returns "No reactions" when message key is missing', async () => {
      mockFetch({ ok: true });
      const result = await getTool("slack_get_reactions").invoke({
        channel: "C001",
        timestamp: "123.456",
      });
      expect(result).toBe("No reactions");
    });

    it("returns error string on invalid_auth", async () => {
      mockFetch({ ok: false, error: "invalid_auth" });
      const result = await getTool("slack_get_reactions").invoke({
        channel: "C001",
        timestamp: "123.456",
      });
      expect(result).toContain("invalid_auth");
    });

    it("returns error string on message_not_found", async () => {
      mockFetch({ ok: false, error: "message_not_found" });
      const result = await getTool("slack_get_reactions").invoke({
        channel: "C001",
        timestamp: "000.000",
      });
      expect(result).toContain("message_not_found");
    });

    it("formats single reaction correctly", async () => {
      mockFetch({
        ok: true,
        message: { reactions: [{ name: "fire", count: 7 }] },
      });
      const result = await getTool("slack_get_reactions").invoke({
        channel: "C001",
        timestamp: "123.456",
      });
      expect(result).toBe(":fire: ×7");
    });

    it("returns error: unknown when error field is missing on failure", async () => {
      mockFetch({ ok: false });
      const result = await getTool("slack_get_reactions").invoke({
        channel: "C001",
        timestamp: "123.456",
      });
      expect(result).toBe("Error: unknown");
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Toolkit now includes 6 tools
  // ---------------------------------------------------------------------------

  describe("createSlackConnectorToolkit — 6 tools", () => {
    it("toolkit contains exactly 6 tools", () => {
      const tk = createSlackConnectorToolkit({ token: "x" });
      expect(tk.tools).toHaveLength(6);
    });

    it("toolkit includes slack_add_reaction", () => {
      const tk = createSlackConnectorToolkit({ token: "x" });
      expect(tk.tools.map((t) => t.name)).toContain("slack_add_reaction");
    });

    it("toolkit includes slack_remove_reaction", () => {
      const tk = createSlackConnectorToolkit({ token: "x" });
      expect(tk.tools.map((t) => t.name)).toContain("slack_remove_reaction");
    });

    it("toolkit includes slack_get_reactions", () => {
      const tk = createSlackConnectorToolkit({ token: "x" });
      expect(tk.tools.map((t) => t.name)).toContain("slack_get_reactions");
    });

    it("filtering to only reaction tools returns 3", () => {
      const tk = createSlackConnectorToolkit({
        token: "x",
        enabledTools: [
          "slack_add_reaction",
          "slack_remove_reaction",
          "slack_get_reactions",
        ],
      });
      expect(tk.tools).toHaveLength(3);
    });

    it("all 6 tools have non-empty descriptions", () => {
      const tk = createSlackConnectorToolkit({ token: "x" });
      for (const t of tk.tools) {
        expect(t.description.length).toBeGreaterThan(5);
      }
    });

    it("all 6 tools have schemas defined", () => {
      const tk = createSlackConnectorToolkit({ token: "x" });
      for (const t of tk.tools) {
        expect(t.schema).toBeDefined();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Webhook event parsing helpers
  // ---------------------------------------------------------------------------

  describe("parseSlackEventEnvelope", () => {
    it("returns envelope for valid event_callback payload", () => {
      const payload = {
        type: "event_callback",
        event: { type: "message", text: "hello" },
      };
      const result = parseSlackEventEnvelope(payload);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("event_callback");
    });

    it("returns null for null input", () => {
      expect(parseSlackEventEnvelope(null)).toBeNull();
    });

    it("returns null for non-object input", () => {
      expect(parseSlackEventEnvelope("string")).toBeNull();
      expect(parseSlackEventEnvelope(42)).toBeNull();
    });

    it("returns null when type field is missing", () => {
      expect(parseSlackEventEnvelope({ event: {} })).toBeNull();
    });

    it("returns null when type is not a string", () => {
      expect(parseSlackEventEnvelope({ type: 42 })).toBeNull();
    });

    it("returns envelope for url_verification type", () => {
      const payload = { type: "url_verification", challenge: "abc123" };
      const result = parseSlackEventEnvelope(payload);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("url_verification");
    });

    it("preserves event_id and event_time fields", () => {
      const payload = {
        type: "event_callback",
        event_id: "Ev0001",
        event_time: 1617000000,
        event: { type: "message" },
      };
      const result = parseSlackEventEnvelope(payload);
      expect(result!.event_id).toBe("Ev0001");
      expect(result!.event_time).toBe(1617000000);
    });
  });

  describe("extractSlackEvent", () => {
    it("returns the inner event for event_callback envelopes", () => {
      const envelope = {
        type: "event_callback",
        event: { type: "message", text: "hi", channel: "C001" },
      };
      const parsed = parseSlackEventEnvelope(envelope)!;
      const event = extractSlackEvent(parsed);
      expect(event).not.toBeNull();
      expect(event!.type).toBe("message");
    });

    it("returns null for non-event_callback envelope types", () => {
      const envelope = parseSlackEventEnvelope({
        type: "url_verification",
        challenge: "x",
      })!;
      expect(extractSlackEvent(envelope)).toBeNull();
    });

    it("returns null when event field is absent in event_callback", () => {
      const envelope = parseSlackEventEnvelope({ type: "event_callback" })!;
      expect(extractSlackEvent(envelope)).toBeNull();
    });

    it("returns app_mention event correctly", () => {
      const envelope = parseSlackEventEnvelope({
        type: "event_callback",
        event: { type: "app_mention", text: "<@UBOT> help", channel: "C001" },
      })!;
      const event = extractSlackEvent(envelope);
      expect(event!.type).toBe("app_mention");
      expect(event!.text).toContain("<@UBOT>");
    });

    it("returns reaction_added event with reaction field", () => {
      const envelope = parseSlackEventEnvelope({
        type: "event_callback",
        event: {
          type: "reaction_added",
          reaction: "thumbsup",
          user: "U001",
          item: { type: "message", channel: "C001", ts: "123.456" },
        },
      })!;
      const event = extractSlackEvent(envelope);
      expect(event!.type).toBe("reaction_added");
      expect(event!.reaction).toBe("thumbsup");
    });
  });

  describe("isDirectMessage", () => {
    it("returns true when channel starts with D", () => {
      expect(isDirectMessage({ type: "message", channel: "D001ABCDE" })).toBe(
        true,
      );
    });

    it("returns false when channel starts with C (public channel)", () => {
      expect(isDirectMessage({ type: "message", channel: "C001ABCDE" })).toBe(
        false,
      );
    });

    it("returns false when channel starts with G (group DM)", () => {
      // Group DMs use G prefix, not D
      expect(isDirectMessage({ type: "message", channel: "G001ABCDE" })).toBe(
        false,
      );
    });

    it("returns false when channel is absent", () => {
      expect(isDirectMessage({ type: "message" })).toBe(false);
    });

    it("returns false when channel is empty string", () => {
      expect(isDirectMessage({ type: "message", channel: "" })).toBe(false);
    });
  });

  describe("isBotMention", () => {
    it("returns true for app_mention event type regardless of text", () => {
      expect(isBotMention({ type: "app_mention", text: "any text" })).toBe(
        true,
      );
    });

    it("returns true when message text contains the bot user ID mention", () => {
      const event = { type: "message", text: "Hey <@UBOT123> can you help?" };
      expect(isBotMention(event, "UBOT123")).toBe(true);
    });

    it("returns false when message text does not mention the bot", () => {
      const event = { type: "message", text: "Hey everyone, no bot here" };
      expect(isBotMention(event, "UBOT123")).toBe(false);
    });

    it("returns false for message type without botUserId provided", () => {
      const event = { type: "message", text: "<@UBOT123> help" };
      expect(isBotMention(event)).toBe(false);
    });

    it("returns false when event has no text", () => {
      const event = { type: "message" };
      expect(isBotMention(event, "UBOT123")).toBe(false);
    });
  });

  describe("extractReactionName", () => {
    it("returns reaction name from reaction_added event", () => {
      const event = { type: "reaction_added", reaction: "thumbsup" };
      expect(extractReactionName(event)).toBe("thumbsup");
    });

    it("returns reaction name from reaction_removed event", () => {
      const event = { type: "reaction_removed", reaction: "wave" };
      expect(extractReactionName(event)).toBe("wave");
    });

    it("returns null for non-reaction event types", () => {
      expect(extractReactionName({ type: "message", text: "hi" })).toBeNull();
      expect(extractReactionName({ type: "app_mention" })).toBeNull();
    });

    it("returns null when reaction field is missing", () => {
      const event = { type: "reaction_added" };
      expect(extractReactionName(event)).toBeNull();
    });

    it("handles emoji names with special characters like +1", () => {
      const event = { type: "reaction_added", reaction: "+1" };
      expect(extractReactionName(event)).toBe("+1");
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Block Kit formatting helpers
  // ---------------------------------------------------------------------------

  describe("textToSectionBlock", () => {
    it("returns a section block with mrkdwn type", () => {
      const block = textToSectionBlock("Hello world");
      expect(block.type).toBe("section");
      expect(block.text.type).toBe("mrkdwn");
    });

    it("preserves the text value", () => {
      const block = textToSectionBlock("*bold* and _italic_");
      expect(block.text.text).toBe("*bold* and _italic_");
    });

    it("handles empty string", () => {
      const block = textToSectionBlock("");
      expect(block.text.text).toBe("");
    });

    it("handles multiline text", () => {
      const text = "line1\nline2\nline3";
      const block = textToSectionBlock(text);
      expect(block.text.text).toBe(text);
    });

    it("handles unicode characters", () => {
      const block = textToSectionBlock("日本語テキスト 🎉");
      expect(block.text.text).toBe("日本語テキスト 🎉");
    });
  });

  describe("textToHeaderBlock", () => {
    it("returns a header block with plain_text type", () => {
      const block = textToHeaderBlock("My Header");
      expect(block.type).toBe("header");
      expect(block.text.type).toBe("plain_text");
    });

    it("preserves the header text", () => {
      const block = textToHeaderBlock("Deploy Report 2026-06-25");
      expect(block.text.text).toBe("Deploy Report 2026-06-25");
    });

    it("handles empty string as header", () => {
      const block = textToHeaderBlock("");
      expect(block.text.text).toBe("");
    });
  });

  describe("createDividerBlock", () => {
    it("returns a block with type divider", () => {
      const block = createDividerBlock();
      expect(block.type).toBe("divider");
    });

    it("creates a new object on each call (not a singleton)", () => {
      const b1 = createDividerBlock();
      const b2 = createDividerBlock();
      expect(b1).not.toBe(b2);
    });
  });

  describe("textsToContextBlock", () => {
    it("returns a context block type", () => {
      const block = textsToContextBlock(["note 1", "note 2"]);
      expect(block.type).toBe("context");
    });

    it("creates one element per input text", () => {
      const block = textsToContextBlock(["a", "b", "c"]);
      expect(block.elements).toHaveLength(3);
    });

    it("each element has type mrkdwn", () => {
      const block = textsToContextBlock(["hello"]);
      expect(block.elements[0]!.type).toBe("mrkdwn");
    });

    it("each element preserves text", () => {
      const block = textsToContextBlock(["first note", "second note"]);
      expect(block.elements[0]!.text).toBe("first note");
      expect(block.elements[1]!.text).toBe("second note");
    });

    it("handles empty array", () => {
      const block = textsToContextBlock([]);
      expect(block.elements).toHaveLength(0);
    });
  });

  describe("textToBlocks", () => {
    it("returns an array", () => {
      expect(Array.isArray(textToBlocks("hello"))).toBe(true);
    });

    it("single paragraph produces one section block", () => {
      const blocks = textToBlocks("Hello world");
      expect(blocks).toHaveLength(1);
      expect(blocks[0]!.type).toBe("section");
    });

    it("two paragraphs separated by blank line produce two section blocks", () => {
      const blocks = textToBlocks("Para one\n\nPara two");
      expect(blocks).toHaveLength(2);
    });

    it("preserves paragraph text in each block", () => {
      const blocks = textToBlocks("First para\n\nSecond para");
      const texts = blocks.map(
        (b) => (b as { text: { text: string } }).text.text,
      );
      expect(texts[0]).toBe("First para");
      expect(texts[1]).toBe("Second para");
    });

    it("empty string produces one section block with empty text", () => {
      const blocks = textToBlocks("");
      expect(blocks).toHaveLength(1);
    });

    it("whitespace-only string produces one section block", () => {
      const blocks = textToBlocks("   ");
      expect(blocks).toHaveLength(1);
    });

    it("three paragraphs produce three section blocks", () => {
      const blocks = textToBlocks("A\n\nB\n\nC");
      expect(blocks).toHaveLength(3);
    });

    it("all produced blocks have type section", () => {
      const blocks = textToBlocks("A\n\nB\n\nC");
      for (const b of blocks) {
        expect(b.type).toBe("section");
      }
    });
  });

  describe("truncateForBlock", () => {
    it("returns text unchanged when under the limit", () => {
      const text = "short text";
      expect(truncateForBlock(text)).toBe(text);
    });

    it("truncates text at exactly maxLen characters including ellipsis", () => {
      const text = "x".repeat(5000);
      const result = truncateForBlock(text);
      expect(result.length).toBe(3000);
    });

    it('adds "..." suffix when truncating', () => {
      const text = "x".repeat(5000);
      const result = truncateForBlock(text);
      expect(result.endsWith("...")).toBe(true);
    });

    it("does not truncate when text is exactly maxLen", () => {
      const text = "x".repeat(3000);
      const result = truncateForBlock(text);
      expect(result).toBe(text);
      expect(result.length).toBe(3000);
    });

    it("respects custom maxLen", () => {
      const text = "x".repeat(500);
      const result = truncateForBlock(text, 100);
      expect(result.length).toBe(100);
      expect(result.endsWith("...")).toBe(true);
    });

    it("handles empty string", () => {
      expect(truncateForBlock("")).toBe("");
    });

    it("handles text shorter than custom maxLen", () => {
      const text = "hello";
      expect(truncateForBlock(text, 200)).toBe(text);
    });
  });
});
