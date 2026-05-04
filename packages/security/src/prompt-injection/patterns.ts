/**
 * Curated prompt-injection pattern library.
 *
 * Each entry MUST be conservative enough to avoid false positives on
 * benign content (see `fixtures/allow.fixtures.ts`) while still catching
 * the well-known injection families documented by OWASP LLM01:2025.
 *
 * Patterns are grouped here as a single readonly array so the detector
 * can iterate them deterministically in order.
 */
/* eslint-disable security/detect-unsafe-regex --
 * Each pattern in this list IS the package's defensive primitive — we
 * intentionally retain alternation and bounded quantifiers. Every
 * pattern has been hand-audited for catastrophic-backtracking risk:
 * outer alternation does not nest unbounded repetition, dotted spans
 * are bounded ([^.\n]{0,40}? in the pretend rule), and \s+ is the only
 * unbounded greedy quantifier (linear).
 */
export const INJECTION_PATTERNS: readonly RegExp[] = [
  // "ignore previous instructions" family
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i,
  /disregard\s+(all\s+)?(previous|prior|above)\s+instructions?/i,
  /forget\s+(all\s+)?(previous|prior|above)\s+instructions?/i,

  // Persona override / jailbreak
  /you\s+are\s+now\s+(?:a\s+)?(?:DAN|jailbreak|unrestricted|evil)/i,
  /act\s+as\s+(?:if\s+you\s+(?:are|were)\s+)?(?:a\s+)?(?:DAN|uncensored|evil|unrestricted)/i,

  // Chat-template token smuggling
  /<\|im_start\|>\s*system/i,
  /<\|system\|>/i,
  /\[INST\]\s*<<SYS>>/i,
  /###\s*(?:System|Instruction)\s*:/i,

  // DAN / "do anything now" family
  /\bDAN\s+mode\b/i,
  /\bdo\s+anything\s+now\b/i,
  /\bjailbreak\b.*\b(?:mode|prompt|yourself)\b/i,

  // Restriction-removal coercion. Two variants:
  //   1. "pretend you are/have no <thing> ... restrictions|guidelines|rules|limits"
  //   2. "pretend there are no restrictions|guidelines|rules|limits"
  // The first allows up to ~40 chars between the persona phrase and the
  // forbidden keyword so paraphrases like "pretend you are a model with no
  // guidelines" still match without admitting unrelated long sentences.
  /\bpretend\s+(?:you\s+(?:are|have\s+no)\b[^.\n]{0,40}?\b(?:restrictions|guidelines|rules|limits)|there\s+are\s+no\s+(?:restrictions|guidelines|rules|limits))/i,
  /\byour\s+(?:true\s+)?(?:self|nature|purpose)\s+is/i,
  /\boverride\s+(?:your\s+)?(?:safety|guidelines|restrictions|programming)/i,

  // Base64 encoded "ignore previous instructions" variants
  /aWdub3JlIHByZXZpb3VzIGluc3RydWN0aW9ucw==/i,
  /ZGlzcmVnYXJkIHByZXZpb3VzIGluc3RydWN0aW9ucw==/i,
]
/* eslint-enable security/detect-unsafe-regex */
