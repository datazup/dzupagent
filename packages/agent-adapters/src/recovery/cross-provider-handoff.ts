/**
 * CrossProviderHandoff — packages partial execution context from a failed
 * provider so the fallback provider can continue the work intelligently.
 *
 * Problem: When `AdapterRecoveryCopilot` switches to a fallback provider,
 * the new provider receives only the original bare prompt with no knowledge
 * of what the failed provider already accomplished.
 *
 * Solution: This module extracts the meaningful partial output from the
 * failed provider's event stream and serialises it into a context block that
 * can be prepended to the fallback request's system prompt.
 *
 * Usage:
 *   const handoff = new CrossProviderHandoff()
 *   for await (const evt of failedAdapter.execute(input)) {
 *     handoff.recordEvent(evt)
 *   }
 *   const context = handoff.buildHandoffContext()
 *   if (context) {
 *     fallbackInput = {
 *       ...originalInput,
 *       systemPrompt: context + (originalInput.systemPrompt ?? ''),
 *     }
 *   }
 *
 * Or use the helper directly:
 *   const fallbackInput = CrossProviderHandoff.enrichInput(originalInput, partialEvents)
 */

import { PiiDetector } from "@dzupagent/security";
import type { AgentEvent, AgentInput } from "../types.js";

// ---------------------------------------------------------------------------
// Sanitization constants (AGENT-M-07)
// ---------------------------------------------------------------------------

/**
 * Maximum bytes captured per handoff item. A single huge tool result would
 * otherwise flood the fallback provider's system prompt (cost + context
 * overflow). ~4KB ≈ ~1000 tokens per item. Content beyond this is truncated
 * with an explicit `…[truncated N bytes]` marker.
 */
const MAX_ITEM_BYTES = 4096;

/**
 * Canonical secret/PII redactor. `@dzupagent/security`'s `PiiDetector`
 * (already a direct dependency of this package) covers `sk-…`, JWTs, generic
 * `api-key`/`token`/`secret`-prefixed values, emails, SSNs, cards, etc. via
 * `[REDACTED-<TAG>]` markers.
 */
const piiDetector = new PiiDetector();

/**
 * Supplemental secret shapes the security `PiiDetector` does not cover.
 * Kept in sync with the canonical superset in
 * `packages/memory/src/write-policy.ts` (`SECRET_PATTERNS`) — memory is NOT a
 * dependency of agent-adapters, so these few patterns are mirrored locally
 * rather than imported. If the canonical list grows, mirror it here.
 */
const SUPPLEMENTAL_SECRET_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  tag: string;
}> = [
  // github personal access token (ghp_… / gho_… / ghs_… etc.)
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, tag: "GITHUB-TOKEN" },
  // `api_key = "…"` / `secret-key: …` assignment forms with a long value
  {
    pattern:
      /(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token)\s*[:=]\s*['"]?[A-Za-z0-9_\-/.]{20,}/gi,
    tag: "SECRET-ASSIGNMENT",
  },
  // PEM private key headers
  {
    pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g,
    tag: "PRIVATE-KEY",
  },
];

/**
 * Redact secret-like values from captured content before it is folded into
 * the fallback provider's prompt. Runs the canonical `PiiDetector` first, then
 * the supplemental patterns above.
 */
function redactSecrets(text: string): string {
  let out = piiDetector.sanitize(text);
  for (const { pattern, tag } of SUPPLEMENTAL_SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, `[REDACTED-${tag}]`);
  }
  return out;
}

/**
 * Cap a captured item's content to {@link MAX_ITEM_BYTES}, appending an
 * explicit marker recording how many bytes were dropped.
 */
function capBytes(text: string): string {
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength <= MAX_ITEM_BYTES) return text;
  // Truncate on a UTF-8 byte boundary, then note the dropped byte count.
  const buf = Buffer.from(text, "utf8");
  let end = MAX_ITEM_BYTES;
  // Back off so we do not split a multi-byte character (continuation bytes
  // have the form 10xxxxxx == 0x80..0xBF).
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  const head = buf.subarray(0, end).toString("utf8");
  const dropped = byteLength - Buffer.byteLength(head, "utf8");
  return `${head}…[truncated ${dropped} bytes]`;
}

/**
 * Sanitize a captured content string: redact secrets first (so truncation can
 * never split a redaction marker mid-token), then cap its size.
 */
