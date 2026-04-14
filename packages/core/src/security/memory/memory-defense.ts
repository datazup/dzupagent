/**
 * Memory Poisoning Defense — scans content before it enters memory
 * to detect homoglyph attacks, encoded payloads, and bulk modifications.
 *
 * Sits between sanitizeMemoryContent() and PolicyAwareStagedWriter.
 */

export type MemoryThreatAction = 'allow' | 'quarantine' | 'reject'

export interface MemoryThreat {
  type: string
  description: string
  evidence: string
  action: MemoryThreatAction
  confidence: number
}

export interface MemoryDefenseResult {
  allowed: boolean
  threats: MemoryThreat[]
  normalizedContent?: string
}

export interface EncodedContentMatch {
  encoding: string
  decoded: string
  position: number
}

export interface MemoryDefenseConfig {
  /** Maximum number of distinct facts/statements per write (default: 10) */
  maxFactsPerWrite?: number
  /** Enable Unicode homoglyph normalization (default: true) */
  enableHomoglyphNormalization?: boolean
  /** Enable base64/hex encoding detection (default: true) */
  enableEncodingDetection?: boolean
}

export interface MemoryDefense {
  /** Scan content for memory poisoning threats */
  scan(content: string, metadata?: Record<string, unknown>): MemoryDefenseResult
  /** Normalize Unicode homoglyphs to ASCII equivalents */
  normalizeHomoglyphs(text: string): string
  /** Detect encoded content (base64, hex) in text */
  detectEncodedContent(text: string): EncodedContentMatch[]
}

// --- Homoglyph Confusables Map ---
// Maps Cyrillic and other confusable characters to their Latin equivalents

const CONFUSABLES = new Map<string, string>([
  // Cyrillic -> Latin
  ['\u0430', 'a'], // а
  ['\u0435', 'e'], // е
  ['\u043E', 'o'], // о
  ['\u0440', 'p'], // р
  ['\u0441', 'c'], // с
  ['\u0443', 'y'], // у (Cyrillic у looks like y)
  ['\u0445', 'x'], // х
  ['\u042C', 'b'], // Ь (soft sign, visually similar to b in some fonts)
  ['\u0410', 'A'], // А
  ['\u0412', 'B'], // В
  ['\u0415', 'E'], // Е
  ['\u041A', 'K'], // К
  ['\u041C', 'M'], // М
  ['\u041D', 'H'], // Н
  ['\u041E', 'O'], // О
  ['\u0420', 'P'], // Р
  ['\u0421', 'C'], // С
  ['\u0422', 'T'], // Т
  ['\u0425', 'X'], // Х
  // Greek -> Latin
  ['\u03B1', 'a'], // alpha
  ['\u03B5', 'e'], // epsilon
  ['\u03BF', 'o'], // omicron
  ['\u03C1', 'p'], // rho
  // Fullwidth -> ASCII
  ['\uFF41', 'a'],
  ['\uFF42', 'b'],
  ['\uFF43', 'c'],
  ['\uFF44', 'd'],
  ['\uFF45', 'e'],
])

// Regex for detecting Cyrillic characters mixed with Latin
const MIXED_SCRIPT_PATTERN = /[\u0400-\u04FF]/

// --- Encoding Detection ---

const BASE64_PATTERN = /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{64,}={0,2}(?![A-Za-z0-9+/=])/g
const HEX_PATTERN = /(?<![A-Fa-f0-9])(?:0x)?[A-Fa-f0-9]{32,}(?![A-Fa-f0-9])/g

// --- Fact Counting Heuristic ---

/**
 * Counts approximate number of distinct factual statements in content.
 * Uses sentence-ending punctuation and newlines as delimiters.
 */
function countFacts(content: string): number {
  // Split on sentence boundaries and newlines
  const segments = content.split(/[.!?\n]+/).filter((s) => s.trim().length > 10)
  return segments.length
}

/**
 * Creates a MemoryDefense instance with the given configuration.
 */
