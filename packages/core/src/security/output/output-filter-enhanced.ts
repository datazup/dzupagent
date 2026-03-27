/**
 * Enhanced Output Safety Filters — extends the existing OutputPipeline
 * with harmful content filtering and classification-aware redaction.
 *
 * Non-fatal: filter failures are logged but do not block the response.
 */

import type { SanitizationStage } from '../output-pipeline.js'
import type { SafetySeverity } from '../monitor/built-in-rules.js'

export interface HarmfulContentCategory {
  name: string
  patterns: RegExp[]
  severity: SafetySeverity
}

const DEFAULT_HARMFUL_CATEGORIES: HarmfulContentCategory[] = [
  {
    name: 'violence',
    severity: 'critical',
    patterns: [
      /\bhow\s+to\s+(make|build|create)\s+(a\s+)?(bomb|explosive|weapon)/i,
      /\bdetailed\s+instructions?\s+for\s+(killing|harming|attacking)/i,
    ],
  },
  {
    name: 'malware',
    severity: 'critical',
    patterns: [
      /\b(keylogger|ransomware|trojan|rootkit)\s+(code|source|implementation)/i,
      /\bhow\s+to\s+(hack|exploit|breach)\s+(into|a)\b/i,
    ],
  },
  {
    name: 'illegal_activity',
    severity: 'warning',
    patterns: [
      /\bhow\s+to\s+(forge|counterfeit|fake)\s+(documents?|id|passport|currency)/i,
    ],
  },
]

/**
 * Creates a SanitizationStage that filters harmful content based on
 * configurable categories and their regex patterns.
 *
 * Non-fatal: if the filter itself throws, it returns the original content.
 */
export function createHarmfulContentFilter(
  categories?: HarmfulContentCategory[],
): SanitizationStage {
  const cats = categories ?? DEFAULT_HARMFUL_CATEGORIES

  return {
    name: 'harmful-content-filter',
    process(content: string): string {
      try {
        let result = content
        for (const category of cats) {
          for (const pattern of category.patterns) {
            pattern.lastIndex = 0
            result = result.replace(pattern, `[FILTERED:${category.name}]`)
          }
        }
        return result
      } catch {
        // Non-fatal: return original content on error
        return content
      }
    },
  }
}

/**
 * Classification levels from least to most sensitive.
 */
const CLASSIFICATION_LEVELS: ReadonlyArray<string> = [
  'public',
  'internal',
  'confidential',
  'restricted',
  'top_secret',
]

/**
 * Additional PII/secret patterns to apply at higher classification levels.
 */
const ENHANCED_REDACTION_PATTERNS: ReadonlyArray<{
  minLevel: number
  patterns: Array<{ pattern: RegExp; replacement: string }>
}> = [
  {
    // internal and above: redact IPs
    minLevel: 1,
    patterns: [
      {
        pattern: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
        replacement: '[REDACTED:ip]',
      },
    ],
  },
  {
    // confidential and above: redact URLs with auth
    minLevel: 2,
    patterns: [
      {
        pattern: /https?:\/\/[^:]+:[^@]+@[^\s"']+/g,
        replacement: '[REDACTED:authenticated-url]',
      },
    ],
  },
  {
    // restricted and above: redact all file paths
    minLevel: 3,
    patterns: [
      {
        pattern: /(?:\/[\w.-]+){3,}/g,
        replacement: '[REDACTED:path]',
      },
    ],
  },
  {
    // top_secret: redact all UUIDs
    minLevel: 4,
    patterns: [
      {
        pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
        replacement: '[REDACTED:uuid]',
      },
    ],
  },
]

/**
 * Creates a SanitizationStage that applies progressively stricter
 * redaction based on the data classification level.
 *
 * Non-fatal: if the filter itself throws, it returns the original content.
 *
 * @param classificationLevel - One of: public, internal, confidential, restricted, top_secret
 */
export function createClassificationAwareRedactor(
  classificationLevel?: string,
): SanitizationStage {
  const level = classificationLevel ?? 'public'
  const levelIndex = CLASSIFICATION_LEVELS.indexOf(level)
  const effectiveLevel = levelIndex >= 0 ? levelIndex : 0

  return {
    name: 'classification-aware-redactor',
    process(content: string): string {
      try {
        let result = content

        for (const tier of ENHANCED_REDACTION_PATTERNS) {
          if (effectiveLevel >= tier.minLevel) {
            for (const { pattern, replacement } of tier.patterns) {
              pattern.lastIndex = 0
              result = result.replace(pattern, replacement)
            }
          }
        }

        return result
      } catch {
        // Non-fatal: return original content on error
        return content
      }
    },
  }
}