function sanitizeContent(text: string): string {
  return capBytes(redactSecrets(text));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single captured item extracted from a partial event sequence. */
export interface HandoffItem {
  kind: "message" | "tool_call" | "tool_result";
  content: string;
  /** Tool name, present for tool_call and tool_result items. */
  toolName?: string;
}

export interface CrossProviderHandoffOptions {
  /**
   * Header placed at the top of the handoff context block.
   * Defaults to `## Partial progress from previous provider\n`.
   */
  header?: string;

  /**
   * Footer / instruction appended after the captured items.
   * Defaults to a one-liner asking the model to continue.
   */
  footer?: string;

  /**
   * Maximum number of items to include (newest last, oldest truncated).
   * Defaults to 20.
   */
  maxItems?: number;
}

// ---------------------------------------------------------------------------
// CrossProviderHandoff
// ---------------------------------------------------------------------------

export class CrossProviderHandoff {
  private readonly items: HandoffItem[] = [];
  private readonly opts: Required<CrossProviderHandoffOptions>;

  constructor(opts: CrossProviderHandoffOptions = {}) {
    this.opts = {
      header: opts.header ?? "## Partial progress from previous provider\n",
      footer:
        opts.footer ??
        "\nContinue the task from where the previous provider left off.\n",
      maxItems: opts.maxItems ?? 20,
    };
  }

  /**
   * Record a single event from the failing provider's stream.
   * Call this for every event yielded before the failure.
   */
  recordEvent(event: AgentEvent): void {
    switch (event.type) {
      case "adapter:message": {
        const content = String(event.content ?? "");
        if (content.trim()) {
          // AGENT-M-07: redact secrets + cap size before storing.
          this.items.push({
            kind: "message",
            content: sanitizeContent(content),
          });
        }
        break;
      }
      case "adapter:tool_call": {
        const inputStr = event.input ? safeJson(event.input) : "";
        const content = inputStr
          ? `${event.toolName}(${inputStr})`
          : event.toolName;
        this.items.push({
          kind: "tool_call",
          // AGENT-M-07: tool args may carry secrets / be oversized.
          content: sanitizeContent(content),
          toolName: event.toolName,
        });
        break;
      }
      case "adapter:tool_result": {
        const outputStr = String(event.output ?? "");
        const label = event.toolName ?? "tool";
        if (outputStr.trim()) {
          this.items.push({
            kind: "tool_result",
            // AGENT-M-07: a single huge/secret-bearing tool result must not
            // flood or leak into the fallback provider's system prompt.
            content: sanitizeContent(outputStr),
            toolName: event.toolName ?? label,
          });
        }
        break;
      }
      default:
        // adapter:started, adapter:stream_delta, adapter:completed, adapter:failed — skip
        break;
    }
  }

  /** Record multiple events at once (convenience for batch processing). */
  recordEvents(events: AgentEvent[]): void {
    for (const event of events) this.recordEvent(event);
  }

  /** Returns true if any meaningful partial content was captured. */
  get hasContent(): boolean {
    return this.items.length > 0;
  }

  /**
   * Build the handoff context string to inject into the fallback provider's
   * system prompt.  Returns `null` if nothing was captured.
   */
  buildHandoffContext(): string | null {
    if (this.items.length === 0) return null;

    const visible = this.items.slice(-this.opts.maxItems);
    const lines = visible.map((item) => formatItem(item));
    // SEC-M-06: wrap in delimited block so the receiving provider treats this
    // content as untrusted prior context and resists prompt-injection attempts
    // embedded in tool results or assistant turns from the previous provider.
    const inner = `${this.opts.header}${lines.join("\n")}\n${this.opts.footer}`;
    return `<untrusted_previous_context>\n${inner}\n</untrusted_previous_context>`;
  }

  /** Reset all captured items (useful when reusing the instance). */
  reset(): void {
    this.items.length = 0;
  }

  // ---------------------------------------------------------------------------
  // Static helpers
  // ---------------------------------------------------------------------------

  /**
   * Build a new `AgentInput` with the handoff context injected into the
   * system prompt.  Returns the original input unchanged if there were no
   * events to carry over.
   */
  static enrichInput(
    originalInput: AgentInput,
    events: AgentEvent[],
    opts?: CrossProviderHandoffOptions
  ): AgentInput {
    const handoff = new CrossProviderHandoff(opts);
    handoff.recordEvents(events);
    const context = handoff.buildHandoffContext();
    if (!context) return originalInput;

    const existingSystemPrompt = originalInput.systemPrompt ?? "";
    const combinedSystemPrompt = existingSystemPrompt
      ? `${context}\n${existingSystemPrompt}`
      : context;

    return { ...originalInput, systemPrompt: combinedSystemPrompt };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatItem(item: HandoffItem): string {
  switch (item.kind) {
    case "message":
      return `[assistant]: ${item.content}`;
    case "tool_call":
      return `[tool_call]: ${item.content}`;
    case "tool_result":
      return `[tool_result:${item.toolName ?? "tool"}]: ${item.content}`;
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
