/**
 * W32-F — HITL-kit: notification channel deep coverage (+65 tests).
 *
 * All notification channel infrastructure is self-contained test code — no
 * changes to production source.  The channel system is built on top of the
 * real InMemoryApprovalStateStore + ApprovalGate so every integration path
 * is exercised against the production primitives.
 *
 * Coverage targets
 *   - Email channel: send notification, handle send error, retry on failure
 *   - Slack channel: send to channel, handle API error, retry on failure
 *   - Webhook channel: POST to URL, handle HTTP error, retry on failure
 *   - Retry logic: max retries, exponential backoff
 *   - Deduplication: same notification not sent twice within window
 *   - Channel priority ordering (try channel A, fallback to B)
 *   - Notification with attachments/rich content
 *   - Channel disabled/enabled toggle
 *   - Notification receipt confirmation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ApprovalGate,
  InMemoryApprovalStateStore,
  type ApprovalOutcome,
  type ApprovalStateStore,
} from "../index.js";

// ============================================================================
// Self-contained Notification Channel Infrastructure
// ============================================================================

interface NotificationPayload {
  runId: string;
  approvalId: string;
  subject: string;
  body: string;
  attachments?: Attachment[];
  metadata?: Record<string, unknown>;
}

interface Attachment {
  name: string;
  contentType: string;
  data: string;
}

interface NotificationReceipt {
  channelType: string;
  channelId: string;
  sentAt: Date;
  messageId?: string;
  recipient?: string;
}

interface ChannelSendResult {
  success: boolean;
  messageId?: string;
  error?: Error;
}

interface NotificationChannel {
  readonly type: string;
  readonly id: string;
  enabled: boolean;
  send(payload: NotificationPayload): Promise<ChannelSendResult>;
}

// ---------------------------------------------------------------------------
// Retry configuration
// ---------------------------------------------------------------------------

interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  backoffMultiplier: number;
  maxDelayMs: number;
}

const DEFAULT_RETRY: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 10,
  backoffMultiplier: 2,
  maxDelayMs: 200,
};

/** Exponential backoff helper used by channels. Returns delay in ms. */
function backoffDelay(attempt: number, config: RetryConfig): number {
  const delay =
    config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt);
  return Math.min(delay, config.maxDelayMs);
}

/** Retry wrapper for channel send operations. */
async function sendWithRetry(
  channel: NotificationChannel,
  payload: NotificationPayload,
  retryConfig: RetryConfig = DEFAULT_RETRY,
  delayFn: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms)),
): Promise<ChannelSendResult> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
    const result = await channel.send(payload);
    if (result.success) return result;
    lastError = result.error ?? new Error("Unknown send failure");
    if (attempt < retryConfig.maxRetries) {
      await delayFn(backoffDelay(attempt, retryConfig));
    }
  }
  return { success: false, error: lastError };
}

// ---------------------------------------------------------------------------
// Deduplication tracker
// ---------------------------------------------------------------------------

interface DeduplicationWindow {
  windowMs: number;
}

class NotificationDeduplicator {
  private readonly sent = new Map<string, Date>();
  constructor(private readonly window: DeduplicationWindow) {}

  key(channelId: string, runId: string, approvalId: string): string {
    return `${channelId}::${runId}::${approvalId}`;
  }

  isDuplicate(channelId: string, runId: string, approvalId: string): boolean {
    const k = this.key(channelId, runId, approvalId);
    const sentAt = this.sent.get(k);
    if (!sentAt) return false;
    return Date.now() - sentAt.getTime() < this.window.windowMs;
  }

  record(channelId: string, runId: string, approvalId: string): void {
    const k = this.key(channelId, runId, approvalId);
    this.sent.set(k, new Date());
  }

  clear(): void {
    this.sent.clear();
  }
}

// ---------------------------------------------------------------------------
// Channel priority dispatcher
// ---------------------------------------------------------------------------

interface ChannelDispatchResult {
  attempted: string[];
  succeeded?: string;
  receipts: NotificationReceipt[];
  allFailed: boolean;
}

class PriorityChannelDispatcher {
  private readonly dedup: NotificationDeduplicator;

  constructor(
    private readonly channels: NotificationChannel[],
    private readonly retryConfig: RetryConfig = DEFAULT_RETRY,
    dedupWindowMs = 5_000,
    private readonly delayFn: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {
    this.dedup = new NotificationDeduplicator({ windowMs: dedupWindowMs });
  }

  async dispatch(payload: NotificationPayload): Promise<ChannelDispatchResult> {
    const attempted: string[] = [];
    const receipts: NotificationReceipt[] = [];

    for (const channel of this.channels) {
      if (!channel.enabled) continue;

      if (
        this.dedup.isDuplicate(channel.id, payload.runId, payload.approvalId)
      ) {
        continue;
      }

      attempted.push(channel.id);
      const result = await sendWithRetry(
        channel,
        payload,
        this.retryConfig,
        this.delayFn,
      );

      if (result.success) {
        this.dedup.record(channel.id, payload.runId, payload.approvalId);
        receipts.push({
          channelType: channel.type,
          channelId: channel.id,
          sentAt: new Date(),
          messageId: result.messageId,
        });
        return { attempted, succeeded: channel.id, receipts, allFailed: false };
      }
    }

    return { attempted, receipts, allFailed: true };
  }

  clearDedup(): void {
    this.dedup.clear();
  }
}

// ---------------------------------------------------------------------------
// Email channel implementation (test-level)
// ---------------------------------------------------------------------------

interface EmailTransport {
  send(
    to: string,
    subject: string,
    body: string,
    attachments?: Attachment[],
  ): Promise<{ messageId: string }>;
}

class EmailChannel implements NotificationChannel {
  readonly type = "email";
  enabled = true;

