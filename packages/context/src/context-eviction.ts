/**
 * Context eviction for large content blocks.
 *
 * Implements the 20K-token auto-eviction pattern: when a content string
 * exceeds the token threshold it is replaced with a head/tail preview
 * so the agent can decide whether to read specific sections.
 */

export interface EvictionConfig {
  /** Estimated token threshold before eviction triggers (default 20 000) */
  tokenThreshold: number
  /** Characters per token for rough estimation (default 4) */
  charsPerToken: number
  /** Number of lines to keep from the beginning (default 50) */
  headLines: number
  /** Number of lines to keep from the end (default 20) */
  tailLines: number
}

const DEFAULTS: EvictionConfig = {
  tokenThreshold: 20_000,
  charsPerToken: 4,
  headLines: 50,
  tailLines: 20,
}

export interface EvictionResult {
  /** Whether the content was truncated */
  evicted: boolean
  /** The (possibly truncated) content */
  content: string
  /** Original character length (only set when evicted) */
  originalLength?: number
  /** Original line count (only set when evicted) */
  lineCount?: number
}

/**
 * If `content` exceeds the token threshold, return a head/tail preview.
 * Otherwise return the content unchanged.
 *
 * @param content    The raw text to evaluate
 * @param identifier A file path or label used in the "read more" hint
 * @param config     Optional overrides for thresholds
 */
export function evictIfNeeded(
  content: string,
  identifier: string,
  config?: Partial<EvictionConfig>,
): EvictionResult {
  const cfg = { ...DEFAULTS, ...config }
  const charThreshold = cfg.tokenThreshold * cfg.charsPerToken

  if (content.length < charThreshold) {
    return { evicted: false, content }
  }

  const lines = content.split('\n')
  const lineCount = lines.length
  const head = lines.slice(0, cfg.headLines).join('\n')
  const tail = lines.slice(-cfg.tailLines).join('\n')
  const omitted = Math.max(0, lineCount - cfg.headLines - cfg.tailLines)

  const preview = [
    `[Content truncated — ${lineCount} lines, ~${Math.ceil(content.length / cfg.charsPerToken)} tokens]`,
    '',
    `--- First ${cfg.headLines} lines ---`,
    head,
    '',
    `--- [${omitted} lines omitted] ---`,
    '',
    `--- Last ${cfg.tailLines} lines ---`,
    tail,
    '',
    `[Use read_file("${identifier}", { offset, limit }) to view specific sections]`,
  ].join('\n')

  return { evicted: true, content: preview, originalLength: content.length, lineCount }
}
