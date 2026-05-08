/**
 * Convention merging + markdown formatting helpers.
 *
 * Pure functions extracted from `ConventionExtractor` to keep the
 * coordinator class small.
 */
import type { ConventionFilter, DetectedConvention } from './types.js'
import { capitalize, deduplicateStrings, stringSimilarity } from './convention-utils.js'

/**
 * Merge conventions whose names are bigram-similar above the given threshold.
 * Keeps the one with higher confidence as the base; combines occurrences and examples.
 */
export function mergeSimilarConventions(
  items: DetectedConvention[],
  threshold: number,
): DetectedConvention[] {
  if (items.length <= 1) return items

  const result: DetectedConvention[] = []
  const consumed = new Set<number>()

  for (let i = 0; i < items.length; i++) {
    if (consumed.has(i)) continue
    let current = items[i]!
    for (let j = i + 1; j < items.length; j++) {
      if (consumed.has(j)) continue
      const other = items[j]!
      if (stringSimilarity(current.name, other.name) >= threshold) {
        // Merge: keep the one with higher confidence
        current = {
          ...(current.confidence >= other.confidence ? current : other),
          occurrences: current.occurrences + other.occurrences,
          confidence: Math.max(current.confidence, other.confidence),
          examples: deduplicateStrings([...current.examples, ...other.examples]).slice(0, 5),
          humanVerified: current.humanVerified ?? other.humanVerified,
        }
        consumed.add(j)
      }
    }
    result.push(current)
  }

  return result
}

/**
 * Format a list of conventions as markdown grouped by category.
 * Returns an empty string if no conventions are provided.
 */
export function formatConventionsAsMarkdown(
  conventions: DetectedConvention[],
  _filter?: ConventionFilter,
): string {
  if (conventions.length === 0) return ''

  // Group by category
  const grouped = new Map<string, DetectedConvention[]>()
  for (const c of conventions) {
    const arr = grouped.get(c.category) ?? []
    arr.push(c)
    grouped.set(c.category, arr)
  }

  const lines: string[] = ['## Project Conventions', '']
  for (const [category, items] of grouped) {
    lines.push(`### ${capitalize(category)}`)
    for (const item of items) {
      lines.push(
        `- **${item.name}**: ${item.description} (confidence: ${item.confidence.toFixed(2)})`,
      )
      if (item.examples.length > 0) {
        lines.push(`  Example: \`${item.examples[0]}\``)
      }
    }
    lines.push('')
  }

  return lines.join('\n').trim()
}
