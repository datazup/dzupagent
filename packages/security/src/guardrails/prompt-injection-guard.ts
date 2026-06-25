/**
 * PromptInjectionGuard — composable guardrail for untrusted content that
 * crosses a trust boundary into the model context (tool results, retrieved
 * documents, cross-provider handoff context, memory recall, etc.).
 *
 * Two independent capabilities:
 *
 *  1. `wrap()` — structural defense. Untrusted content is enclosed in a
 *     clearly-delimited, provenance-labelled quoted-data block:
 *
 *         <untrusted_content source="tool_result">
 *         [content]
 *         </untrusted_content>
 *
 *     The delimiter makes it structurally explicit to the model which spans
 *     of the prompt are external data rather than authoritative instruction.
 *     This is the same pattern QF-16 hard-coded around `buildHandoffContext`
 *     (`<untrusted_previous_context>`), generalized to any label so every
 *     untrusted input in the tool loop can reuse it.
 *
 *     Nested delimiter attempts inside the content (a payload that tries to
 *     close the block early and re-open its own authoritative section) are
 *     neutralized so they cannot escape the quoted-data block.
 *
 *  2. `screen()` — detective control. The content is matched against the
 *     curated {@link INJECTION_PATTERNS} library (OWASP LLM01:2025). The
 *     guard reports findings as a non-blocking signal by default; callers
 *     decide whether to warn, redact, or reject.
 *
 * The guard is deterministic, side-effect-free, and carries zero runtime
 * dependencies, so it is safe to share across every workspace package.
 *
 * @module
 */

import { INJECTION_PATTERNS } from "../prompt-injection/patterns.js";

/** Options controlling a single {@link PromptInjectionGuard.wrap} call. */
export interface GuardOptions {
  /**
   * Wrap content in a delimited quoted-data block with a provenance label.
   * Defaults to `true`. When `false`, the (optionally screened) content is
   * returned without delimiters.
   */
  delimit?: boolean;

  /**
   * Screen the content against {@link INJECTION_PATTERNS} while wrapping.
   * This is a flag, not a gate: detected patterns are appended as a
   * `<!-- injection-screen: ... -->` annotation inside the block so the
   * surrounding model turn is made aware, but the content is NOT blocked
   * or redacted. Defaults to `false`.
   */
  screen?: boolean;

  /**
   * Provenance label rendered in the delimiter `source="..."` attribute,
   * e.g. `'tool_result'`, `'retrieved_content'`, `'previous_provider'`.
   * Defaults to `'untrusted_content'`.
   */
  label?: string;
}

/** Result of {@link PromptInjectionGuard.screen}. */
export interface ScreenResult {
  /** True when at least one injection pattern matched. */
  hasPatterns: boolean;
  /**
   * The `RegExp.source` of every pattern that matched, in pattern-library
   * order. Empty when {@link hasPatterns} is `false`.
   */
  patterns: string[];
}

/** Fixed outer tag name for every wrapped block. */
const BLOCK_TAG = "untrusted_content";
const DEFAULT_LABEL = "untrusted_content";

/**
 * Composable prompt-injection guardrail. A single instance is stateless and
 * may be shared across runs and tools.
 */
export class PromptInjectionGuard {
  /**
   * Wrap untrusted `content` for safe inclusion in a model prompt.
   *
   * With the defaults (`delimit: true`), returns:
   *
   *     <untrusted_content source="[label]">
   *     [content]
   *     </untrusted_content>
   *
   * @param content Raw untrusted text. `null`/`undefined`/non-string inputs
   *                are coerced to an empty string so the guard never throws.
   * @param opts    See {@link GuardOptions}.
   */
  wrap(content: string, opts: GuardOptions = {}): string {
    const { delimit = true, screen = false, label = DEFAULT_LABEL } = opts;

    const raw = typeof content === "string" ? content : String(content ?? "");

    // Defense: neutralize any attempt to forge the block boundary from
    // INSIDE the untrusted content. Without this, a payload containing a
    // literal `</untrusted_content>` could close the quoted-data block early
    // and have the model treat trailing text as authoritative.
    const safe = neutralizeBoundary(raw);

    const screenNote = screen ? this.buildScreenNote(raw) : "";

    if (!delimit) {
      // Caller opted out of the structural delimiter (e.g. it supplies its
      // own envelope). Still surface the screen annotation when requested.
      return screenNote ? `${screenNote}\n${safe}` : safe;
    }

    const safeLabel = sanitizeLabel(label);
    const body = screenNote ? `${screenNote}\n${safe}` : safe;
    return `<${BLOCK_TAG} source="${safeLabel}">\n${body}\n</${BLOCK_TAG}>`;
  }

  /**
   * Screen `content` against the curated injection-pattern library without
   * altering it. Pure detection — the caller decides how to react.
   */
  screen(content: string): ScreenResult {
    if (typeof content !== "string" || content.length === 0) {
      return { hasPatterns: false, patterns: [] };
    }

    const patterns: string[] = [];
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(content)) {
        patterns.push(pattern.source);
      }
    }

    return { hasPatterns: patterns.length > 0, patterns };
  }

  /**
   * Build the in-block screen annotation. Returns an empty string when no
   * patterns matched so callers never emit a noisy note for clean content.
   */
  private buildScreenNote(content: string): string {
    const result = this.screen(content);
    if (!result.hasPatterns) return "";
    return `<!-- injection-screen: ${result.patterns.length} pattern(s) flagged; content quoted as untrusted data -->`;
  }
}

/**
 * Replace forged block boundaries inside untrusted content. A literal
 * `</untrusted_content>` (in any case, with arbitrary inner whitespace) is
 * defanged by inserting a zero-width-free visible marker so the model still
 * sees the text but it can no longer terminate the quoted-data block.
 *
 * We also defang a forged OPENING tag with a `source="..."` attribute, since
 * a payload could otherwise inject a second, attacker-controlled provenance
 * label.
 */
function neutralizeBoundary(content: string): string {
  return (
    content
      .replace(/<\s*\/\s*untrusted_content\s*>/gi, "&lt;/untrusted_content&gt;")
      // Forged OPENING tag (with optional attributes). `[^>]*` is bounded by
      // the closing `>` and contains no nested repetition, so the match is
      // linear — no catastrophic-backtracking risk. We capture the inner span
      // (everything after the tag name, before `>`) to preserve any forged
      // attributes verbatim as defanged text.
      .replace(
        /<\s*untrusted_content\b([^>]*)>/gi,
        (_m, inner: string) => `&lt;untrusted_content${inner}&gt;`
      )
  );
}

/**
 * Sanitize a provenance label so it is safe inside the `source="..."`
 * attribute: strip quotes, angle brackets, whitespace, and control
 * characters that could break out of the attribute. Falls back to the
 * default label when the input sanitizes to empty.
 */
function sanitizeLabel(label: string): string {
  if (typeof label !== "string") return DEFAULT_LABEL;
  const cleaned = label.replace(/["'<>\s]/g, "").trim();
  return cleaned.length > 0 ? cleaned : DEFAULT_LABEL;
}
