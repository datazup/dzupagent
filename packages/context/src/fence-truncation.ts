/**
 * Fence-aware truncation for the message-manager compression phases
 * (tool-result pruning and the summary transcript).
 */

const FENCE_OPEN_RE = /<\s*untrusted_content\b[^>]*>/gi
const FENCE_CLOSE_RE = /<\s*\/\s*untrusted_content\s*>/gi
const FENCE_TAG_AT_START_RE = /^<\s*\/?\s*untrusted_content\b/i
const FENCE_CLOSE_TAG = '</untrusted_content>'

/**
 * Truncate `content` to `maxChars` without leaving an `<untrusted_content>`
 * fence open (DZUPAGENT-AGENT-H-53). A fence tag cut in half at the boundary
 * is dropped, `marker` is appended inside any still-open fence, and each open
 * fence is re-closed so later prompt text never lands inside quoted data.
 */
export function truncatePreservingFences(
  content: string,
  maxChars: number,
  marker = '',
): string {
  if (content.length <= maxChars) return content
  let head = content.slice(0, Math.max(0, maxChars))
  const lastLt = head.lastIndexOf('<')
  if (lastLt !== -1 && !head.slice(lastLt).includes('>')
    && FENCE_TAG_AT_START_RE.test(content.slice(lastLt))) {
    head = head.slice(0, lastLt)
  }
  const opens = head.match(FENCE_OPEN_RE)?.length ?? 0
  const closes = head.match(FENCE_CLOSE_RE)?.length ?? 0
  const unclosed = Math.max(0, opens - closes)
  return head + marker + `\n${FENCE_CLOSE_TAG}`.repeat(unclosed)
}
