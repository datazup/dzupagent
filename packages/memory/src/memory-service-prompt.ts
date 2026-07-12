/**
 * Prompt-formatting helper for {@link MemoryService}.
 *
 * Pure function — turns an array of memory records into a prompt-ready
 * string with truncation and optional header.
 */
import { PromptInjectionGuard } from '@dzupagent/security'
import type { FormatOptions } from './memory-types.js'

/**
 * DZUPAGENT-SEC-H-05 — stored memory records cross a trust boundary back
 * into the model context and enable persistent, cross-session prompt
 * injection (a poisoned record recalled in a later session). The write-time
 * scan is a bypassable regex, so read-time neutralization is required.
 *
 * Route recalled record text through the same {@link PromptInjectionGuard}
 * the tool-result path uses
 * (`packages/agent/src/agent/tool-loop/result-pipeline.ts`) so an injected
 * directive inside a record ("IGNORE ALL PREVIOUS INSTRUCTIONS AND ...") is
 * presented as clearly-delimited, provenance-labelled external data rather
 * than authoritative instruction. The guard is stateless — a single shared
 * instance is safe.
 */
const MEMORY_INJECTION_GUARD = new PromptInjectionGuard()

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

  // SEC-H-05: the record text is untrusted. The framework-authored `header`
  // stays outside the block as a trusted label; every recalled record is
  // enclosed in the canonical `<untrusted_content source="memory_recall">`
  // delimiter with non-blocking injection screening.
  const body = MEMORY_INJECTION_GUARD.wrap(items.join('\n\n'), {
    label: 'memory_recall',
    screen: true,
  })

  return `${header}\n\n${body}`
}
