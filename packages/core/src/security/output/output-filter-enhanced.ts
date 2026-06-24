/**
 * Enhanced Output Safety Filters — extends the existing OutputPipeline
 * with harmful content filtering and classification-aware redaction.
 *
 * SEC-L-03: both factory functions accept a `failClosed` option.  When
 * `failClosed: true` a throwing redactor returns `[REDACTED: output filter
 * error]` instead of the original content, preventing inadvertent PII
 * pass-through on internal errors.
 */

import type { SanitizationStage } from "../output-pipeline.js";
import type { SafetySeverity } from "../monitor/built-in-rules.js";

/** Returned in place of content when a redactor throws and `failClosed` is true. */
const REDACTION_FAILURE_PLACEHOLDER = "[REDACTED: output filter error]";

export interface HarmfulContentCategory {
  name: string;
  patterns: RegExp[];
  severity: SafetySeverity;
}

const DEFAULT_HARMFUL_CATEGORIES: HarmfulContentCategory[] = [
  {
    name: "violence",
    severity: "critical",
    patterns: [
      // eslint-disable-next-line security/detect-unsafe-regex
      /\bhow\s+to\s+(make|build|create)\s+(a\s+)?(bomb|explosive|weapon)/i,
      /\bdetailed\s+instructions?\s+for\s+(killing|harming|attacking)/i,
    ],
  },
  {
    name: "malware",
    severity: "critical",
    patterns: [
      /\b(keylogger|ransomware|trojan|rootkit)\s+(code|source|implementation)/i,
      /\bhow\s+to\s+(hack|exploit|breach)\s+(into|a)\b/i,
    ],
  },
  {
    name: "illegal_activity",
    severity: "warning",
    patterns: [
      /\bhow\s+to\s+(forge|counterfeit|fake)\s+(documents?|id|passport|currency)/i,
    ],
  },
];

export interface HarmfulContentFilterOptions {
  /**
   * When `true` a throwing redactor returns a masked placeholder instead of
   * the original content, preventing PII pass-through on internal errors
   * (SEC-L-03).  Defaults to `false` to preserve the existing non-fatal
   * behaviour for low-sensitivity pipelines.
   */
  failClosed?: boolean;
}

/**
 * Creates a SanitizationStage that filters harmful content based on
 * configurable categories and their regex patterns.
 *
 * Pass `{ failClosed: true }` for high-sensitivity pipelines where a
 * throwing filter must NOT return the original content (SEC-L-03).
 */
export function createHarmfulContentFilter(
  categories?: HarmfulContentCategory[],
  options: HarmfulContentFilterOptions = {}
): SanitizationStage {
  const cats = categories ?? DEFAULT_HARMFUL_CATEGORIES;
  const failClosed = options.failClosed === true;

  return {
    name: "harmful-content-filter",
    process(content: string): string {
      try {
        let result = content;
        for (const category of cats) {
          for (const pattern of category.patterns) {
            pattern.lastIndex = 0;
            result = result.replace(pattern, `[FILTERED:${category.name}]`);
          }
        }
        return result;
      } catch {
        // SEC-L-03: fail closed when requested; otherwise non-fatal pass-through.
        return failClosed ? REDACTION_FAILURE_PLACEHOLDER : content;
      }
    },
  };
}

/**
 * Classification levels from least to most sensitive.
 */
const CLASSIFICATION_LEVELS: ReadonlyArray<string> = [
  "public",
  "internal",
  "confidential",
  "restricted",
  "top_secret",
];

/**
 * Additional PII/secret patterns to apply at higher classification levels.
 */
const ENHANCED_REDACTION_PATTERNS: ReadonlyArray<{
  minLevel: number;
  patterns: Array<{ pattern: RegExp; replacement: string }>;
}> = [
  {
    // internal and above: redact IPs
    minLevel: 1,
    patterns: [
      {
        // eslint-disable-next-line security/detect-unsafe-regex
        pattern:
          /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
        replacement: "[REDACTED:ip]",
      },
    ],
  },
  {
    // confidential and above: redact URLs with auth
    minLevel: 2,
    patterns: [
      {
        pattern: /https?:\/\/[^:]+:[^@]+@[^\s"']+/g,
        replacement: "[REDACTED:authenticated-url]",
      },
    ],
  },
  {
    // restricted and above: redact all file paths
    minLevel: 3,
    patterns: [
      {
        // eslint-disable-next-line security/detect-unsafe-regex
        pattern: /(?:\/[\w.-]+){3,}/g,
        replacement: "[REDACTED:path]",
      },
    ],
  },
  {
    // top_secret: redact all UUIDs
    minLevel: 4,
    patterns: [
      {
        pattern:
          /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
        replacement: "[REDACTED:uuid]",
      },
    ],
  },
];

export interface ClassificationAwareRedactorOptions {
  /**
   * When `true` a throwing redactor returns a masked placeholder instead of
   * the original content (SEC-L-03).  Defaults to `false`.
   */
  failClosed?: boolean;
}

/**
 * Creates a SanitizationStage that applies progressively stricter
 * redaction based on the data classification level.
 *
 * Pass `{ failClosed: true }` for high-sensitivity pipelines where a
 * throwing filter must NOT return the original content (SEC-L-03).
 *
 * @param classificationLevel - One of: public, internal, confidential, restricted, top_secret
 */
export function createClassificationAwareRedactor(
  classificationLevel?: string,
  options: ClassificationAwareRedactorOptions = {}
): SanitizationStage {
  const level = classificationLevel ?? "public";
  const levelIndex = CLASSIFICATION_LEVELS.indexOf(level);
  const effectiveLevel = levelIndex >= 0 ? levelIndex : 0;
  const failClosed = options.failClosed === true;

  return {
    name: "classification-aware-redactor",
    process(content: string): string {
      try {
        let result = content;

        for (const tier of ENHANCED_REDACTION_PATTERNS) {
          if (effectiveLevel >= tier.minLevel) {
            for (const { pattern, replacement } of tier.patterns) {
              pattern.lastIndex = 0;
              result = result.replace(pattern, replacement);
            }
          }
        }

        return result;
      } catch {
        // SEC-L-03: fail closed when requested; otherwise non-fatal pass-through.
        return failClosed ? REDACTION_FAILURE_PLACEHOLDER : content;
      }
    },
  };
}