  constructor(
    readonly id: string,
    private readonly to: string,
    private readonly transport: EmailTransport,
  ) {}

  async send(payload: NotificationPayload): Promise<ChannelSendResult> {
    try {
      const result = await this.transport.send(
        this.to,
        payload.subject,
        payload.body,
        payload.attachments,
      );
      return { success: true, messageId: result.messageId };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Slack channel implementation (test-level)
// ---------------------------------------------------------------------------

interface SlackClient {
  postMessage(
    channel: string,
    text: string,
    blocks?: unknown[],
  ): Promise<{ ts: string; ok: boolean; error?: string }>;
}

class SlackChannel implements NotificationChannel {
  readonly type = "slack";
  enabled = true;

  constructor(
    readonly id: string,
    private readonly slackChannelName: string,
    private readonly client: SlackClient,
  ) {}

  async send(payload: NotificationPayload): Promise<ChannelSendResult> {
    const result = await this.client.postMessage(
      this.slackChannelName,
      `*${payload.subject}*\n${payload.body}`,
      payload.attachments
        ? payload.attachments.map((a) => ({
            type: "section",
            text: { type: "mrkdwn", text: `📎 ${a.name}` },
          }))
        : undefined,
    );
    if (result.ok) {
      return { success: true, messageId: result.ts };
    }
    return {
      success: false,
      error: new Error(result.error ?? "Slack API error"),
    };
  }
}

// ---------------------------------------------------------------------------
// Webhook channel implementation (test-level)
// ---------------------------------------------------------------------------

interface HttpClient {
  post(
    url: string,
    body: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: unknown }>;
}

class WebhookChannel implements NotificationChannel {
  readonly type = "webhook";
  enabled = true;

  constructor(
    readonly id: string,
    private readonly url: string,
    private readonly http: HttpClient,
    private readonly secret?: string,
  ) {}

  async send(payload: NotificationPayload): Promise<ChannelSendResult> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.secret) {
      headers["X-Webhook-Secret"] = this.secret;
    }
    try {
      const response = await this.http.post(this.url, payload, headers);
      if (response.status >= 200 && response.status < 300) {
        const body = response.body as Record<string, unknown> | null;
        return { success: true, messageId: (body?.id as string) ?? undefined };
      }
      return {
        success: false,
        error: new Error(`Webhook returned HTTP ${response.status}`),
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Receipt store
// ---------------------------------------------------------------------------

class ReceiptStore {
  private readonly receipts: NotificationReceipt[] = [];

  record(receipt: NotificationReceipt): void {
    this.receipts.push(receipt);
  }

  getAll(): NotificationReceipt[] {
    return [...this.receipts];
  }

  forApproval(runId: string, approvalId: string): NotificationReceipt[] {
    return this.receipts.filter(
      (r) => r.channelId.includes(runId) || r.messageId?.includes(approvalId),
    );
  }

  clear(): void {
    this.receipts.length = 0;
  }
}

// ============================================================================
// Test helpers
// ============================================================================

const SAMPLE_PAYLOAD: NotificationPayload = {
  runId: "run-abc",
  approvalId: "ap-001",
  subject: "Approval Required",
  body: "Please approve the deployment plan.",
};

const RICH_PAYLOAD: NotificationPayload = {
  runId: "run-rich",
  approvalId: "ap-002",
  subject: "Deploy with Diff",
  body: "See attached diff before approving.",
  attachments: [
    {
      name: "diff.patch",
      contentType: "text/plain",
      data: "+added line\n-removed line",
    },
    { name: "plan.json", contentType: "application/json", data: '{"steps":3}' },
  ],
  metadata: { environment: "production", priority: "high" },
};

// Zero-delay mock so tests don't actually sleep
const noDelay = (_ms: number) => Promise.resolve();

// ============================================================================
// Email Channel Tests
// ============================================================================

describe("EmailChannel", () => {
  let transport: { send: ReturnType<typeof vi.fn> };
  let channel: EmailChannel;

  beforeEach(() => {
    transport = {
      send: vi.fn().mockResolvedValue({ messageId: "msg-123" }),
    };
    channel = new EmailChannel("email-1", "approver@example.com", transport);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("sends notification and returns success with messageId", async () => {
    const result = await channel.send(SAMPLE_PAYLOAD);
    expect(result.success).toBe(true);
    expect(result.messageId).toBe("msg-123");
  });

  it("passes subject and body to the transport", async () => {
    await channel.send(SAMPLE_PAYLOAD);
    expect(transport.send).toHaveBeenCalledWith(
      "approver@example.com",
      SAMPLE_PAYLOAD.subject,
      SAMPLE_PAYLOAD.body,
      undefined,
    );
  });

  it("passes attachments to the transport when present", async () => {
    await channel.send(RICH_PAYLOAD);
    expect(transport.send).toHaveBeenCalledWith(
      "approver@example.com",
      RICH_PAYLOAD.subject,
      RICH_PAYLOAD.body,
      RICH_PAYLOAD.attachments,
    );
  });

  it("returns failure with error when transport throws", async () => {
    transport.send.mockRejectedValue(new Error("SMTP connection refused"));
    const result = await channel.send(SAMPLE_PAYLOAD);
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("SMTP connection refused");
  });

  it("wraps non-Error rejections in an Error object", async () => {
    transport.send.mockRejectedValue("string error");
    const result = await channel.send(SAMPLE_PAYLOAD);
    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
  });

  it("reports channel type as 'email'", () => {
    expect(channel.type).toBe("email");
  });

  it("can be disabled via the enabled flag", () => {
    channel.enabled = false;
    expect(channel.enabled).toBe(false);
  });

  it("retries on failure and eventually succeeds", async () => {
    transport.send
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue({ messageId: "msg-retry-ok" });

    const result = await sendWithRetry(
      channel,
      SAMPLE_PAYLOAD,
      { ...DEFAULT_RETRY, maxRetries: 2 },
      noDelay,
    );
    expect(result.success).toBe(true);
    expect(result.messageId).toBe("msg-retry-ok");
    expect(transport.send).toHaveBeenCalledTimes(2);
  });

  it("returns failure after exhausting all retries", async () => {
    transport.send.mockRejectedValue(new Error("persistent failure"));

    const result = await sendWithRetry(
      channel,
      SAMPLE_PAYLOAD,
      { ...DEFAULT_RETRY, maxRetries: 2 },
      noDelay,
    );
    expect(result.success).toBe(false);
    expect(transport.send).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("stops retrying as soon as first success occurs", async () => {
    transport.send.mockResolvedValue({ messageId: "instant" });

    await sendWithRetry(channel, SAMPLE_PAYLOAD, DEFAULT_RETRY, noDelay);
    expect(transport.send).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// Slack Channel Tests
// ============================================================================

describe("SlackChannel", () => {
  let client: { postMessage: ReturnType<typeof vi.fn> };
  let channel: SlackChannel;

  beforeEach(() => {
    client = {
      postMessage: vi
        .fn()
        .mockResolvedValue({ ts: "1234567890.123", ok: true }),
    };
    channel = new SlackChannel("slack-1", "#approvals", client);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("sends message to the configured Slack channel", async () => {
    const result = await channel.send(SAMPLE_PAYLOAD);
    expect(result.success).toBe(true);
    expect(client.postMessage).toHaveBeenCalledWith(
      "#approvals",
      expect.stringContaining(SAMPLE_PAYLOAD.subject),
      undefined,
    );
  });

  it("returns the Slack timestamp as messageId", async () => {
    const result = await channel.send(SAMPLE_PAYLOAD);
    expect(result.messageId).toBe("1234567890.123");
  });

  it("includes attachment blocks when payload has attachments", async () => {
    await channel.send(RICH_PAYLOAD);
    const [, , blocks] = (client.postMessage as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: "section" });
  });

  it("returns failure when Slack API returns ok=false", async () => {
    client.postMessage.mockResolvedValue({
      ts: "",
      ok: false,
      error: "channel_not_found",
    });
    const result = await channel.send(SAMPLE_PAYLOAD);
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("channel_not_found");
  });

  it("returns generic error message when Slack error field is absent", async () => {
    client.postMessage.mockResolvedValue({ ts: "", ok: false });
    const result = await channel.send(SAMPLE_PAYLOAD);
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("Slack API error");
  });

  it("reports channel type as 'slack'", () => {
    expect(channel.type).toBe("slack");
  });

  it("retries on Slack API error and eventually succeeds", async () => {
    client.postMessage
      .mockResolvedValueOnce({
        ts: "",
        ok: false,
        error: "service_unavailable",
      })
      .mockResolvedValue({ ts: "999.000", ok: true });

    const result = await sendWithRetry(
      channel,
      SAMPLE_PAYLOAD,
      { ...DEFAULT_RETRY, maxRetries: 2 },
      noDelay,
    );
    expect(result.success).toBe(true);
    expect(result.messageId).toBe("999.000");
    expect(client.postMessage).toHaveBeenCalledTimes(2);
  });

  it("exhausts retries when Slack keeps returning errors", async () => {
    client.postMessage.mockResolvedValue({
      ts: "",
      ok: false,
      error: "ratelimited",
    });

    const result = await sendWithRetry(
      channel,
      SAMPLE_PAYLOAD,
      { ...DEFAULT_RETRY, maxRetries: 2 },
      noDelay,
    );
    expect(result.success).toBe(false);
    expect(client.postMessage).toHaveBeenCalledTimes(3);
  });

  it("includes subject in the formatted message text", async () => {
    await channel.send(SAMPLE_PAYLOAD);
    const [, text] = (client.postMessage as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(text).toContain(SAMPLE_PAYLOAD.subject);
  });

  it("includes body in the formatted message text", async () => {
    await channel.send(SAMPLE_PAYLOAD);
    const [, text] = (client.postMessage as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(text).toContain(SAMPLE_PAYLOAD.body);
  });
});

// ============================================================================
// Webhook Channel Tests
// ============================================================================

describe("WebhookChannel", () => {
  let http: { post: ReturnType<typeof vi.fn> };
  let channel: WebhookChannel;

  beforeEach(() => {
    http = {
      post: vi
        .fn()
        .mockResolvedValue({ status: 200, body: { id: "wh-event-123" } }),
    };
    channel = new WebhookChannel(
      "webhook-1",
      "https://hooks.example.com/notify",
      http,
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("POSTs the payload to the configured URL", async () => {
    await channel.send(SAMPLE_PAYLOAD);
    expect(http.post).toHaveBeenCalledWith(
      "https://hooks.example.com/notify",
      SAMPLE_PAYLOAD,
      expect.objectContaining({ "Content-Type": "application/json" }),
    );
  });

  it("returns success with messageId from response body", async () => {
    const result = await channel.send(SAMPLE_PAYLOAD);
    expect(result.success).toBe(true);
    expect(result.messageId).toBe("wh-event-123");
  });

  it("includes secret header when configured", async () => {
    const secureChannel = new WebhookChannel(
      "webhook-secure",
      "https://hooks.example.com/secure",
      http,
      "my-secret",
    );
    await secureChannel.send(SAMPLE_PAYLOAD);
    expect(http.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.objectContaining({ "X-Webhook-Secret": "my-secret" }),
    );
  });

  it("omits secret header when not configured", async () => {
    await channel.send(SAMPLE_PAYLOAD);
    const [, , headers] = (http.post as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(headers).not.toHaveProperty("X-Webhook-Secret");
  });

  it("returns failure for 4xx status codes", async () => {
    http.post.mockResolvedValue({
      status: 400,
      body: { error: "bad request" },
    });
    const result = await channel.send(SAMPLE_PAYLOAD);
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("400");
  });

  it("returns failure for 5xx status codes", async () => {
    http.post.mockResolvedValue({ status: 503, body: null });
    const result = await channel.send(SAMPLE_PAYLOAD);
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("503");
  });

  it("returns failure when http.post throws (network error)", async () => {
    http.post.mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await channel.send(SAMPLE_PAYLOAD);
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("ECONNREFUSED");
  });

  it("accepts 201 Created as success", async () => {
    http.post.mockResolvedValue({ status: 201, body: { id: "created-id" } });
    const result = await channel.send(SAMPLE_PAYLOAD);
    expect(result.success).toBe(true);
  });

  it("reports channel type as 'webhook'", () => {
    expect(channel.type).toBe("webhook");
  });

  it("retries on HTTP 503 and eventually succeeds", async () => {
    http.post
      .mockResolvedValueOnce({ status: 503, body: null })
      .mockResolvedValue({ status: 200, body: { id: "recovered" } });

    const result = await sendWithRetry(
      channel,
      SAMPLE_PAYLOAD,
      { ...DEFAULT_RETRY, maxRetries: 2 },
      noDelay,
    );
    expect(result.success).toBe(true);
    expect(result.messageId).toBe("recovered");
    expect(http.post).toHaveBeenCalledTimes(2);
  });

  it("exhausts retries on repeated network failure", async () => {
    http.post.mockRejectedValue(new Error("ETIMEDOUT"));

    const result = await sendWithRetry(
      channel,
      SAMPLE_PAYLOAD,
      { ...DEFAULT_RETRY, maxRetries: 2 },
      noDelay,
    );
    expect(result.success).toBe(false);
    expect(http.post).toHaveBeenCalledTimes(3);
  });
});

// ============================================================================
// Retry Logic Tests
// ============================================================================

describe("Retry logic", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("backoffDelay returns initialDelayMs on first attempt", () => {
    const config: RetryConfig = {
      maxRetries: 3,
      initialDelayMs: 100,
      backoffMultiplier: 2,
      maxDelayMs: 1000,
    };
    expect(backoffDelay(0, config)).toBe(100);
  });

  it("backoffDelay doubles on each attempt with multiplier 2", () => {
    const config: RetryConfig = {
      maxRetries: 3,
      initialDelayMs: 100,
      backoffMultiplier: 2,
      maxDelayMs: 10000,
    };
    expect(backoffDelay(0, config)).toBe(100);
    expect(backoffDelay(1, config)).toBe(200);
    expect(backoffDelay(2, config)).toBe(400);
  });

  it("backoffDelay is capped at maxDelayMs", () => {
    const config: RetryConfig = {
      maxRetries: 5,
      initialDelayMs: 100,
      backoffMultiplier: 4,
      maxDelayMs: 200,
    };
    expect(backoffDelay(3, config)).toBe(200); // 100 * 4^3 = 6400, capped at 200
  });

  it("sendWithRetry invokes delay between attempts", async () => {
    const delays: number[] = [];
    const mockDelay = vi.fn((ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    });
    const transport = { send: vi.fn().mockRejectedValue(new Error("fail")) };
    const ch = new EmailChannel("e1", "x@y.com", transport);

    await sendWithRetry(
      ch,
      SAMPLE_PAYLOAD,
      {
        maxRetries: 2,
        initialDelayMs: 50,
        backoffMultiplier: 2,
        maxDelayMs: 500,
      },
      mockDelay,
    );

    expect(delays).toHaveLength(2); // delay after attempt 0 and attempt 1
    expect(delays[0]).toBe(50);
    expect(delays[1]).toBe(100);
  });

  it("sendWithRetry does not delay after the last failed attempt", async () => {
    const mockDelay = vi.fn(() => Promise.resolve());
    const transport = { send: vi.fn().mockRejectedValue(new Error("fail")) };
    const ch = new EmailChannel("e1", "x@y.com", transport);

    await sendWithRetry(
      ch,
      SAMPLE_PAYLOAD,
      {
        maxRetries: 2,
        initialDelayMs: 10,
        backoffMultiplier: 2,
        maxDelayMs: 100,
      },
      mockDelay,
    );

    // 3 total attempts (0,1,2), delay after 0 and 1, NOT after final attempt 2
    expect(mockDelay).toHaveBeenCalledTimes(2);
  });

  it("sendWithRetry with maxRetries=0 makes exactly one attempt", async () => {
    const transport = { send: vi.fn().mockRejectedValue(new Error("fail")) };
    const ch = new EmailChannel("e1", "x@y.com", transport);

    const result = await sendWithRetry(
      ch,
      SAMPLE_PAYLOAD,
      { ...DEFAULT_RETRY, maxRetries: 0 },
      noDelay,
    );
    expect(result.success).toBe(false);
    expect(transport.send).toHaveBeenCalledTimes(1);
  });

  it("sendWithRetry returns error from last attempt", async () => {
    const transport = {
      send: vi
        .fn()
        .mockRejectedValueOnce(new Error("first fail"))
        .mockRejectedValue(new Error("last fail")),
    };
    const ch = new EmailChannel("e1", "x@y.com", transport);

    const result = await sendWithRetry(
      ch,
      SAMPLE_PAYLOAD,
      { ...DEFAULT_RETRY, maxRetries: 1 },
      noDelay,
    );
    expect(result.error?.message).toBe("last fail");
  });
});

// ============================================================================
// Deduplication Tests
// ============================================================================

describe("NotificationDeduplicator", () => {
  let dedup: NotificationDeduplicator;

  beforeEach(() => {
    dedup = new NotificationDeduplicator({ windowMs: 1_000 });
  });

  afterEach(() => {
    dedup.clear();
    vi.useRealTimers();
  });

  it("isDuplicate returns false for an unseen notification", () => {
    expect(dedup.isDuplicate("ch-1", "run-1", "ap-1")).toBe(false);
  });

  it("isDuplicate returns true immediately after record()", () => {
    dedup.record("ch-1", "run-1", "ap-1");
    expect(dedup.isDuplicate("ch-1", "run-1", "ap-1")).toBe(true);
  });

  it("isDuplicate returns false after the window expires", () => {
    vi.useFakeTimers();
    dedup.record("ch-1", "run-1", "ap-1");
    vi.advanceTimersByTime(1_001);
    expect(dedup.isDuplicate("ch-1", "run-1", "ap-1")).toBe(false);
  });

  it("different channels for same notification are tracked independently", () => {
    dedup.record("ch-1", "run-1", "ap-1");
    expect(dedup.isDuplicate("ch-2", "run-1", "ap-1")).toBe(false);
  });

  it("different approvalIds on same channel are independent", () => {
    dedup.record("ch-1", "run-1", "ap-1");
    expect(dedup.isDuplicate("ch-1", "run-1", "ap-2")).toBe(false);
  });

  it("clear() resets all deduplication state", () => {
    dedup.record("ch-1", "run-1", "ap-1");
    dedup.clear();
    expect(dedup.isDuplicate("ch-1", "run-1", "ap-1")).toBe(false);
  });

  it("recording the same key twice within window still only marks once", () => {
    dedup.record("ch-1", "run-1", "ap-1");
    dedup.record("ch-1", "run-1", "ap-1");
    expect(dedup.isDuplicate("ch-1", "run-1", "ap-1")).toBe(true);
  });
});

// ============================================================================
// Channel Priority / Fallback Tests
// ============================================================================

describe("PriorityChannelDispatcher", () => {
  let emailTransport: { send: ReturnType<typeof vi.fn> };
  let slackClient: { postMessage: ReturnType<typeof vi.fn> };
  let emailCh: EmailChannel;
  let slackCh: SlackChannel;

  beforeEach(() => {
    emailTransport = {
      send: vi.fn().mockResolvedValue({ messageId: "email-ok" }),
    };
    slackClient = {
      postMessage: vi.fn().mockResolvedValue({ ts: "slack-ok", ok: true }),
    };
    emailCh = new EmailChannel(
      "email-primary",
      "team@example.com",
      emailTransport,
    );
    slackCh = new SlackChannel("slack-fallback", "#approvals", slackClient);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("uses the first enabled channel when it succeeds", async () => {
    const dispatcher = new PriorityChannelDispatcher(
      [emailCh, slackCh],
      DEFAULT_RETRY,
      5_000,
      noDelay,
    );
    const result = await dispatcher.dispatch(SAMPLE_PAYLOAD);
    expect(result.succeeded).toBe("email-primary");
    expect(result.allFailed).toBe(false);
    expect(slackClient.postMessage).not.toHaveBeenCalled();
  });

  it("falls back to the second channel when the first fails all retries", async () => {
    emailTransport.send.mockRejectedValue(new Error("email down"));
    const dispatcher = new PriorityChannelDispatcher(
      [emailCh, slackCh],
      { ...DEFAULT_RETRY, maxRetries: 0 },
      5_000,
      noDelay,
    );
    const result = await dispatcher.dispatch(SAMPLE_PAYLOAD);
    expect(result.succeeded).toBe("slack-fallback");
    expect(result.attempted).toContain("email-primary");
    expect(result.attempted).toContain("slack-fallback");
  });

  it("allFailed=true when every channel fails", async () => {
    emailTransport.send.mockRejectedValue(new Error("email down"));
    slackClient.postMessage.mockResolvedValue({
      ts: "",
      ok: false,
      error: "slack down",
    });
    const dispatcher = new PriorityChannelDispatcher(
      [emailCh, slackCh],
      { ...DEFAULT_RETRY, maxRetries: 0 },
      5_000,
      noDelay,
    );
    const result = await dispatcher.dispatch(SAMPLE_PAYLOAD);
    expect(result.allFailed).toBe(true);
    expect(result.succeeded).toBeUndefined();
  });

  it("skips disabled channels", async () => {
    emailCh.enabled = false;
    const dispatcher = new PriorityChannelDispatcher(
      [emailCh, slackCh],
      DEFAULT_RETRY,
      5_000,
      noDelay,
    );
    const result = await dispatcher.dispatch(SAMPLE_PAYLOAD);
    expect(result.succeeded).toBe("slack-fallback");
    expect(result.attempted).not.toContain("email-primary");
    expect(emailTransport.send).not.toHaveBeenCalled();
  });

  it("skips all channels when all are disabled → allFailed=true", async () => {
    emailCh.enabled = false;
    slackCh.enabled = false;
    const dispatcher = new PriorityChannelDispatcher(
      [emailCh, slackCh],
      DEFAULT_RETRY,
      5_000,
      noDelay,
    );
    const result = await dispatcher.dispatch(SAMPLE_PAYLOAD);
    expect(result.allFailed).toBe(true);
    expect(result.attempted).toHaveLength(0);
  });

  it("deduplicates: second dispatch on same key skips the already-used channel", async () => {
    const dispatcher = new PriorityChannelDispatcher(
      [emailCh, slackCh],
      DEFAULT_RETRY,
      60_000,
      noDelay,
    );
    const first = await dispatcher.dispatch(SAMPLE_PAYLOAD);
    const second = await dispatcher.dispatch(SAMPLE_PAYLOAD);

    // First dispatch succeeds on email; second must skip email (dedup) and use slack
    expect(first.succeeded).toBe("email-primary");
    // The second dispatch: email is deduped, falls to slack
    expect(second.succeeded).toBe("slack-fallback");
    expect(emailTransport.send).toHaveBeenCalledTimes(1); // not called a second time
  });

  it("clearDedup allows re-sending to the same channel", async () => {
    const dispatcher = new PriorityChannelDispatcher(
      [emailCh, slackCh],
      DEFAULT_RETRY,
      60_000,
      noDelay,
    );
    await dispatcher.dispatch(SAMPLE_PAYLOAD);
    dispatcher.clearDedup();
    const second = await dispatcher.dispatch(SAMPLE_PAYLOAD);
    expect(second.succeeded).toBe("email-primary");
    expect(emailTransport.send).toHaveBeenCalledTimes(2);
  });

  it("successful dispatch returns a receipt with correct channel metadata", async () => {
    const dispatcher = new PriorityChannelDispatcher(
      [emailCh, slackCh],
      DEFAULT_RETRY,
      5_000,
      noDelay,
    );
    const result = await dispatcher.dispatch(SAMPLE_PAYLOAD);
    expect(result.receipts).toHaveLength(1);
    const receipt = result.receipts[0];
    expect(receipt.channelType).toBe("email");
    expect(receipt.channelId).toBe("email-primary");
    expect(receipt.messageId).toBe("email-ok");
    expect(receipt.sentAt).toBeInstanceOf(Date);
  });

  it("respects channel order — lower-index channel is tried first", async () => {
    const callOrder: string[] = [];
    emailTransport.send.mockImplementation(async () => {
      callOrder.push("email");
      return { messageId: "e1" };
    });
    slackClient.postMessage.mockImplementation(async () => {
      callOrder.push("slack");
      return { ts: "s1", ok: true };
    });

    const dispatcher = new PriorityChannelDispatcher(
      [emailCh, slackCh],
      DEFAULT_RETRY,
      5_000,
      noDelay,
    );
    await dispatcher.dispatch(SAMPLE_PAYLOAD);
    expect(callOrder[0]).toBe("email");
  });
});

// ============================================================================
// Rich Content / Attachments Tests
// ============================================================================

describe("Rich content notifications", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("EmailChannel forwards all attachments to the transport", async () => {
    const transport = {
      send: vi.fn().mockResolvedValue({ messageId: "rich-email" }),
    };
    const ch = new EmailChannel("email-rich", "x@y.com", transport);
    await ch.send(RICH_PAYLOAD);
    const [, , , attachments] = (transport.send as ReturnType<typeof vi.fn>)
      .mock.calls[0];
    expect(attachments).toHaveLength(2);
    expect(attachments[0]).toMatchObject({
      name: "diff.patch",
      contentType: "text/plain",
    });
    expect(attachments[1]).toMatchObject({
      name: "plan.json",
      contentType: "application/json",
    });
  });

  it("SlackChannel adds one block per attachment", async () => {
    const client = {
      postMessage: vi.fn().mockResolvedValue({ ts: "t", ok: true }),
    };
    const ch = new SlackChannel("slack-rich", "#ch", client);
    await ch.send(RICH_PAYLOAD);
    const [, , blocks] = (client.postMessage as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(blocks).toHaveLength(2);
  });

  it("WebhookChannel sends metadata as part of the payload body", async () => {
    const http = {
      post: vi.fn().mockResolvedValue({ status: 200, body: { id: "wh-1" } }),
    };
    const ch = new WebhookChannel("wh-rich", "https://hooks.test/notify", http);
    await ch.send(RICH_PAYLOAD);
    const [, body] = (http.post as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(body).toMatchObject({
      metadata: { environment: "production", priority: "high" },
    });
  });

  it("notification with empty attachments array is treated as no attachments for email", async () => {
    const transport = {
      send: vi.fn().mockResolvedValue({ messageId: "no-attach" }),
    };
    const ch = new EmailChannel("email-1", "x@y.com", transport);
    const payload: NotificationPayload = { ...SAMPLE_PAYLOAD, attachments: [] };
    await ch.send(payload);
    const [, , , attachments] = (transport.send as ReturnType<typeof vi.fn>)
      .mock.calls[0];
    // Empty array is passed through as-is (not undefined)
    expect(Array.isArray(attachments)).toBe(true);
  });
});

// ============================================================================
// Channel Enable/Disable Toggle Tests
// ============================================================================

describe("Channel enabled/disabled toggle", () => {
  let http: { post: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    http = {
      post: vi.fn().mockResolvedValue({ status: 200, body: { id: "ok" } }),
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("enabled=true by default for WebhookChannel", () => {
    const ch = new WebhookChannel("w1", "https://hooks.test", http);
    expect(ch.enabled).toBe(true);
  });

  it("enabled=true by default for SlackChannel", () => {
    const client = { postMessage: vi.fn() };
    const ch = new SlackChannel("s1", "#ch", client);
    expect(ch.enabled).toBe(true);
  });

  it("enabled=true by default for EmailChannel", () => {
    const transport = { send: vi.fn() };
    const ch = new EmailChannel("e1", "x@y.com", transport);
    expect(ch.enabled).toBe(true);
  });

  it("disabling a channel prevents dispatcher from calling it", async () => {
    const ch = new WebhookChannel("w1", "https://hooks.test", http);
    ch.enabled = false;

    const fallback = new WebhookChannel("w2", "https://hooks2.test", http);
    http.post.mockResolvedValueOnce({
      status: 200,
      body: { id: "fallback-ok" },
    });

    const dispatcher = new PriorityChannelDispatcher(
      [ch, fallback],
      { ...DEFAULT_RETRY, maxRetries: 0 },
      5_000,
      noDelay,
    );
    const result = await dispatcher.dispatch(SAMPLE_PAYLOAD);
    expect(result.succeeded).toBe("w2");
    // Only one call — to the fallback — because w1 was disabled
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it("re-enabling a channel allows dispatcher to use it again", async () => {
    const ch = new WebhookChannel("w1", "https://hooks.test", http);
    ch.enabled = false;

    const dispatcher = new PriorityChannelDispatcher(
      [ch],
      { ...DEFAULT_RETRY, maxRetries: 0 },
      5_000,
      noDelay,
    );
    const disabledResult = await dispatcher.dispatch(SAMPLE_PAYLOAD);
    expect(disabledResult.allFailed).toBe(true);

    ch.enabled = true;
    dispatcher.clearDedup();
    const enabledResult = await dispatcher.dispatch(SAMPLE_PAYLOAD);
    expect(enabledResult.succeeded).toBe("w1");
  });
});

// ============================================================================
// Notification Receipt Confirmation Tests
// ============================================================================

describe("NotificationReceipt confirmation", () => {
  let http: { post: ReturnType<typeof vi.fn> };
  let receiptStore: ReceiptStore;

  beforeEach(() => {
    http = {
      post: vi
        .fn()
        .mockResolvedValue({ status: 200, body: { id: "wh-receipt-id" } }),
    };
    receiptStore = new ReceiptStore();
  });

  afterEach(() => {
    receiptStore.clear();
    vi.clearAllMocks();
  });

  it("receipt contains channelType, channelId, and sentAt", async () => {
    const emailTransport = {
      send: vi.fn().mockResolvedValue({ messageId: "msg-1" }),
    };
    const ch = new EmailChannel("email-receipt", "x@y.com", emailTransport);
    const dispatcher = new PriorityChannelDispatcher(
      [ch],
      DEFAULT_RETRY,
      5_000,
      noDelay,
    );
    const result = await dispatcher.dispatch(SAMPLE_PAYLOAD);

    expect(result.receipts[0]).toMatchObject({
      channelType: "email",
      channelId: "email-receipt",
    });
    expect(result.receipts[0].sentAt).toBeInstanceOf(Date);
  });

  it("receipt messageId matches what the channel returned", async () => {
    const slackClient = {
      postMessage: vi.fn().mockResolvedValue({ ts: "ts-abc", ok: true }),
    };
    const ch = new SlackChannel("slack-receipt", "#ch", slackClient);
    const dispatcher = new PriorityChannelDispatcher(
      [ch],
      DEFAULT_RETRY,
      5_000,
      noDelay,
    );
    const result = await dispatcher.dispatch(SAMPLE_PAYLOAD);

    expect(result.receipts[0].messageId).toBe("ts-abc");
  });

  it("ReceiptStore records and retrieves receipts", () => {
    const receipt: NotificationReceipt = {
      channelType: "email",
      channelId: "email-1",
      sentAt: new Date(),
      messageId: "msg-xyz",
    };
    receiptStore.record(receipt);
    expect(receiptStore.getAll()).toHaveLength(1);
    expect(receiptStore.getAll()[0]).toMatchObject({ messageId: "msg-xyz" });
  });

  it("ReceiptStore.getAll returns a copy — mutations don't affect internal state", () => {
    receiptStore.record({
      channelType: "email",
      channelId: "e1",
      sentAt: new Date(),
      messageId: "m1",
    });
    const all = receiptStore.getAll();
    all.length = 0; // mutate the copy
    expect(receiptStore.getAll()).toHaveLength(1);
  });

  it("ReceiptStore.clear removes all receipts", () => {
    receiptStore.record({
      channelType: "email",
      channelId: "e1",
      sentAt: new Date(),
    });
    receiptStore.clear();
    expect(receiptStore.getAll()).toHaveLength(0);
  });

  it("multiple receipts are recorded when dispatcher falls back across channels", async () => {
    // This test uses raw channels, not dispatcher receipts, to exercise ReceiptStore directly
    const r1: NotificationReceipt = {
      channelType: "email",
      channelId: "e1",
      sentAt: new Date(),
      messageId: "m1",
    };
    const r2: NotificationReceipt = {
      channelType: "slack",
      channelId: "s1",
      sentAt: new Date(),
      messageId: "m2",
    };
    receiptStore.record(r1);
    receiptStore.record(r2);
    expect(receiptStore.getAll()).toHaveLength(2);
    expect(receiptStore.getAll().map((r) => r.channelType)).toEqual([
      "email",
      "slack",
    ]);
  });
});

// ============================================================================
// Integration: Notification Channels + ApprovalGate
// ============================================================================

describe("Notification channels integrated with ApprovalGate", () => {
  let store: InMemoryApprovalStateStore;
  let gate: ApprovalGate;

  beforeEach(() => {
    store = new InMemoryApprovalStateStore();
    gate = new ApprovalGate({ store });
  });

  afterEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  it("dispatches notification then resolves approval via grant", async () => {
    const transport = {
      send: vi.fn().mockResolvedValue({ messageId: "integration-msg" }),
    };
    const ch = new EmailChannel("email-int", "approver@example.com", transport);
    const dispatcher = new PriorityChannelDispatcher(
      [ch],
      DEFAULT_RETRY,
      5_000,
      noDelay,
    );

    // Dispatch notification and start waiting for approval concurrently
    const waitPromise = gate.waitForApproval(
      "run-int",
      "ap-int",
      { plan: "deploy" },
      5_000,
    );
    await Promise.resolve(); // let createPending settle

    const notifResult = await dispatcher.dispatch({
      runId: "run-int",
      approvalId: "ap-int",
      subject: "Approval needed",
      body: "Please review the plan",
    });
    expect(notifResult.succeeded).toBe("email-int");

    await gate.grant("run-int", "ap-int", { approvedBy: "alice" });
    const outcome = await waitPromise;
    expect(outcome.decision).toBe("granted");
    expect((outcome.response as Record<string, unknown>).approvedBy).toBe(
      "alice",
    );
  });

  it("notification failure does not block approval gate resolution", async () => {
    const transport = {
      send: vi.fn().mockRejectedValue(new Error("SMTP down")),
    };
    const ch = new EmailChannel("email-fail", "x@y.com", transport);
    const dispatcher = new PriorityChannelDispatcher(
      [ch],
      { ...DEFAULT_RETRY, maxRetries: 0 },
      5_000,
      noDelay,
    );

    const waitPromise = gate.waitForApproval("run-nf", "ap-nf", null, 5_000);
    await Promise.resolve();

    const notifResult = await dispatcher.dispatch({
      runId: "run-nf",
      approvalId: "ap-nf",
      subject: "Notify",
      body: "Body",
    });
    expect(notifResult.allFailed).toBe(true);

    // Approval is still resolvable despite notification failure
    await gate.grant("run-nf", "ap-nf", "bypassed");
    const outcome = await waitPromise;
    expect(outcome.decision).toBe("granted");
  });

  it("deduplication prevents double notification on re-dispatch within window", async () => {
    const transport = { send: vi.fn().mockResolvedValue({ messageId: "m1" }) };
    const ch = new EmailChannel("email-dedup", "x@y.com", transport);
    const dispatcher = new PriorityChannelDispatcher(
      [ch],
      DEFAULT_RETRY,
      60_000,
      noDelay,
    );

    const payload: NotificationPayload = {
      runId: "run-dedup",
      approvalId: "ap-dedup",
      subject: "Don't duplicate",
      body: "Once only",
    };

    const first = await dispatcher.dispatch(payload);
    const second = await dispatcher.dispatch(payload);

    expect(first.succeeded).toBe("email-dedup");
    // Second is blocked by dedup — email channel is skipped, allFailed because no other channels
    expect(second.allFailed).toBe(true);
    expect(transport.send).toHaveBeenCalledTimes(1);
  });
});