export function createMemoryDefense(config?: MemoryDefenseConfig): MemoryDefense {
  const maxFacts = config?.maxFactsPerWrite ?? 10
  const enableHomoglyphs = config?.enableHomoglyphNormalization !== false
  const enableEncoding = config?.enableEncodingDetection !== false

  function normalizeHomoglyphs(text: string): string {
    // First apply NFKD normalization
    let normalized = text.normalize('NFKD')

    // Then apply confusables map
    let result = ''
    for (const char of normalized) {
      const replacement = CONFUSABLES.get(char)
      result += replacement ?? char
    }

    return result
  }

  function detectEncodedContent(text: string): EncodedContentMatch[] {
    const matches: EncodedContentMatch[] = []

    // Base64 detection
    BASE64_PATTERN.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = BASE64_PATTERN.exec(text)) !== null) {
      try {
        const decoded = Buffer.from(m[0], 'base64').toString('utf-8')
        // Only flag if decoded content is readable text (high ASCII ratio)
        const printableRatio = countPrintable(decoded) / decoded.length
        if (printableRatio > 0.8 && decoded.length > 4) {
          matches.push({
            encoding: 'base64',
            decoded,
            position: m.index,
          })
        }
      } catch {
        // Not valid base64, skip
      }
    }

    // Hex detection
    HEX_PATTERN.lastIndex = 0
    while ((m = HEX_PATTERN.exec(text)) !== null) {
      const hexStr = m[0].startsWith('0x') ? m[0].slice(2) : m[0]
      if (hexStr.length % 2 !== 0) continue
      try {
        const decoded = Buffer.from(hexStr, 'hex').toString('utf-8')
        const printableRatio = countPrintable(decoded) / decoded.length
        if (printableRatio > 0.8 && decoded.length > 4) {
          matches.push({
            encoding: 'hex',
            decoded,
            position: m.index,
          })
        }
      } catch {
        // Not valid hex, skip
      }
    }

    return matches
  }

  function scan(content: string, _metadata?: Record<string, unknown>): MemoryDefenseResult {
    const threats: MemoryThreat[] = []
    let normalizedContent: string | undefined

    // 1. Homoglyph detection and normalization
    if (enableHomoglyphs && MIXED_SCRIPT_PATTERN.test(content)) {
      const normalized = normalizeHomoglyphs(content)
      if (normalized !== content) {
        normalizedContent = normalized
        threats.push({
          type: 'homoglyph_attack',
          description: 'Content contains mixed Unicode scripts that may be homoglyph attacks',
          evidence: extractMixedScriptEvidence(content),
          action: 'quarantine',
          confidence: 0.7,
        })
      }
    }

    // 2. Encoding detection
    if (enableEncoding) {
      const encoded = detectEncodedContent(content)
      for (const match of encoded) {
        threats.push({
          type: 'encoded_payload',
          description: `${match.encoding}-encoded content detected at position ${match.position}`,
          evidence: match.decoded.slice(0, 100),
          action: 'quarantine',
          confidence: 0.8,
        })
      }
    }

    // 3. Bulk modification detection
    const factCount = countFacts(content)
    if (factCount > maxFacts) {
      threats.push({
        type: 'bulk_modification',
        description: `Content contains ${factCount} facts, exceeding limit of ${maxFacts}`,
        evidence: `${factCount} distinct statements detected`,
        action: 'reject',
        confidence: 0.9,
      })
    }

    // Determine overall result
    const hasReject = threats.some((t) => t.action === 'reject')
    const hasQuarantine = threats.some((t) => t.action === 'quarantine')
    const allowed = !hasReject && !hasQuarantine

    const resolvedContent = normalizedContent ?? (allowed ? content : undefined)
    const result: MemoryDefenseResult = {
      allowed,
      threats,
    }
    if (resolvedContent !== undefined) result.normalizedContent = resolvedContent
    return result
  }

  return {
    scan,
    normalizeHomoglyphs,
    detectEncodedContent,
  }
}

// --- Helpers ---

function countPrintable(str: string): number {
  let count = 0
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    if (code !== undefined && code >= 32 && code < 127) {
      count++
    }
  }
  return count
}

function extractMixedScriptEvidence(content: string): string {
  // Find first occurrence of Cyrillic mixed with Latin
  const words = content.split(/\s+/)
  for (const word of words) {
    if (MIXED_SCRIPT_PATTERN.test(word) && /[A-Za-z]/.test(word)) {
      return word
    }
  }
  // If no mixed word found, return first Cyrillic word
  for (const word of words) {
    if (MIXED_SCRIPT_PATTERN.test(word)) {
      return word
    }
  }
  return content.slice(0, 50)
}
