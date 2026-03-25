/**
 * Data classification — tag content with sensitivity levels and auto-classify
 * based on regex patterns (SSN, credit cards, API keys, PII, etc.).
 *
 * @module security/classification/data-classification
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ClassificationLevel = 'public' | 'internal' | 'confidential' | 'restricted'

export interface DataClassificationTag {
  level: ClassificationLevel
  reason?: string
  taggedAt: string
  taggedBy?: string
}

export interface ClassificationPattern {
  pattern: RegExp
  level: ClassificationLevel
  reason: string
}

export interface ClassificationConfig {
  defaultLevel?: ClassificationLevel
  autoClassifyPatterns?: ClassificationPattern[]
}

// ---------------------------------------------------------------------------
// Ordering (higher index = more restricted)
// ---------------------------------------------------------------------------

const LEVEL_ORDER: Record<ClassificationLevel, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
}

// ---------------------------------------------------------------------------
// Default patterns
// ---------------------------------------------------------------------------

export const DEFAULT_CLASSIFICATION_PATTERNS: ClassificationPattern[] = [
  // Restricted — highly sensitive data
  {
    pattern: /\b\d{3}-\d{2}-\d{4}\b/,
    level: 'restricted',
    reason: 'SSN detected',
  },
  {
    pattern: /\b\d{9}\b/,
    level: 'restricted',
    reason: 'Possible SSN (9-digit number)',
  },
  {
    pattern: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/,
    level: 'restricted',
    reason: 'Credit card number detected',
  },
  // Confidential — secrets and credentials
  {
    pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}["']?/i,
    level: 'confidential',
    reason: 'API key detected',
  },
  {
    pattern: /(?:secret|token|bearer)\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}["']?/i,
    level: 'confidential',
    reason: 'Secret or token detected',
  },
  {
    pattern: /(?:password|passwd|pwd)\s*[:=]\s*["']?[^\s"']{4,}["']?/i,
    level: 'confidential',
    reason: 'Password detected',
  },
  {
    pattern: /\b(?:sk|pk)[-_](?:live|test)[-_][A-Za-z0-9]{20,}\b/,
    level: 'confidential',
    reason: 'Stripe-style API key detected',
  },
  // Internal — personal identifiable information
  {
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/,
    level: 'internal',
    reason: 'Email address detected',
  },
  {
    pattern: /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/,
    level: 'internal',
    reason: 'Phone number detected',
  },
]

// ---------------------------------------------------------------------------
// DataClassifier
// ---------------------------------------------------------------------------

export class DataClassifier {
  private readonly defaultLevel: ClassificationLevel
  private readonly patterns: ClassificationPattern[]

  constructor(config?: ClassificationConfig) {
    this.defaultLevel = config?.defaultLevel ?? 'public'
    this.patterns = config?.autoClassifyPatterns ?? DEFAULT_CLASSIFICATION_PATTERNS
  }

  /**
   * Auto-classify content by scanning against configured patterns.
   * Returns the highest classification level found.
   */
  classify(content: string): DataClassificationTag {
    let highestLevel: ClassificationLevel = this.defaultLevel
    let highestReason: string | undefined

    for (const { pattern, level, reason } of this.patterns) {
      // Clone the regex so global state doesn't interfere between calls
      const re = new RegExp(pattern.source, pattern.flags)
      if (re.test(content)) {
        if (LEVEL_ORDER[level] > LEVEL_ORDER[highestLevel]) {
          highestLevel = level
          highestReason = reason
        }
      }
    }

    return {
      level: highestLevel,
      reason: highestReason,
      taggedAt: new Date().toISOString(),
    }
  }

  /** Extract the classification level from a tag. */
  getLevel(tag: DataClassificationTag): ClassificationLevel {
    return tag.level
  }

  /** Returns true if level `a` is strictly higher than level `b`. */
  isHigherThan(a: ClassificationLevel, b: ClassificationLevel): boolean {
    return LEVEL_ORDER[a] > LEVEL_ORDER[b]
  }

  /** Create a classification tag for a namespace. */
  tagNamespace(
    namespace: string,
    level: ClassificationLevel,
    reason?: string,
  ): DataClassificationTag {
    return {
      level,
      reason: reason ?? `Namespace "${namespace}" tagged as ${level}`,
      taggedAt: new Date().toISOString(),
    }
  }
}
