/**
 * Failure analyzer — classifies errors, detects recurring patterns,
 * and checks historical memory for previously-resolved failures.
 *
 * @module recovery/failure-analyzer
 */

import type {
  FailureContext,
  FailureType,
} from './recovery-types.js'

// ---------------------------------------------------------------------------
// Error pattern matchers
// ---------------------------------------------------------------------------

interface ErrorPattern {
  type: FailureType
  patterns: RegExp[]
}

const ERROR_PATTERNS: ErrorPattern[] = [
  {
    type: 'build_failure',
    patterns: [
      /compilation?\s+(?:error|failed)/i,
      /build\s+failed/i,
      /typescript\s+error/i,
      /syntax\s+error/i,
      /cannot\s+find\s+module/i,
      /type\s+error/i,
      /esbuild|tsc|webpack|vite.*error/i,
    ],
  },
  {
    type: 'test_failure',
    patterns: [
      /test\s+(?:failed|failure)/i,
      /assertion\s+(?:error|failed)/i,
      /expect.*(?:toBe|toEqual|toMatch)/i,
      /vitest|jest|mocha.*fail/i,
      /\d+\s+(?:tests?\s+)?failed/i, // eslint-disable-line security/detect-unsafe-regex
    ],
  },
  {
    type: 'timeout',
    patterns: [
      /timeout/i,
      /timed?\s*out/i,
      /deadline\s+exceeded/i,
      /ETIMEDOUT/i,
      /ESOCKETTIMEDOUT/i,
      /abort.*signal/i,
    ],
  },
  {
    type: 'resource_exhaustion',
    patterns: [
      /out\s+of\s+memory/i,
      /heap.*(?:limit|exceeded)/i,
      /ENOMEM/i,
      /rate\s*limit/i,
      /quota\s+exceeded/i,
      /429/,
      /budget\s+exceeded/i,
      /token\s+limit/i,
      /cost\s+limit/i,
    ],
  },
  {
    type: 'generation_failure',
    patterns: [
      /generation\s+failed/i,
      /llm\s+(?:error|failed)/i,
      /model\s+(?:error|unavailable)/i,
      /invalid\s+(?:response|output)/i,
      /parsing?\s+(?:error|failed)/i,
      /500|502|503|504/,
    ],
  },
]

// ---------------------------------------------------------------------------
// Failure history entry
// ---------------------------------------------------------------------------

/** A record of a past failure and how it was resolved. */
export interface FailureHistoryEntry {
  /** The classified failure type. */
  type: FailureType
  /** The error message. */
  error: string
  /** Fingerprint hash for deduplication. */
  fingerprint: string
  /** How the failure was resolved (if at all). */
  resolution?: string
  /** Timestamp of occurrence. */
  timestamp: Date
}

// ---------------------------------------------------------------------------
// Analysis result
// ---------------------------------------------------------------------------

/** Result of analyzing a failure. */
export interface FailureAnalysis {
  /** The classified failure type. */
  type: FailureType
  /** Fingerprint for dedup / matching to history. */
  fingerprint: string
  /** Whether we have seen this exact failure before. */
  isRecurring: boolean
  /** How many times this fingerprint has been seen. */
  occurrenceCount: number
  /** Previous resolutions for this fingerprint, if any. */
  previousResolutions: string[]
  /** Extracted structured info from the error. */
  extractedInfo: Record<string, string>
}

// ---------------------------------------------------------------------------
// FailureAnalyzer
// ---------------------------------------------------------------------------

export class FailureAnalyzer {
  private readonly history: FailureHistoryEntry[] = []
  private readonly fingerprints = new Map<string, { count: number; resolutions: string[] }>()

  /**
   * Classify an error string into a FailureType.
   * Falls back to 'generation_failure' when no pattern matches.
   */
  classifyError(error: string): FailureType {
    for (const { type, patterns } of ERROR_PATTERNS) {
      for (const pattern of patterns) {
        if (pattern.test(error)) {
          return type
        }
      }
    }
    return 'generation_failure'
  }

  /**
   * Produce a deterministic fingerprint for an error message.
   * Strips variable parts (numbers, paths, timestamps) so that
   * structurally-identical errors produce the same fingerprint.
   */
  fingerprint(error: string): string {
    const normalized = error
      .replace(/\d+/g, 'N')          // replace numbers
      .replace(/\/[\w./\\-]+/g, 'P') // replace file paths
      .replace(/\s+/g, ' ')          // collapse whitespace
      .trim()
      .toLowerCase()
    // Simple hash
    let hash = 0
    for (let i = 0; i < normalized.length; i++) {
      hash = ((hash << 5) - hash + normalized.charCodeAt(i)) | 0
    }
    return `fp_${(hash >>> 0).toString(16).padStart(8, '0')}`
  }

  /**
   * Analyze a failure context fully: classify, fingerprint, check history.
   */
  analyze(ctx: FailureContext): FailureAnalysis {
    const type = this.classifyError(ctx.error)
    const fp = this.fingerprint(ctx.error)
    const existing = this.fingerprints.get(fp)
    const extractedInfo = this.extractInfo(ctx.error)

    return {
      type,
      fingerprint: fp,
      isRecurring: existing !== undefined,
      occurrenceCount: (existing?.count ?? 0) + 1,
      previousResolutions: existing?.resolutions ?? [],
      extractedInfo,
    }
  }

  /**
   * Record a failure into the internal history.
   * Call this after a failure is observed, so future analyses can
   * detect recurring patterns.
   */
  recordFailure(ctx: FailureContext, resolution?: string): void {
    const fp = this.fingerprint(ctx.error)
    const entry: FailureHistoryEntry = {
      type: ctx.type,
      error: ctx.error,
      fingerprint: fp,
      resolution,
      timestamp: ctx.timestamp,
    }
    this.history.push(entry)

    const existing = this.fingerprints.get(fp)
    if (existing) {
      existing.count++
      if (resolution) existing.resolutions.push(resolution)
    } else {
      this.fingerprints.set(fp, {
        count: 1,
        resolutions: resolution ? [resolution] : [],
      })
    }
  }

  /**
   * Get the full failure history.
   */
  getHistory(): readonly FailureHistoryEntry[] {
    return this.history
  }

  /**
   * Clear all history. Useful for testing or session boundaries.
   */
  reset(): void {
    this.history.length = 0
    this.fingerprints.clear()
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private extractInfo(error: string): Record<string, string> {
    const info: Record<string, string> = {}

    // Extract file paths
    const pathMatch = error.match(/(?:\/[\w./\\-]+\.\w+)/g)
    if (pathMatch && pathMatch.length > 0) {
      info['file'] = pathMatch[0]!
    }

    // Extract line numbers
    const lineMatch = error.match(/line\s+(\d+)/i) ?? error.match(/:(\d+):\d+/)
    if (lineMatch?.[1]) {
      info['line'] = lineMatch[1]
    }

    // Extract HTTP status codes
    const httpMatch = error.match(/\b(4\d{2}|5\d{2})\b/)
    if (httpMatch?.[1]) {
      info['httpStatus'] = httpMatch[1]
    }

    // Extract module names
    const moduleMatch = error.match(/(?:module|package)\s+['"]([^'"]+)['"]/i)
    if (moduleMatch?.[1]) {
      info['module'] = moduleMatch[1]
    }

    return info
  }
}
