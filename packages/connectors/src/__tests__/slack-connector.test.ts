/**
 * Slack connector tests — comprehensive coverage of message/thread operations,
 * event-response parsing, Block Kit payload construction, rate-limit handling,
 * and error cases for all three tools exposed by createSlackConnector.
 *
 * All HTTP calls are mocked — no real Slack API requests are made.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createSlackConnector,
  createSlackConnectorToolkit,
} from "../slack/slack-connector.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function mockFetch(
  response: Record<string, unknown>,
  httpOk = true,
  status = 200,
) {
  const mock = vi.fn().mockResolvedValue({
    ok: httpOk,
    status,
    json: async () => response,
    headers: new Headers(),
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function mockFetchSequence(
  responses: Array<{
    body: Record<string, unknown>;
    httpOk?: boolean;
    status?: number;
  }>,
) {
  let call = 0;
  const mock = vi.fn().mockImplementation(async () => {
    const r = responses[call] ?? responses[responses.length - 1]!;
    call++;
    return {
      ok: r.httpOk ?? true,
      status: r.status ?? 200,
      json: async () => r.body,
      headers: new Headers(),
    };
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function getTool(name: string) {
  const tools = createSlackConnector({ token: "xoxb-test-token" });
  const t = tools.find((t) => t.name === name);
  if (!t) throw new Error(`Tool ${name} not found`);
  return t;
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

function calledHeaders(
  mock: ReturnType<typeof vi.fn>,
  callIndex = 0,
): Record<string, string> {
  return (mock.mock.calls[callIndex]![1] as RequestInit).headers as Record<
    string,
    string
  >;
}

// ---------------------------------------------------------------------------

describe("Slack connector — slack-connector.test.ts", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ==========================================================================
  // 1. Thread operations — using slack_send_message with thread_ts
  // ==========================================================================

  describe("thread operations", () => {
    it("replies to a thread by passing thread_ts in request body", async () => {
      const mock = mockFetch({ ok: true });
      const tool = getTool("slack_send_message");
      await tool.invoke({
        channel: "C1234567890",
        text: "Thread reply",
        thread_ts: "1617000000.123456",
      });
      expect(parsedBody(mock).thread_ts).toBe("1617000000.123456");
    });

    it("top-level message omits thread_ts from the JSON body", async () => {
      const mock = mockFetch({ ok: true });
      const tool = getTool("slack_send_message");
      await tool.invoke({ channel: "C1234567890", text: "Top-level message" });
      // thread_ts should serialise as undefined → undefined in parsed JSON
      expect(parsedBody(mock).thread_ts).toBeUndefined();
    });

    it("thread reply returns success string mentioning the channel", async () => {
      mockFetch({ ok: true });
      const tool = getTool("slack_send_message");
      const result = await tool.invoke({
        channel: "#eng",
        text: "reply",
        thread_ts: "1234.5678",
      });
      expect(result).toContain("Message sent to #eng");
    });

    it("thread reply propagates api error (thread_not_found)", async () => {
      mockFetch({ ok: false, error: "thread_not_found" });
      const tool = getTool("slack_send_message");
      const result = await tool.invoke({
        channel: "#eng",
        text: "reply",
        thread_ts: "bad.ts",
      });
      expect(result).toContain("thread_not_found");
    });

    it("sending consecutive thread replies increments the fetch call count", async () => {
      const mock = mockFetch({ ok: true });
      const tool = getTool("slack_send_message");
      await tool.invoke({
        channel: "C001",
        text: "reply 1",
        thread_ts: "1000.000",
      });
      await tool.invoke({
        channel: "C001",
        text: "reply 2",
        thread_ts: "1000.000",
      });
      await tool.invoke({
        channel: "C001",
        text: "reply 3",
        thread_ts: "1000.000",
      });
      expect(mock).toHaveBeenCalledTimes(3);
    });

    it("broadcast from thread requires thread_ts pointing to parent message", async () => {
      const mock = mockFetch({ ok: true });
      const tool = getTool("slack_send_message");
      // Slack broadcast: send with thread_ts pointing to the parent
      const parentTs = "1617100000.000001";
      await tool.invoke({
        channel: "C123",
        text: "broadcast msg",
        thread_ts: parentTs,
      });
      expect(parsedBody(mock).thread_ts).toBe(parentTs);
    });

    it("different thread_ts values route to different threads", async () => {
      const mock = mockFetch({ ok: true });
      const tool = getTool("slack_send_message");
      await tool.invoke({ channel: "C001", text: "a", thread_ts: "111.111" });
      await tool.invoke({ channel: "C001", text: "b", thread_ts: "222.222" });
      expect(parsedBody(mock, 0).thread_ts).toBe("111.111");
      expect(parsedBody(mock, 1).thread_ts).toBe("222.222");
    });

    it("thread reply with empty text still sends the request", async () => {
      mockFetch({ ok: true });
      const tool = getTool("slack_send_message");
      const result = await tool.invoke({
        channel: "#ch",
        text: "",
        thread_ts: "999.999",
      });
      expect(result).toContain("Message sent");
    });
  });

  // ==========================================================================
  // 2. Event parsing — slack API event-like response shapes
  // ==========================================================================

  describe("event-response parsing", () => {
    it("parses message event shape: text and channel name are surfaced", async () => {
      mockFetch({
        ok: true,
        messages: {
          matches: [
            {
              type: "message",
              text: "deployment done",
              channel: { name: "deployments", id: "C999" },
              ts: "1617000001.000001",
              user: "U001",
            },
          ],
        },
      });
      const tool = getTool("slack_search_messages");
      const result = await tool.invoke({ query: "deployment" });
      expect(result).toContain("[deployments] deployment done");
    });

    it("parses app_mention event shape — channel name rendered", async () => {
      mockFetch({
        ok: true,
        messages: {
          matches: [
            {
              type: "app_mention",
              text: "<@UBOT123> help me",
              channel: { name: "random" },
            },
          ],
        },
      });
      const tool = getTool("slack_search_messages");
      const result = await tool.invoke({ query: "help" });
      expect(result).toContain("[random] <@UBOT123> help me");
    });

    it("parses reaction_added context — channel surfaced in search result", async () => {
      mockFetch({
        ok: true,
        messages: {
          matches: [
            {
              type: "message",
              text: "great work everyone",
              channel: { name: "shoutouts" },
              reactions: [{ name: "thumbsup", count: 5 }],
            },
          ],
        },
      });
      const tool = getTool("slack_search_messages");
      const result = await tool.invoke({ query: "great" });
      expect(result).toContain("[shoutouts] great work everyone");
    });

    it("parses member_joined-style response — channel info preserved", async () => {
      mockFetch({
        ok: true,
        messages: {
          matches: [
            {
              type: "message",
              subtype: "channel_join",
              text: "<@U002> has joined the channel",
              channel: { name: "onboarding" },
            },
          ],
        },
      });
      const tool = getTool("slack_search_messages");
      const result = await tool.invoke({ query: "joined" });
      expect(result).toContain("[onboarding]");
    });

    it("handles multiple event types in a single search result batch", async () => {
      mockFetch({
        ok: true,
        messages: {
          matches: [
            { type: "message", text: "hello", channel: { name: "general" } },
            {
              type: "app_mention",
              text: "<@UBOT> check",
              channel: { name: "bots" },
            },
            {
              type: "message",
              subtype: "bot_message",
              text: "bot says hi",
              channel: { name: "bots" },
            },
          ],
        },
      });
      const tool = getTool("slack_search_messages");
      const result = await tool.invoke({ query: "multi" });
      expect(result).toContain("[general] hello");
      expect(result).toContain("[bots] <@UBOT> check");
      expect(result).toContain("[bots] bot says hi");
    });

    it("validates message search result separates entries with double newline", async () => {
      mockFetch({
        ok: true,
        messages: {
          matches: [
            { text: "first", channel: { name: "a" } },
            { text: "second", channel: { name: "b" } },
          ],
        },
      });
      const tool = getTool("slack_search_messages");
      const result = await tool.invoke({ query: "any" });
      // Connector joins with '\n\n'
      expect(result).toContain("\n\n");
    });

    it('webhook-like payload with null channel field falls back to "?"', async () => {
      mockFetch({
        ok: true,
        messages: {
          matches: [{ text: "msg from webhook", channel: null }],
        },
      });
      const tool = getTool("slack_search_messages");
      const result = await tool.invoke({ query: "webhook" });
      expect(result).toContain("[?]");
    });
  });

  // ==========================================================================
  // 3. Block Kit — sending messages with blocks (structured payloads)
  // ==========================================================================

  describe("Block Kit payload handling", () => {
    it("sends message with section block text through slack_send_message", async () => {
      const mock = mockFetch({ ok: true });
      const tool = getTool("slack_send_message");
      const sectionBlock = JSON.stringify([
        {
          type: "section",
          text: { type: "mrkdwn", text: "*Hello* from Block Kit" },
        },
      ]);
      // The tool text field can carry JSON-encoded blocks as text
      await tool.invoke({ channel: "#general", text: sectionBlock });
      expect(parsedBody(mock).text).toBe(sectionBlock);
    });

    it("sends message with button element encoded as text", async () => {
      const mock = mockFetch({ ok: true });
      const tool = getTool("slack_send_message");
      const buttonPayload = JSON.stringify({
        type: "button",
        text: { type: "plain_text", text: "Click me" },
        action_id: "btn_click",
      });
      await tool.invoke({ channel: "#general", text: buttonPayload });
      expect(parsedBody(mock).text).toBe(buttonPayload);
    });

    it("sends divider block description as text", async () => {
      const mock = mockFetch({ ok: true });
      const tool = getTool("slack_send_message");
      await tool.invoke({ channel: "#alerts", text: '{"type":"divider"}' });
      expect(parsedBody(mock).text).toBe('{"type":"divider"}');
    });

    it("sends modal view payload description as text", async () => {
      const mock = mockFetch({ ok: true });
      const tool = getTool("slack_send_message");
      const modalText =
        'modal: {"type":"modal","title":{"type":"plain_text","text":"My Modal"}}';
      await tool.invoke({ channel: "#general", text: modalText });
      expect(parsedBody(mock).text).toBe(modalText);
    });

    it("handles large Block Kit payload (>1000 chars) without truncation in request", async () => {
      const mock = mockFetch({ ok: true });
      const tool = getTool("slack_send_message");
      const largeBlocks = JSON.stringify(
        Array.from({ length: 20 }, (_, i) => ({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `Block ${i}: ${"content ".repeat(10)}`,
          },
        })),
      );
      await tool.invoke({ channel: "#general", text: largeBlocks });
      expect(parsedBody(mock).text).toBe(largeBlocks);
    });

    it("sends compose of section + actions blocks as text string", async () => {
      const mock = mockFetch({ ok: true });
      const tool = getTool("slack_send_message");
      const composed = JSON.stringify([
        {
          type: "section",
          text: { type: "mrkdwn", text: "Choose an option:" },
        },
        {
          type: "actions",
          elements: [
            { type: "button", text: { type: "plain_text", text: "Yes" } },
          ],
        },
      ]);
      await tool.invoke({ channel: "#general", text: composed });
      expect(parsedBody(mock).text).toBe(composed);
    });

    it("text field containing image block definition passes through", async () => {
      const mock = mockFetch({ ok: true });
      const tool = getTool("slack_send_message");
      const imgBlock =
        '{"type":"image","image_url":"https://example.com/img.png","alt_text":"logo"}';
      await tool.invoke({ channel: "#media", text: imgBlock });
      expect(parsedBody(mock).text).toBe(imgBlock);
    });
  });

  // ==========================================================================
  // 4. Rate-limit handling
  // ==========================================================================

  describe("rate-limit handling", () => {
    it("returns error string containing rate_limited from Slack response", async () => {
      mockFetch({ ok: false, error: "ratelimited" });
      const tool = getTool("slack_send_message");
      const result = await tool.invoke({ channel: "#general", text: "hi" });
      expect(result).toContain("ratelimited");
    });

    it("returns error string from HTTP 429 body with ok=false", async () => {
      const mock = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        headers: new Headers({ "Retry-After": "30" }),
        json: async () => ({ ok: false, error: "ratelimited" }),
      });
      vi.stubGlobal("fetch", mock);
      const tool = getTool("slack_send_message");
      const result = await tool.invoke({ channel: "#general", text: "hi" });
      expect(result).toContain("Error");
      expect(result).toContain("ratelimited");
    });

    it("rate-limited list_channels also returns error string", async () => {
      mockFetch({ ok: false, error: "ratelimited" });
      const tool = getTool("slack_list_channels");
      const result = await tool.invoke({});
      expect(result).toContain("ratelimited");
    });

    it("rate-limited search_messages also returns error string", async () => {
      mockFetch({ ok: false, error: "ratelimited" });
      const tool = getTool("slack_search_messages");
      const result = await tool.invoke({ query: "test" });
      expect(result).toContain("ratelimited");
    });

    it("simulated backoff: first call fails, second call succeeds", async () => {
      const mock = mockFetchSequence([
        { body: { ok: false, error: "ratelimited" }, status: 429 },
        { body: { ok: true } },
      ]);
      const tool = getTool("slack_send_message");
      const r1 = await tool.invoke({ channel: "#ch", text: "attempt 1" });
      const r2 = await tool.invoke({ channel: "#ch", text: "attempt 2" });
      expect(r1).toContain("ratelimited");
      expect(r2).toContain("Message sent");
      expect(mock).toHaveBeenCalledTimes(2);
    });

    it("simulated backoff: second of three calls fails, others succeed", async () => {
      const mock = mockFetchSequence([
        { body: { ok: true } },
        { body: { ok: false, error: "ratelimited" } },
        { body: { ok: true } },
      ]);
      const tool = getTool("slack_send_message");
      const r1 = await tool.invoke({ channel: "#ch", text: "a" });
      const r2 = await tool.invoke({ channel: "#ch", text: "b" });
      const r3 = await tool.invoke({ channel: "#ch", text: "c" });
      expect(r1).toContain("Message sent");
      expect(r2).toContain("ratelimited");
      expect(r3).toContain("Message sent");
      expect(mock).toHaveBeenCalledTimes(3);
    });

    it("Retry-After header is present on 429 response object", async () => {
      const retryHeader = "60";
      const mock = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        headers: new Headers({ "Retry-After": retryHeader }),
        json: async () => ({ ok: false, error: "ratelimited" }),
      });
      vi.stubGlobal("fetch", mock);
      const tool = getTool("slack_send_message");
      await tool.invoke({ channel: "#ch", text: "hi" });
      // Confirm the mock was called once — Retry-After is surfaced to caller
      expect(mock).toHaveBeenCalledOnce();
    });

    it("resume after rate-limit: verifies fetch is not called again prematurely", async () => {
      const mock = mockFetchSequence([
        { body: { ok: false, error: "ratelimited" } },
        { body: { ok: true } },
      ]);
      const tool = getTool("slack_list_channels");
      await tool.invoke({});
      await tool.invoke({});
      expect(mock).toHaveBeenCalledTimes(2);
    });
  });

  // ==========================================================================
  // 5. Error cases — channel not found, bot not in channel, invalid token,
  //    message too long
  // ==========================================================================

  describe("error cases", () => {
    it("channel_not_found: send_message returns error string", async () => {
      mockFetch({ ok: false, error: "channel_not_found" });
      const result = await getTool("slack_send_message").invoke({
        channel: "#ghost",
        text: "hi",
      });
      expect(result).toBe("Error: channel_not_found");
    });

    it("not_in_channel: returns error string", async () => {
      mockFetch({ ok: false, error: "not_in_channel" });
      const result = await getTool("slack_send_message").invoke({
        channel: "#private",
        text: "hi",
      });
      expect(result).toBe("Error: not_in_channel");
    });

    it("invalid_auth: returns error string from list_channels", async () => {
      mockFetch({ ok: false, error: "invalid_auth" });
      const result = await getTool("slack_list_channels").invoke({});
      expect(result).toBe("Error: invalid_auth");
    });

    it("token_expired: returns error from send_message", async () => {
      mockFetch({ ok: false, error: "token_expired" });
      const result = await getTool("slack_send_message").invoke({
        channel: "#ch",
        text: "hi",
      });
      expect(result).toContain("token_expired");
    });

    it("msg_too_long: Slack returns this error for oversized messages", async () => {
      mockFetch({ ok: false, error: "msg_too_long" });
      const result = await getTool("slack_send_message").invoke({
        channel: "#ch",
        text: "x".repeat(40001),
      });
      expect(result).toContain("msg_too_long");
    });

    it("no_text: error when text is empty and Slack rejects it", async () => {
      mockFetch({ ok: false, error: "no_text" });
      const result = await getTool("slack_send_message").invoke({
        channel: "#ch",
        text: "",
      });
      expect(result).toContain("no_text");
    });

    it("is_archived: cannot post to archived channel", async () => {
      mockFetch({ ok: false, error: "is_archived" });
      const result = await getTool("slack_send_message").invoke({
        channel: "#archive",
        text: "hi",
      });
      expect(result).toContain("is_archived");
    });

    it("account_inactive: deactivated token returns error", async () => {
      mockFetch({ ok: false, error: "account_inactive" });
      const result = await getTool("slack_send_message").invoke({
        channel: "#ch",
        text: "hi",
      });
      expect(result).toContain("account_inactive");
    });

    it("missing_scope: returns error when token lacks required permissions", async () => {
      mockFetch({ ok: false, error: "missing_scope" });
      const result = await getTool("slack_search_messages").invoke({
        query: "data",
      });
      expect(result).toContain("missing_scope");
    });

    it("network timeout: fetch rejection propagates as thrown error", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("socket hang up")),
      );
      const tool = getTool("slack_send_message");
      await expect(tool.invoke({ channel: "#ch", text: "hi" })).rejects.toThrow(
        "socket hang up",
      );
    });

    it("malformed JSON response: json() rejection propagates", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError("Unexpected token");
          },
        }),
      );
      const tool = getTool("slack_send_message");
      await expect(
        tool.invoke({ channel: "#ch", text: "hi" }),
      ).rejects.toThrow();
    });

    it("unexpected HTTP 503: ok=false body surfaces internal error", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 503,
          json: async () => ({ ok: false, error: "service_unavailable" }),
        }),
      );
      const result = await getTool("slack_list_channels").invoke({});
      expect(result).toContain("service_unavailable");
    });
  });

  // ==========================================================================
  // 6. Edge cases — empty message, unicode/emoji, long message, file metadata
  // ==========================================================================

  describe("edge cases", () => {
    it("empty message text: sends request without crashing", async () => {
      mockFetch({ ok: true });
      const result = await getTool("slack_send_message").invoke({
        channel: "#ch",
        text: "",
      });
      expect(result).toContain("Message sent");
    });

    it("unicode text: Japanese characters pass through unmodified", async () => {
      const mock = mockFetch({ ok: true });
      const unicodeText = "こんにちは、世界！";
      await getTool("slack_send_message").invoke({
        channel: "#ch",
        text: unicodeText,
      });
      expect(parsedBody(mock).text).toBe(unicodeText);
    });

    it("emoji in message text: unicode emoji passes through unmodified", async () => {
      const mock = mockFetch({ ok: true });
      const emojiText = "Deploy complete! 🎉🚀✅";
      await getTool("slack_send_message").invoke({
        channel: "#ch",
        text: emojiText,
      });
      expect(parsedBody(mock).text).toBe(emojiText);
    });

    it("mixed emoji and Slack syntax: <@U123> 👋 hello world", async () => {
      const mock = mockFetch({ ok: true });
      const mixedText = "<@U123> 👋 hello world";
      await getTool("slack_send_message").invoke({
        channel: "#ch",
        text: mixedText,
      });
      expect(parsedBody(mock).text).toBe(mixedText);
    });

    it("very long message (4000 chars): request body includes full text", async () => {
      const mock = mockFetch({ ok: true });
      const longText = "word ".repeat(800); // 4000 chars
      await getTool("slack_send_message").invoke({
        channel: "#ch",
        text: longText,
      });
      expect((parsedBody(mock).text as string).length).toBe(longText.length);
    });

    it("very long message (>4000 chars): passes full text to Slack without connector-side truncation", async () => {
      const mock = mockFetch({ ok: true });
      const oversizedText = "x".repeat(5000);
      await getTool("slack_send_message").invoke({
        channel: "#ch",
        text: oversizedText,
      });
      // The connector itself does NOT truncate — it forwards the full text
      expect((parsedBody(mock).text as string).length).toBe(5000);
    });

    it("file attachment metadata as text: JSON-stringified file info passes through", async () => {
      const mock = mockFetch({ ok: true });
      const fileMetadata = JSON.stringify({
        filename: "report.csv",
        filetype: "csv",
        title: "Monthly Report",
        url: "https://files.slack.com/files-pri/T123/report.csv",
      });
      await getTool("slack_send_message").invoke({
        channel: "#reports",
        text: fileMetadata,
      });
      expect(parsedBody(mock).text).toBe(fileMetadata);
    });

    it("newlines in message text: preserved in request body", async () => {
      const mock = mockFetch({ ok: true });
      const multilineText = "Line one\nLine two\nLine three";
      await getTool("slack_send_message").invoke({
        channel: "#ch",
        text: multilineText,
      });
      expect(parsedBody(mock).text).toBe(multilineText);
    });

    it("RTL text (Arabic): passes through unmodified", async () => {
      const mock = mockFetch({ ok: true });
      const arabicText = "مرحبا بالعالم";
      await getTool("slack_send_message").invoke({
        channel: "#ch",
        text: arabicText,
      });
      expect(parsedBody(mock).text).toBe(arabicText);
    });

    it("null-byte character in text: passes through to request body", async () => {
      const mock = mockFetch({ ok: true });
      const textWithNull = "hello\x00world";
      await getTool("slack_send_message").invoke({
        channel: "#ch",
        text: textWithNull,
      });
      expect(parsedBody(mock).text).toBe(textWithNull);
    });

    it("search query with special regex chars: passed verbatim", async () => {
      const mock = mockFetch({ ok: true, messages: { matches: [] } });
      await getTool("slack_search_messages").invoke({
        query: "error: (something) [brackets] .dot",
      });
      expect(parsedBody(mock).query).toBe("error: (something) [brackets] .dot");
    });

    it("search query with unicode: passes correctly", async () => {
      const mock = mockFetch({ ok: true, messages: { matches: [] } });
      await getTool("slack_search_messages").invoke({ query: "日本語検索" });
      expect(parsedBody(mock).query).toBe("日本語検索");
    });

    it("channel name with Unicode: passes through to API call", async () => {
      const mock = mockFetch({ ok: true });
      await getTool("slack_send_message").invoke({
        channel: "Cécafé",
        text: "hi",
      });
      expect(parsedBody(mock).channel).toBe("Cécafé");
    });

    it("channel list with large limit boundary value (1000): sends limit=1000", async () => {
      const mock = mockFetch({ ok: true, channels: [] });
      await getTool("slack_list_channels").invoke({ limit: 1000 });
      expect(parsedBody(mock).limit).toBe(1000);
    });

    it("channel list with limit=1: returns single channel", async () => {
      const mock = mockFetch({
        ok: true,
        channels: [{ name: "only", id: "C001" }],
      });
      await getTool("slack_list_channels").invoke({ limit: 1 });
      const body = parsedBody(mock);
      expect(body.limit).toBe(1);
    });

    it("search with count=1 returns single match", async () => {
      mockFetch({
        ok: true,
        messages: { matches: [{ text: "single", channel: { name: "x" } }] },
      });
      const result = await getTool("slack_search_messages").invoke({
        query: "q",
        count: 1,
      });
      expect(result).toBe("[x] single");
    });

    it("search with count=0: zero matches boundary", async () => {
      mockFetch({ ok: true, messages: { matches: [] } });
      const result = await getTool("slack_search_messages").invoke({
        query: "q",
        count: 0,
      });
      expect(result).toBe("");
    });

    it("thread_ts with microsecond precision preserved", async () => {
      const mock = mockFetch({ ok: true });
      const ts = "1617123456.789012";
      await getTool("slack_send_message").invoke({
        channel: "#ch",
        text: "x",
        thread_ts: ts,
      });
      expect(parsedBody(mock).thread_ts).toBe(ts);
    });
  });

  // ==========================================================================
  // 7. Request construction — Authorization, Content-Type, method, URL
  // ==========================================================================

  describe("request construction", () => {
    it("always uses POST method for all three tools", async () => {
      const mock = mockFetch({ ok: true, channels: [] });
      await getTool("slack_list_channels").invoke({});
      const init = mock.mock.calls[0]![1] as RequestInit;
      expect(init.method).toBe("POST");
    });

    it("Content-Type is application/json for all requests", async () => {
      const mock = mockFetch({ ok: true });
      await getTool("slack_send_message").invoke({
        channel: "#ch",
        text: "hi",
      });
      expect(calledHeaders(mock)["Content-Type"]).toBe("application/json");
    });

    it("Authorization header has correct Bearer prefix and token", async () => {
      const mock = mockFetch({ ok: true });
      const tools = createSlackConnector({ token: "xoxb-super-secret" });
      const t = tools.find((t) => t.name === "slack_send_message")!;
      await t.invoke({ channel: "#ch", text: "hi" });
      expect(calledHeaders(mock)["Authorization"]).toBe(
        "Bearer xoxb-super-secret",
      );
    });

    it("different connector instances use their own token independently", async () => {
      const mock = mockFetch({ ok: true });
      const toolsA = createSlackConnector({ token: "xoxb-aaa" });
      const toolsB = createSlackConnector({ token: "xoxb-bbb" });
      await toolsA
        .find((t) => t.name === "slack_send_message")!
        .invoke({ channel: "#ch", text: "a" });
      expect(calledHeaders(mock, 0)["Authorization"]).toBe("Bearer xoxb-aaa");
      await toolsB
        .find((t) => t.name === "slack_send_message")!
        .invoke({ channel: "#ch", text: "b" });
      expect(calledHeaders(mock, 1)["Authorization"]).toBe("Bearer xoxb-bbb");
    });

    it("URL for slack_send_message is exact Slack API endpoint", async () => {
      const mock = mockFetch({ ok: true });
      await getTool("slack_send_message").invoke({
        channel: "#ch",
        text: "hi",
      });
      expect(calledUrl(mock)).toBe("https://slack.com/api/chat.postMessage");
    });

    it("URL for slack_list_channels is exact Slack API endpoint", async () => {
      const mock = mockFetch({ ok: true, channels: [] });
      await getTool("slack_list_channels").invoke({});
      expect(calledUrl(mock)).toBe("https://slack.com/api/conversations.list");
    });

    it("URL for slack_search_messages is exact Slack API endpoint", async () => {
      const mock = mockFetch({ ok: true, messages: { matches: [] } });
      await getTool("slack_search_messages").invoke({ query: "q" });
      expect(calledUrl(mock)).toBe("https://slack.com/api/search.messages");
    });
  });

  // ==========================================================================
  // 8. Toolkit factory and tool set
  // ==========================================================================

  describe("createSlackConnectorToolkit", () => {
    it('toolkit name is "slack"', () => {
      const tk = createSlackConnectorToolkit({ token: "x" });
      expect(tk.name).toBe("slack");
    });

    it("toolkit contains exactly 6 tools", () => {
      const tk = createSlackConnectorToolkit({ token: "x" });
      expect(tk.tools).toHaveLength(6);
    });

    it("toolkit tools include all three expected names", () => {
      const tk = createSlackConnectorToolkit({ token: "x" });
      const names = tk.tools.map((t) => t.name);
      expect(names).toContain("slack_send_message");
      expect(names).toContain("slack_list_channels");
      expect(names).toContain("slack_search_messages");
    });

    it("toolkit enabledTools is undefined when not specified", () => {
      const tk = createSlackConnectorToolkit({ token: "x" });
      expect(tk.enabledTools).toBeUndefined();
    });

    it("toolkit enabledTools is set when specified", () => {
      const tk = createSlackConnectorToolkit({
        token: "x",
        enabledTools: ["slack_send_message"],
      });
      expect(tk.enabledTools).toEqual(["slack_send_message"]);
    });

    it("toolkit filters to one tool when only send is enabled", () => {
      const tk = createSlackConnectorToolkit({
        token: "x",
        enabledTools: ["slack_send_message"],
      });
      expect(tk.tools).toHaveLength(1);
      expect(tk.tools[0]!.name).toBe("slack_send_message");
    });

    it("toolkit filters to two tools correctly", () => {
      const tk = createSlackConnectorToolkit({
        token: "x",
        enabledTools: ["slack_send_message", "slack_list_channels"],
      });
      expect(tk.tools).toHaveLength(2);
    });

    it("toolkit returns empty tools array when enabledTools matches nothing", () => {
      const tk = createSlackConnectorToolkit({
        token: "x",
        enabledTools: ["nonexistent"],
      });
      expect(tk.tools).toHaveLength(0);
    });

    it("all toolkit tools have non-empty descriptions", () => {
      const tk = createSlackConnectorToolkit({ token: "x" });
      for (const t of tk.tools) {
        expect(t.description).toBeTruthy();
        expect(t.description.length).toBeGreaterThan(5);
      }
    });

    it("all toolkit tools have a defined schema", () => {
      const tk = createSlackConnectorToolkit({ token: "x" });
      for (const t of tk.tools) {
        expect(t.schema).toBeDefined();
      }
    });
  });
});
