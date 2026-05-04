import { INJECTION_PATTERNS } from './patterns.js'

/**
 * One detector hit — the pattern source string, the matched text, and the
 * 0-based offset where the match started inside the scanned input.
 */
export interface InjectionFinding {
  pattern: string
  match: string
  offset: number
}

/** Verdict produced by {@link PromptInjectionDetector.scan}. */
export type InjectionVerdict = 'allow' | 'warn' | 'block'

export interface InjectionScanResult {
  verdict: InjectionVerdict
  findings: InjectionFinding[]
  /**
   * Sanitized input. When findings exist, every matched span is replaced
   * with `[REDACTED-INJECTION]`. When no findings exist, this is the
   * original text unchanged.
   */
  sanitized: string
}

/** Replacement token applied to matched spans during sanitization. */
export const INJECTION_REDACTION = '[REDACTED-INJECTION]'

/**
 * Pattern-driven prompt-injection detector.
 *
 * The detector is deterministic and side-effect-free; multiple instances
 * may be reused across runs. Patterns come from {@link INJECTION_PATTERNS}.
 *
 * The default mode is `'block'` so callers that wire the detector into the
 * agent run loop fail closed by default — matching the OWASP LLM01
 * recommendation to reject untrusted prompt-control text outright.
 */
export class PromptInjectionDetector {
  /**
   * Scan `text` and return findings + sanitized output.
   *
   * @param text Untrusted input string.
   * @param mode `'warn'` returns verdict `'warn'` on any match (caller
   *             decides whether to sanitize). `'block'` returns verdict
   *             `'block'` on any match. When no patterns match, the
   *             verdict is always `'allow'` regardless of mode.
   */
  scan(text: string, mode: InjectionVerdict = 'block'): InjectionScanResult {
    if (typeof text !== 'string' || text.length === 0) {
      return { verdict: 'allow', findings: [], sanitized: text ?? '' }
    }

    const findings: InjectionFinding[] = []
    for (const pattern of INJECTION_PATTERNS) {
      // Patterns are intentionally non-global so we use exec() once per pattern.
      const match = pattern.exec(text)
      if (match && match[0]) {
        findings.push({
          pattern: pattern.source,
          match: match[0],
          offset: match.index,
        })
      }
    }

    if (findings.length === 0) {
      return { verdict: 'allow', findings: [], sanitized: text }
    }

    const sanitized = sanitizeWithFindings(text, findings)

    if (mode === 'warn') {
      return { verdict: 'warn', findings, sanitized }
    }
    return { verdict: 'block', findings, sanitized }
  }
}

/**
 * Replace every matched span with the redaction token.
 *
 * Findings may overlap (different patterns matching adjacent or nested
 * spans) so we sort by offset descending and splice from the right to
 * preserve earlier offsets.
 */
function sanitizeWithFindings(text: string, findings: readonly InjectionFinding[]): string {
  const sorted = [...findings].sort((a, b) => b.offset - a.offset)
  let out = text
  for (const finding of sorted) {
    const start = finding.offset
    const end = start + finding.match.length
    if (start < 0 || end > out.length) continue
    out = out.slice(0, start) + INJECTION_REDACTION + out.slice(end)
  }
  return out
}

/**
 * Error raised when a {@link PromptInjectionDetector} returns verdict
 * `'block'` and the host opts to halt the run.
 */
export class PromptInjectionBlockedError extends Error {
  public readonly findings: readonly InjectionFinding[]

  constructor(findings: readonly InjectionFinding[]) {
    super(`Prompt injection detected: ${findings.length} finding(s)`)
    this.name = 'PromptInjectionBlockedError'
    this.findings = findings
  }
}
