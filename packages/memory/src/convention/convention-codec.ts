/**
 * Serialization helpers between `DetectedConvention` and the generic
 * record shape stored via MemoryService.
 */
import type { ConventionCategory, DetectedConvention } from './types.js'

const VALID_CATEGORIES = new Set<ConventionCategory>([
  'naming', 'structure', 'imports', 'error-handling', 'typing',
  'testing', 'api', 'database', 'styling', 'general',
])

export function validateCategory(raw: string): ConventionCategory {
  return VALID_CATEGORIES.has(raw as ConventionCategory)
    ? (raw as ConventionCategory)
    : 'general'
}

export function conventionToRecord(conv: DetectedConvention): Record<string, unknown> {
  return {
    id: conv.id,
    name: conv.name,
    category: conv.category,
    description: conv.description,
    pattern: conv.pattern,
    examples: conv.examples,
    confidence: conv.confidence,
    occurrences: conv.occurrences,
    techStack: conv.techStack,
    humanVerified: conv.humanVerified,
    text: `${conv.name}: ${conv.description}`,
  }
}

export function recordToConvention(record: Record<string, unknown>): DetectedConvention {
  return {
    id: String(record['id'] ?? ''),
    name: String(record['name'] ?? ''),
    category: validateCategory(String(record['category'] ?? 'general')),
    description: String(record['description'] ?? ''),
    pattern: record['pattern'] != null ? String(record['pattern']) : undefined,
    examples: Array.isArray(record['examples'])
      ? (record['examples'] as unknown[]).map(e => String(e))
      : [],
    confidence: Number(record['confidence'] ?? 0),
    occurrences: Number(record['occurrences'] ?? 0),
    techStack: record['techStack'] != null ? String(record['techStack']) : undefined,
    humanVerified: record['humanVerified'] != null
      ? Boolean(record['humanVerified'])
      : undefined,
  }
}
