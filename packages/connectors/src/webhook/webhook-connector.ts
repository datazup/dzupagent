/**
 * Webhook connector — inbound webhook parsing, signature verification,
 * event routing, and retry delivery.
 *
 * The connector operates in two distinct modes:
 *  1. Receiver mode: parse incoming HTTP requests, verify signatures, route events.
 *  2. Sender mode: deliver webhook payloads to remote endpoints with retry logic.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WebhookEvent {
  /** Unique identifier for idempotency tracking. */
  id: string;
  /** Discriminated event type (e.g. "push", "pull_request.opened"). */
  type: string;
  /** Arbitrary event payload. */
  payload: Record<string, unknown>;
  /** Raw HTTP headers from the inbound request. */
  headers: Record<string, string>;
}

export interface ParsedWebhookRequest {
  /** Raw body string (JSON). */
  body: string;
  /** HTTP headers (lowercased keys). */
  headers: Record<string, string>;
}

export interface WebhookHandlerFn {
  (event: WebhookEvent): Promise<void> | void;
}

export interface WebhookConnectorConfig {
  /**
   * HMAC secret used for signature verification.
   * When set, the connector enforces that every inbound request carries a valid
   * X-Hub-Signature-256 header.
   */
  secret?: string;
  /**
   * Header name that carries the event type.
   * Defaults to "x-event-type".
   */
  eventTypeHeader?: string;
  /**
   * JSON path (dot-notation) inside the body used to extract the event type
   * when no eventTypeHeader is present.
   * Defaults to "type".
   */
  eventTypeBodyField?: string;
  /**
   * JSON path inside the body used to extract the idempotency event ID.
   * Defaults to "id".
   */
  eventIdBodyField?: string;
}

export interface DeliveryOptions {
  /** Maximum number of delivery attempts (including the first). Default: 3. */
  maxAttempts?: number;
  /** Initial delay in ms before the first retry. Default: 100. */
  initialDelayMs?: number;
  /** Multiplier applied to the delay on each subsequent attempt. Default: 2. */
  backoffMultiplier?: number;
}

