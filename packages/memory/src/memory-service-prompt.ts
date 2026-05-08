/**
 * Prompt-formatting helper for {@link MemoryService}.
 *
 * Pure function — turns an array of memory records into a prompt-ready
 * string with truncation and optional header.
 */
import type { FormatOptions } from './memory-types.js'

/**
 * Format an array of memory records into a prompt-ready string.
 * Returns `''` if `records` is empty.
 */
export function formatMemoryForPrompt(
  records: Record<string, unknown>[],
  options?: FormatOptions,
): string {
  if (records.length === 0) return ''

  const max = options?.maxItems ?? 10
  const maxChars = options?.maxCharsPerItem ?? 2000
  const header = options?.header ?? '## Context from Memory'

  const items = records.slice(0, max).map(r => {
    const text = typeof r['text'] === 'string' ? r['text'] : JSON.stringify(r)
    return text.length > maxChars ? text.slice(0, maxChars) + '...' : text
  })

  return `${header}\n\n${items.join('\n\n')}`
}
