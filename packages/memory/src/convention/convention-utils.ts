/**
 * Pure utility helpers for convention extraction.
 *
 * Includes string manipulation, similarity scoring, and lenient JSON
 * parsing of LLM responses (which may include markdown code fences).
 */

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function deduplicateStrings(arr: string[]): string[] {
  return [...new Set(arr)]
}

/**
 * Simple bigram-based string similarity (Dice coefficient).
 */
export function stringSimilarity(a: string, b: string): number {
  const lower_a = a.toLowerCase()
  const lower_b = b.toLowerCase()
  if (lower_a === lower_b) return 1.0
  if (lower_a.length < 2 || lower_b.length < 2) return 0

  const bigramsA = new Set<string>()
  for (let i = 0; i < lower_a.length - 1; i++) {
    bigramsA.add(lower_a.slice(i, i + 2))
  }
  const bigramsB = new Set<string>()
  for (let i = 0; i < lower_b.length - 1; i++) {
    bigramsB.add(lower_b.slice(i, i + 2))
  }

  let intersection = 0
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) intersection++
  }

  return (2 * intersection) / (bigramsA.size + bigramsB.size)
}

export function parseLLMJsonArray(raw: string): Array<Record<string, unknown>> {
  // Strip markdown code fences if present
  const cleaned = raw.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim()
  const parsed: unknown = JSON.parse(cleaned)
  if (!Array.isArray(parsed)) return []
  return parsed as Array<Record<string, unknown>>
}

export function parseLLMJsonObject(raw: string): Record<string, unknown> {
  const cleaned = raw.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim()
  const parsed: unknown = JSON.parse(cleaned)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {}
  }
  return parsed as Record<string, unknown>
}
