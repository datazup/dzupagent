import {
  PromptInjectionDetector,
  type InjectionFinding,
  type InjectionVerdict,
} from './prompt-injection/detector.js'
import { PiiDetector } from './pii/detector.js'

export type PromptInjectionMode = 'off' | 'warn' | 'block'
export type PiiMode = 'off' | 'redact' | 'block'

export interface ContentScannerConfig {
  promptInjection: PromptInjectionMode
  pii: PiiMode
}

/** Final verdict from {@link ContentScanner.scan}. */
export type ContentScanVerdict = 'allow' | 'sanitize' | 'block'

export interface ContentScanResult {
  verdict: ContentScanVerdict
  findings: InjectionFinding[]
  /** Distinct PII categories discovered (e.g. `['SSN']`). Empty when PII mode is `'off'`. */
  piiTypes: string[]
  /**
   * Sanitized output. When the verdict is `'allow'`, this equals the
   * original input. When the verdict is `'sanitize'`, injection findings
   * are redacted and (if `pii: 'redact'`) PII is replaced with typed
   * markers. When the verdict is `'block'`, callers SHOULD NOT forward
   * `sanitized` to the LLM — the run must be aborted.
   */
  sanitized: string
}

/**
 * Combined prompt-injection + PII content scanner.
 *
 * Modes:
 * - `promptInjection`: `'off'` skips all injection scanning. `'warn'`
 *   detects but rewrites matched spans (verdict `'sanitize'`). `'block'`
 *   stops the run on any match (verdict `'block'`).
 * - `pii`: `'off'` skips all PII scanning. `'redact'` rewrites matches
 *   inline (verdict `'sanitize'`). `'block'` stops the run on any
 *   detection (verdict `'block'`).
 *
 * When BOTH layers run, `'block'` outranks `'sanitize'` outranks `'allow'`.
 */
export class ContentScanner {
  private readonly injection: PromptInjectionDetector
  private readonly pii: PiiDetector

  constructor(private readonly config: ContentScannerConfig) {
    this.injection = new PromptInjectionDetector()
    this.pii = new PiiDetector()
  }

  async scan(text: string): Promise<ContentScanResult> {
    if (typeof text !== 'string') {
      return { verdict: 'allow', findings: [], piiTypes: [], sanitized: '' }
    }

    let working = text
    let findings: InjectionFinding[] = []
    let verdict: ContentScanVerdict = 'allow'

    if (this.config.promptInjection !== 'off') {
      const mode: InjectionVerdict =
        this.config.promptInjection === 'warn' ? 'warn' : 'block'
      const result = this.injection.scan(working, mode)
      if (result.findings.length > 0) {
        findings = result.findings
        working = result.sanitized
        verdict = this.config.promptInjection === 'block' ? 'block' : 'sanitize'
      }
    }

    let piiTypes: string[] = []
    if (this.config.pii !== 'off') {
      const piiResult = this.pii.scan(working)
      if (piiResult.hasPii) {
        piiTypes = piiResult.types
        if (this.config.pii === 'block') {
          verdict = 'block'
        } else {
          working = this.pii.sanitize(working)
          if (verdict === 'allow') verdict = 'sanitize'
        }
      }
    }

    const sanitized = verdict === 'allow' ? text : working
    return { verdict, findings, piiTypes, sanitized }
  }
}
