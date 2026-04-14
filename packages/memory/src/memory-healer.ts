/**
 * Self-healing memory system -- detects and resolves memory quality issues.
 *
 * Pure functions that scan memory records for duplicates (Jaccard similarity),
 * contradictions (keyword opposition), and staleness (age-based).
 * Returns a structured HealingReport with issues and resolution stats.
 */
import { tokenizeText, jaccardSimilarity } from './shared/text-similarity.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HealingIssue {
  type: 'duplicate' | 'contradiction' | 'stale' | 'orphaned'
  keys: string[]
  description: string
  suggestedAction: 'merge' | 'flag' | 'prune' | 'remove'
}

export interface HealingReport {
  issues: HealingIssue[]
  resolved: number
  flagged: number
  totalRecordsScanned: number
}

export interface MemoryHealerConfig {
  /** Similarity threshold for duplicate detection (0-1, default: 0.85) */
  duplicateThreshold: number
  /** Days since last access before considered stale (default: 30) */
  staleDays: number
  /** Auto-resolve duplicates by merging (default: false -- flag only) */
  autoMergeDuplicates: boolean
  /** Auto-prune stale records (default: false -- flag only) */
  autoPruneStale: boolean
}

const DEFAULT_CONFIG: MemoryHealerConfig = {
  duplicateThreshold: 0.85,
  staleDays: 30,
  autoMergeDuplicates: false,
  autoPruneStale: false,
}

// Opposition patterns: pairs of phrases that indicate contradiction
const OPPOSITION_PATTERNS: Array<[RegExp, RegExp]> = [
  [/\balways\s+(\w+)/i, /\bnever\s+(\w+)/i],
  [/\buse\s+(\w+)/i, /\bdon'?t\s+use\s+(\w+)/i],
  [/\benable\s+(\w+)/i, /\bdisable\s+(\w+)/i],
  [/\brequired?\b/i, /\boptional\b/i],
  [/\btrue\b/i, /\bfalse\b/i],
  [/\ballow\s+(\w+)/i, /\bblock\s+(\w+)/i],
  [/\bprefer\s+(\w+)/i, /\bavoid\s+(\w+)/i],
]

function extractSubject(text: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(text)
  if (!match) return undefined
  return match[1]?.toLowerCase() ?? match[0].toLowerCase()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect duplicates using text similarity (Jaccard index on word sets).
 */
export function findDuplicates(
  records: Array<{ key: string; text: string }>,
  threshold: number = DEFAULT_CONFIG.duplicateThreshold,
): HealingIssue[] {
  const issues: HealingIssue[] = []
  // Preserve prior behavior by keeping single-character tokens.
  const tokenSets = records.map(r => tokenizeText(r.text, { minTokenLength: 1 }))
  const reported = new Set<string>()

  for (let i = 0; i < records.length; i++) {
    const recI = records[i]
    const tokI = tokenSets[i]
    if (!recI || !tokI) continue

    for (let j = i + 1; j < records.length; j++) {
      const recJ = records[j]
      const tokJ = tokenSets[j]
      if (!recJ || !tokJ) continue

      const pairKey = `${recI.key}|${recJ.key}`
      if (reported.has(pairKey)) continue

      const sim = jaccardSimilarity(tokI, tokJ)
      if (sim >= threshold) {
        reported.add(pairKey)
        issues.push({
          type: 'duplicate',
          keys: [recI.key, recJ.key],
          description: `Records are ${(sim * 100).toFixed(0)}% similar (Jaccard)`,
          suggestedAction: 'merge',
        })
      }
    }
  }
  return issues
}

/**
 * Detect contradictions using keyword opposition patterns.
 */
export function findContradictions(
  records: Array<{ key: string; text: string }>,
): HealingIssue[] {
  const issues: HealingIssue[] = []
  const reported = new Set<string>()

  for (let i = 0; i < records.length; i++) {
    const recI = records[i]
    if (!recI) continue

    for (let j = i + 1; j < records.length; j++) {
      const recJ = records[j]
      if (!recJ) continue

      const pairKey = `${recI.key}|${recJ.key}`
      if (reported.has(pairKey)) continue

      for (const [patternA, patternB] of OPPOSITION_PATTERNS) {
        const subjectA = extractSubject(recI.text, patternA)
        const subjectB = extractSubject(recJ.text, patternB)

        if (subjectA && subjectB && subjectA === subjectB) {
          reported.add(pairKey)
          issues.push({
            type: 'contradiction',
            keys: [recI.key, recJ.key],
            description: `Opposing statements about "${subjectA}"`,
            suggestedAction: 'flag',
          })
          break
        }

        // Check reverse direction
        const subjectAr = extractSubject(recJ.text, patternA)
        const subjectBr = extractSubject(recI.text, patternB)

        if (subjectAr && subjectBr && subjectAr === subjectBr) {
          reported.add(pairKey)
          issues.push({
            type: 'contradiction',
            keys: [recI.key, recJ.key],
            description: `Opposing statements about "${subjectAr}"`,
            suggestedAction: 'flag',
          })
          break
        }
      }
    }
  }
  return issues
}

/**
 * Find stale records not accessed in N days.
 */
export function findStaleRecords(
  records: Array<{ key: string; lastAccessedAt?: number }>,
  staleDays: number = DEFAULT_CONFIG.staleDays,
): HealingIssue[] {
  const cutoff = Date.now() - staleDays * 24 * 60 * 60 * 1000
  const issues: HealingIssue[] = []

  for (const record of records) {
    if (
      record.lastAccessedAt !== undefined &&
      record.lastAccessedAt > 0 &&
      record.lastAccessedAt < cutoff
    ) {
      const daysAgo = Math.floor((Date.now() - record.lastAccessedAt) / (24 * 60 * 60 * 1000))
      issues.push({
        type: 'stale',
        keys: [record.key],
        description: `Not accessed in ${daysAgo} days`,
        suggestedAction: 'prune',
      })
    }
  }
  return issues
}

/**
 * Run all healing checks and produce a report.
 */
export function healMemory(
  records: Array<{ key: string; text: string; lastAccessedAt?: number }>,
  config?: Partial<MemoryHealerConfig>,
): HealingReport {
  const cfg: MemoryHealerConfig = { ...DEFAULT_CONFIG, ...config }

  const duplicates = findDuplicates(records, cfg.duplicateThreshold)
  const contradictions = findContradictions(records)
  const stale = findStaleRecords(records, cfg.staleDays)

  const allIssues = [...duplicates, ...contradictions, ...stale]

  let resolved = 0
  let flagged = 0

  for (const issue of allIssues) {
    const autoResolve =
      (issue.type === 'duplicate' && cfg.autoMergeDuplicates) ||
      (issue.type === 'stale' && cfg.autoPruneStale)

    if (autoResolve) {
      resolved++
    } else {
      flagged++
    }
  }

  return {
    issues: allIssues,
    resolved,
    flagged,
    totalRecordsScanned: records.length,
  }
}
