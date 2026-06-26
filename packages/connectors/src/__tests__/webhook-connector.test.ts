/**
 * Webhook connector tests — comprehensive coverage of inbound webhook parsing,
 * signature verification, event routing, retry delivery, and idempotency.
 *
 * All HTTP calls are mocked — no real network requests are made.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  WebhookConnector,
  createWebhookConnector,
  buildSignatureHeader,
  WebhookSignatureError,
  WebhookParseError,
} from "../webhook/webhook-connector.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SECRET = "test-secret-abc123";

function makeBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "evt-001",
    type: "push",
    payload: { ref: "main" },
    ...overrides,
  });
}

function makeRequest(
  body: string,
  extraHeaders: Record<string, string> = {}
): { body: string; headers: Record<string, string> } {
  return {
    body,
    headers: { "content-type": "application/json", ...extraHeaders },
  };
}

function signedRequest(
  body: string,
  secret = SECRET,
  extraHeaders: Record<string, string> = {}
) {
  return makeRequest(body, {
    "x-hub-signature-256": buildSignatureHeader(secret, body),
    ...extraHeaders,
  });
}

function mockFetchOk(status = 200) {
  const mock = vi.fn().mockResolvedValue({ ok: true, status });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function mockFetchFail(message = "Network error") {
  const mock = vi.fn().mockRejectedValue(new Error(message));
  vi.stubGlobal("fetch", mock);
  return mock;
}

function mockFetchSequence(
  responses: Array<{ ok: boolean; status?: number } | Error>
) {
  let call = 0;
  const mock = vi.fn().mockImplementation(async () => {
    const r = responses[call] ?? responses[responses.length - 1]!;
    call++;
    if (r instanceof Error) throw r;
    return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 500) };
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("WebhookConnector", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Factory
  // -------------------------------------------------------------------------

  describe("createWebhookConnector", () => {
    it("returns a WebhookConnector instance", () => {
      const connector = createWebhookConnector();
      expect(connector).toBeInstanceOf(WebhookConnector);
    });

    it("accepts config options without throwing", () => {
      expect(() =>
        createWebhookConnector({
          secret: SECRET,
          eventTypeHeader: "x-my-event",
          eventTypeBodyField: "eventName",
          eventIdBodyField: "uid",
        })
      ).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Inbound parsing — body
  // -------------------------------------------------------------------------

  describe("parse — body parsing", () => {
    it("parses raw JSON body into a structured event", () => {
      const connector = createWebhookConnector();
      const body = makeBody();
      const event = connector.parse(makeRequest(body));
      expect(event).toMatchObject({ id: "evt-001", type: "push" });
    });

    it("extracts event type from body field", () => {
      const connector = createWebhookConnector();
      const body = makeBody({ type: "pull_request.opened" });
      const event = connector.parse(makeRequest(body));
      expect(event.type).toBe("pull_request.opened");
    });

    it("extracts event payload from body", () => {
      const connector = createWebhookConnector();
      const body = makeBody({ payload: { ref: "main", sha: "abc123" } });
      const event = connector.parse(makeRequest(body));
      expect(event.payload).toMatchObject({ ref: "main", sha: "abc123" });
    });

    it("extracts event id from body", () => {
      const connector = createWebhookConnector();
      const body = makeBody({ id: "unique-event-42" });
      const event = connector.parse(makeRequest(body));
      expect(event.id).toBe("unique-event-42");
    });

    it("falls back to auto-generated id when body has no id field", () => {
      const connector = createWebhookConnector();
      const body = JSON.stringify({ type: "ping" });
      const event = connector.parse(makeRequest(body));
      expect(event.id).toBeTruthy();
      expect(event.id).toMatch(/^auto-/);
    });

    it("falls back to 'unknown' event type when neither header nor body type present", () => {
      const connector = createWebhookConnector();
      const body = JSON.stringify({ id: "e1" });
      const event = connector.parse(makeRequest(body));
      expect(event.type).toBe("unknown");
    });

    it("throws WebhookParseError on invalid JSON body", () => {
      const connector = createWebhookConnector();
      expect(() => connector.parse(makeRequest("not-json"))).toThrow(
        WebhookParseError
      );
    });

    it("attaches normalized headers to the parsed event", () => {
      const connector = createWebhookConnector();
      const body = makeBody();
      const event = connector.parse(
        makeRequest(body, { "X-Custom-Header": "value" })
      );
      expect(event.headers["x-custom-header"]).toBe("value");
    });
  });

  // -------------------------------------------------------------------------
  // Event type extraction — header takes priority
  // -------------------------------------------------------------------------

  describe("parse — event type extraction", () => {
    it("prefers event type from header over body field", () => {
      const connector = createWebhookConnector();
      const body = makeBody({ type: "body-type" });
      const event = connector.parse(
        makeRequest(body, { "x-event-type": "header-type" })
      );
      expect(event.type).toBe("header-type");
    });

    it("reads custom eventTypeHeader from config", () => {
      const connector = createWebhookConnector({
        eventTypeHeader: "x-gh-event",
      });
      const body = makeBody({ type: "body-type" });
      const event = connector.parse(
        makeRequest(body, { "x-gh-event": "release" })
      );
      expect(event.type).toBe("release");
    });

    it("reads custom eventTypeBodyField from config", () => {
      const connector = createWebhookConnector({
        eventTypeBodyField: "eventName",
      });
      const body = JSON.stringify({
        id: "e1",
        eventName: "deployment.created",
      });
      const event = connector.parse(makeRequest(body));
      expect(event.type).toBe("deployment.created");
    });

    it("supports dot-notation body field path", () => {
      const connector = createWebhookConnector({
        eventTypeBodyField: "meta.kind",
      });
      const body = JSON.stringify({ id: "e1", meta: { kind: "alert" } });
      const event = connector.parse(makeRequest(body));
      expect(event.type).toBe("alert");
    });
  });

  // -------------------------------------------------------------------------
  // Signature verification
  // -------------------------------------------------------------------------

  describe("verifySignature — valid", () => {
    it("accepts a request with a correct HMAC-SHA-256 signature", () => {
      const connector = createWebhookConnector({ secret: SECRET });
      const body = makeBody();
      const req = signedRequest(body);
      expect(() => connector.verifySignature(body, req.headers)).not.toThrow();
    });

    it("accepts signature provided without sha256= prefix", () => {
      const connector = createWebhookConnector({ secret: SECRET });
      const body = makeBody();
      const rawSig = buildSignatureHeader(SECRET, body).replace("sha256=", "");
      expect(() =>
        connector.verifySignature(body, { "x-hub-signature-256": rawSig })
      ).not.toThrow();
    });

    it("accepts uppercase header key", () => {
      const connector = createWebhookConnector({ secret: SECRET });
      const body = makeBody();
      const sig = buildSignatureHeader(SECRET, body);
      expect(() =>
        connector.verifySignature(body, { "X-Hub-Signature-256": sig })
      ).not.toThrow();
    });
  });

  describe("verifySignature — invalid", () => {
    it("rejects a request with an incorrect signature", () => {
      const connector = createWebhookConnector({ secret: SECRET });
      const body = makeBody();
      expect(() =>
        connector.verifySignature(body, {
          "x-hub-signature-256": "sha256=deadbeef",
        })
      ).toThrow(WebhookSignatureError);
    });

    it("error message describes the rejection reason", () => {
      const connector = createWebhookConnector({ secret: SECRET });
      const body = makeBody();
      expect(() =>
        connector.verifySignature(body, {
          "x-hub-signature-256": "sha256=deadbeef",
        })
      ).toThrow(/mismatch/);
    });
  });

  describe("verifySignature — missing", () => {
    it("rejects when signature header is absent and secret is configured", () => {
      const connector = createWebhookConnector({ secret: SECRET });
      const body = makeBody();
      expect(() => connector.verifySignature(body, {})).toThrow(
        WebhookSignatureError
      );
    });

    it("error message mentions missing header", () => {
      const connector = createWebhookConnector({ secret: SECRET });
      expect(() => connector.verifySignature(makeBody(), {})).toThrow(
        /Missing/
      );
    });

    it("skips verification when no secret is configured", () => {
      const connector = createWebhookConnector();
      expect(() => connector.verifySignature(makeBody(), {})).not.toThrow();
    });
  });

  describe("signature algorithm", () => {
    it("uses SHA-256 HMAC: changing one byte invalidates the signature", () => {
      const connector = createWebhookConnector({ secret: SECRET });
      const body = makeBody();
      const tampered = body + " ";
      const sig = buildSignatureHeader(SECRET, body);
      expect(() =>
        connector.verifySignature(tampered, { "x-hub-signature-256": sig })
      ).toThrow(WebhookSignatureError);
    });

    it("buildSignatureHeader produces sha256= prefixed string", () => {
      const sig = buildSignatureHeader(SECRET, "hello");
      expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    });
  });

  // -------------------------------------------------------------------------
  // parse + verifySignature integration
  // -------------------------------------------------------------------------

  describe("parse — signature verification integrated", () => {
    it("rejects parse when signature is invalid", () => {
      const connector = createWebhookConnector({ secret: SECRET });
      const body = makeBody();
      expect(() =>
        connector.parse(
          makeRequest(body, { "x-hub-signature-256": "sha256=bad" })
        )
      ).toThrow(WebhookSignatureError);
    });

    it("accepts parse when signature is valid", () => {
      const connector = createWebhookConnector({ secret: SECRET });
      const body = makeBody();
      const event = connector.parse(signedRequest(body));
      expect(event.type).toBe("push");
    });
  });

  // -------------------------------------------------------------------------
  // Event routing
  // -------------------------------------------------------------------------

  describe("route — event routing", () => {
    it("invokes the registered handler for the matching event type", async () => {
      const connector = createWebhookConnector();
      const handler = vi.fn();
      connector.on("push", handler);

      const body = makeBody({ type: "push" });
      const event = connector.parse(makeRequest(body));
      await connector.route(event);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(event);
    });

    it("does not invoke handler for a different event type", async () => {
      const connector = createWebhookConnector();
      const handler = vi.fn();
      connector.on("push", handler);

      const body = makeBody({ type: "release" });
      const event = connector.parse(makeRequest(body));
      await connector.route(event);

      expect(handler).not.toHaveBeenCalled();
    });

    it("handles unknown event type gracefully (returns empty errors, no throw)", async () => {
      const connector = createWebhookConnector();
      const body = makeBody({ type: "unknown-type-xyz" });
      const event = connector.parse(makeRequest(body));
      await expect(connector.route(event)).resolves.toEqual([]);
    });

    it("invokes all handlers when multiple handlers registered for same type", async () => {
      const connector = createWebhookConnector();
      const h1 = vi.fn();
      const h2 = vi.fn();
      const h3 = vi.fn();
      connector.on("push", h1).on("push", h2).on("push", h3);

      const body = makeBody({ type: "push" });
      const event = connector.parse(makeRequest(body));
      await connector.route(event);

      expect(h1).toHaveBeenCalledOnce();
      expect(h2).toHaveBeenCalledOnce();
      expect(h3).toHaveBeenCalledOnce();
    });

    it("handler error does not prevent other handlers from firing", async () => {
      const connector = createWebhookConnector();
      const failing = vi.fn().mockRejectedValue(new Error("handler boom"));
      const succeeding = vi.fn();
      connector.on("push", failing).on("push", succeeding);

      const body = makeBody({ type: "push" });
      const event = connector.parse(makeRequest(body));
      const errors = await connector.route(event);

      expect(succeeding).toHaveBeenCalledOnce();
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toBe("handler boom");
    });

    it("returns collected errors from all failing handlers", async () => {
      const connector = createWebhookConnector();
      connector.on("push", vi.fn().mockRejectedValue(new Error("err-A")));
      connector.on("push", vi.fn().mockRejectedValue(new Error("err-B")));

      const body = makeBody({ type: "push" });
      const event = connector.parse(makeRequest(body));
      const errors = await connector.route(event);

      expect(errors).toHaveLength(2);
      const messages = errors.map((e) => e.message).sort();
      expect(messages).toEqual(["err-A", "err-B"]);
    });

    it("supports chained .on() calls (fluent API)", () => {
      const connector = createWebhookConnector();
      const result = connector.on("push", vi.fn()).on("release", vi.fn());
      expect(result).toBe(connector);
    });
  });

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  describe("processOnce — idempotency", () => {
    it("processes an event on the first occurrence", async () => {
      const connector = createWebhookConnector();
      const handler = vi.fn();
      connector.on("push", handler);

      const body = makeBody({ id: "evt-dup-001", type: "push" });
      const event = connector.parse(makeRequest(body));
      const processed = await connector.processOnce(event);

      expect(processed).toBe(true);
      expect(handler).toHaveBeenCalledOnce();
    });

    it("does not re-process duplicate webhook with same event ID", async () => {
      const connector = createWebhookConnector();
      const handler = vi.fn();
      connector.on("push", handler);

      const body = makeBody({ id: "evt-dup-002", type: "push" });
      const event = connector.parse(makeRequest(body));

      await connector.processOnce(event);
      const secondResult = await connector.processOnce(event);

      expect(secondResult).toBe(false);
      expect(handler).toHaveBeenCalledOnce();
    });

    it("processes distinct event IDs independently", async () => {
      const connector = createWebhookConnector();
      const handler = vi.fn();
      connector.on("push", handler);

      const bodyA = makeBody({ id: "evt-A", type: "push" });
      const bodyB = makeBody({ id: "evt-B", type: "push" });
      const evtA = connector.parse(makeRequest(bodyA));
      const evtB = connector.parse(makeRequest(bodyB));

      await connector.processOnce(evtA);
      await connector.processOnce(evtB);

      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // Retry delivery
  // -------------------------------------------------------------------------

  describe("deliver — success on first attempt", () => {
    it("returns success when the remote endpoint responds 200", async () => {
      mockFetchOk(200);
      const connector = createWebhookConnector();
      const result = await connector.deliver("https://example.com/webhook", {
        event: "push",
      });
      expect(result.success).toBe(true);
      expect(result.attempts).toBe(1);
    });

    it("sends a POST request with JSON body", async () => {
      const mock = mockFetchOk();
      const connector = createWebhookConnector();
      await connector.deliver("https://example.com/hook", { key: "value" });

      expect(mock).toHaveBeenCalledWith(
        "https://example.com/hook",
        expect.objectContaining({ method: "POST" })
      );
      const init = mock.mock.calls[0]![1] as RequestInit;
      expect(init.body).toBe(JSON.stringify({ key: "value" }));
    });

    it("includes Content-Type application/json header", async () => {
      const mock = mockFetchOk();
      const connector = createWebhookConnector();
      await connector.deliver("https://example.com/hook", {});

      const init = mock.mock.calls[0]![1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
    });

    it("attaches X-Hub-Signature-256 header when secret is configured", async () => {
      const mock = mockFetchOk();
      const connector = createWebhookConnector({ secret: SECRET });
      await connector.deliver("https://example.com/hook", { x: 1 });

      const init = mock.mock.calls[0]![1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers["X-Hub-Signature-256"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    });
  });

  describe("deliver — retry on failure", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it("retries up to maxAttempts when server returns non-ok status", async () => {
      const mock = mockFetchSequence([
        { ok: false, status: 500 },
        { ok: false, status: 500 },
        { ok: true, status: 200 },
      ]);
      const connector = createWebhookConnector();
      const promise = connector.deliver(
        "https://example.com/hook",
        {},
        { maxAttempts: 3, initialDelayMs: 10, backoffMultiplier: 2 }
      );
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(3);
      expect(mock).toHaveBeenCalledTimes(3);
    });

    it("retries when fetch throws a network error", async () => {
      const mock = mockFetchSequence([
        new Error("ECONNREFUSED"),
        new Error("ECONNREFUSED"),
        { ok: true },
      ]);
      const connector = createWebhookConnector();
      const promise = connector.deliver(
        "https://example.com/hook",
        {},
        { maxAttempts: 3, initialDelayMs: 10, backoffMultiplier: 2 }
      );
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.success).toBe(true);
      expect(mock).toHaveBeenCalledTimes(3);
    });
  });

  describe("deliver — retry exhaustion", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it("returns failure after all attempts are exhausted", async () => {
      mockFetchSequence([
        { ok: false, status: 503 },
        { ok: false, status: 503 },
        { ok: false, status: 503 },
      ]);
      const connector = createWebhookConnector();
      const promise = connector.deliver(
        "https://example.com/hook",
        {},
        { maxAttempts: 3, initialDelayMs: 10, backoffMultiplier: 2 }
      );
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(3);
    });

    it("includes lastError in the result on exhaustion", async () => {
      mockFetchSequence([
        { ok: false, status: 503 },
        { ok: false, status: 503 },
      ]);
      const connector = createWebhookConnector();
      const promise = connector.deliver(
        "https://example.com/hook",
        {},
        { maxAttempts: 2, initialDelayMs: 10, backoffMultiplier: 2 }
      );
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.lastError).toBeTruthy();
    });

    it("includes lastError when fetch throws on every attempt", async () => {
      mockFetchFail("connection refused");
      const connector = createWebhookConnector();
      const promise = connector.deliver(
        "https://example.com/hook",
        {},
        { maxAttempts: 2, initialDelayMs: 10, backoffMultiplier: 2 }
      );
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.lastError).toContain("connection refused");
    });
  });

  describe("deliver — retry backoff", () => {
    it("delays between retries using setTimeoutSpy", async () => {
      vi.useFakeTimers();
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

      mockFetchSequence([
        { ok: false, status: 500 },
        { ok: false, status: 500 },
        { ok: true },
      ]);
      const connector = createWebhookConnector();
      const promise = connector.deliver(
        "https://example.com/hook",
        {},
        { maxAttempts: 3, initialDelayMs: 50, backoffMultiplier: 3 }
      );
      await vi.runAllTimersAsync();
      await promise;

      const delays = setTimeoutSpy.mock.calls
        .filter((c) => typeof c[1] === "number" && (c[1] as number) > 0)
        .map((c) => c[1] as number);

      // First delay should be ~50ms, second ~150ms (50 * 3).
      expect(delays.length).toBeGreaterThanOrEqual(2);
      expect(delays[0]).toBe(50);
      expect(delays[1]).toBe(150);

      vi.restoreAllMocks();
      vi.useRealTimers();
    });
  });

  // -------------------------------------------------------------------------
  // Error class identity
  // -------------------------------------------------------------------------

  describe("error types", () => {
    it("WebhookSignatureError has correct name", () => {
      const err = new WebhookSignatureError("test");
      expect(err.name).toBe("WebhookSignatureError");
      expect(err).toBeInstanceOf(Error);
    });

    it("WebhookParseError has correct name", () => {
      const err = new WebhookParseError("test");
      expect(err.name).toBe("WebhookParseError");
      expect(err).toBeInstanceOf(Error);
    });
  });
});