export interface DeliveryResult {
  success: boolean;
  attempts: number;
  lastError?: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class WebhookSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

export class WebhookParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookParseError";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getNestedField(
  obj: Record<string, unknown>,
  dotPath: string
): unknown {
  return dotPath.split(".").reduce<unknown>((cur, key) => {
    if (cur != null && typeof cur === "object" && key in (cur as object)) {
      return (cur as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

function computeHmacSha256(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// WebhookConnector
// ---------------------------------------------------------------------------

export class WebhookConnector {
  private readonly config: Required<
    Pick<
      WebhookConnectorConfig,
      "eventTypeHeader" | "eventTypeBodyField" | "eventIdBodyField"
    >
  > & { secret?: string };

  private readonly handlers: Map<string, WebhookHandlerFn[]> = new Map();
  private readonly processedIds: Set<string> = new Set();

  constructor(config: WebhookConnectorConfig = {}) {
    this.config = {
      secret: config.secret,
      eventTypeHeader: config.eventTypeHeader ?? "x-event-type",
      eventTypeBodyField: config.eventTypeBodyField ?? "type",
      eventIdBodyField: config.eventIdBodyField ?? "id",
    };
  }

  // -------------------------------------------------------------------------
  // Signature verification
  // -------------------------------------------------------------------------

  /**
   * Verify the HMAC-SHA-256 signature of a raw request body.
   * The expected header is `x-hub-signature-256` with format `sha256=<hex>`.
   *
   * @throws {WebhookSignatureError} when signature is missing or invalid.
   */
  verifySignature(body: string, headers: Record<string, string>): void {
    if (!this.config.secret) return;

    const sigHeader =
      headers["x-hub-signature-256"] ?? headers["X-Hub-Signature-256"];

    if (!sigHeader) {
      throw new WebhookSignatureError(
        "Missing X-Hub-Signature-256 header — signature verification required."
      );
    }

    const provided = sigHeader.startsWith("sha256=")
      ? sigHeader.slice(7)
      : sigHeader;

    const expected = computeHmacSha256(this.config.secret, body);

    const providedBuf = Buffer.from(provided, "hex");
    const expectedBuf = Buffer.from(expected, "hex");

    if (
      providedBuf.length !== expectedBuf.length ||
      !timingSafeEqual(providedBuf, expectedBuf)
    ) {
      throw new WebhookSignatureError(
        "X-Hub-Signature-256 mismatch — request rejected."
      );
    }
  }

  // -------------------------------------------------------------------------
  // Parsing
  // -------------------------------------------------------------------------

  /**
   * Parse an inbound HTTP request into a structured WebhookEvent.
   * Optionally verifies the signature when a secret is configured.
   *
   * @throws {WebhookParseError} when the body is not valid JSON.
   * @throws {WebhookSignatureError} when signature verification fails.
   */
  parse(request: ParsedWebhookRequest): WebhookEvent {
    this.verifySignature(request.body, request.headers);

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(request.body) as Record<string, unknown>;
    } catch {
      throw new WebhookParseError("Webhook body is not valid JSON.");
    }

    const normalizedHeaders = Object.fromEntries(
      Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), v])
    );

    const eventType =
      normalizedHeaders[this.config.eventTypeHeader] ??
      (getNestedField(body, this.config.eventTypeBodyField) as
        | string
        | undefined) ??
      "unknown";

    const eventId =
      (getNestedField(body, this.config.eventIdBodyField) as
        | string
        | undefined) ??
      `auto-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const payload = (body.payload as Record<string, unknown>) ?? body;

    return {
      id: eventId,
      type: eventType,
      payload,
      headers: normalizedHeaders,
    };
  }

  // -------------------------------------------------------------------------
  // Event routing
  // -------------------------------------------------------------------------

  /**
   * Register a handler for a specific event type.
   * Multiple handlers for the same type are all invoked (fan-out).
   */
  on(eventType: string, handler: WebhookHandlerFn): this {
    const list = this.handlers.get(eventType) ?? [];
    list.push(handler);
    this.handlers.set(eventType, list);
    return this;
  }

  /**
   * Route a parsed event to all registered handlers.
   * Handler errors are isolated — a failing handler does not prevent others.
   * Returns an array of errors from failed handlers (empty if all succeeded).
   */
  async route(event: WebhookEvent): Promise<Error[]> {
    const handlers = this.handlers.get(event.type) ?? [];
    const errors: Error[] = [];

    await Promise.allSettled(
      handlers.map(async (h) => {
        try {
          await h(event);
        } catch (err) {
          errors.push(err instanceof Error ? err : new Error(String(err)));
        }
      })
    );

    return errors;
  }

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  /**
   * Process an event exactly once by event ID.
   * Returns true if the event was processed, false if it was a duplicate.
   */
  async processOnce(event: WebhookEvent): Promise<boolean> {
    if (this.processedIds.has(event.id)) {
      return false;
    }
    this.processedIds.add(event.id);
    await this.route(event);
    return true;
  }

  // -------------------------------------------------------------------------
  // Delivery (outbound)
  // -------------------------------------------------------------------------

  /**
   * Deliver a webhook payload to a remote URL with configurable retry logic.
   *
   * Uses exponential backoff between attempts.
   */
  async deliver(
    url: string,
    payload: Record<string, unknown>,
    options: DeliveryOptions = {}
  ): Promise<DeliveryResult> {
    const maxAttempts = options.maxAttempts ?? 3;
    const initialDelayMs = options.initialDelayMs ?? 100;
    const backoffMultiplier = options.backoffMultiplier ?? 2;

    let lastError: string | undefined;
    let delayMs = initialDelayMs;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const body = JSON.stringify(payload);
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };

        if (this.config.secret) {
          const sig = computeHmacSha256(this.config.secret, body);
          headers["X-Hub-Signature-256"] = `sha256=${sig}`;
        }

        const response = await fetch(url, {
          method: "POST",
          headers,
          body,
        });

        if (!response.ok) {
          lastError = `HTTP ${response.status}`;
          if (attempt < maxAttempts) {
            await sleep(delayMs);
            delayMs *= backoffMultiplier;
            continue;
          }
          return { success: false, attempts: attempt, lastError };
        }

        return { success: true, attempts: attempt };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt < maxAttempts) {
          await sleep(delayMs);
          delayMs *= backoffMultiplier;
        }
      }
    }

    return { success: false, attempts: maxAttempts, lastError };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWebhookConnector(
  config: WebhookConnectorConfig = {}
): WebhookConnector {
  return new WebhookConnector(config);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a valid X-Hub-Signature-256 header value for a given secret + body.
 * Useful in tests and client tooling.
 */
export function buildSignatureHeader(secret: string, body: string): string {
  return `sha256=${computeHmacSha256(secret, body)}`;
}
