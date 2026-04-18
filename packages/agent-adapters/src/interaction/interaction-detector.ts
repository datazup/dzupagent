/**
 * Pure functions for detecting and classifying mid-execution interactions
 * from sub-agent output (both text and JSONL records).
 *
 * No I/O, no side effects — safe to call in hot paths.
 */

export type InteractionKind = 'permission' | 'clarification' | 'confirmation' | 'unknown'

// Compiled once at module load
const PERMISSION_RE =
  /\b(allow|permit|grant|approve|permission|access|write|delete|modify|execute|run)\b.*\?/i
const CONFIRMATION_RE =
  /\b(confirm|are you sure|proceed|continue|ok to|okay to|go ahead)\b.*\?/i
const CLARIFICATION_RE =
  /\b(what|which|how|where|when|please\s+(specify|provide|enter|tell|give))\b.*\?/i

/**
 * Classify a text string as an interaction kind using heuristic regexes.
 * Returns 'unknown' if no pattern matches.
 */
export function classifyInteractionText(text: string): InteractionKind {
  if (PERMISSION_RE.test(text)) return 'permission'
  if (CONFIRMATION_RE.test(text)) return 'confirmation'
  if (CLARIFICATION_RE.test(text)) return 'clarification'
  return 'unknown'
}

/**
 * Well-known JSONL event type values that signal an interaction request
 * from CLI-based adapters (Gemini, Qwen, Crush, Goose, etc.).
 */
const INTERACTION_TYPES = new Set([
  'question',
  'permission_request',
  'confirm',
  'confirmation',
  'clarification',
  'user_input',
  'approval_request',
])

/**
 * Detect whether a parsed JSONL record from a CLI adapter represents a
 * mid-execution interaction request.
 *
 * Returns the question text and kind, or null if the record is a normal event.
 */
export function detectCliInteraction(
  record: Record<string, unknown>,
): { question: string; kind: InteractionKind } | null {
  const type = typeof record['type'] === 'string' ? record['type'] : ''

  // Explicit interaction-typed record
  if (INTERACTION_TYPES.has(type)) {
    const text = extractText(record)
    return text ? { question: text, kind: classifyInteractionText(text) } : null
  }

  // Heuristic: any record with a question-looking message field and unknown type
  if (!type || type === 'message' || type === 'output') {
    const text = extractText(record)
    if (text && looksLikeQuestion(text)) {
      return { question: text, kind: classifyInteractionText(text) }
    }
  }

  return null
}

function extractText(record: Record<string, unknown>): string | null {
  // Try common field names for the human-readable content
  for (const key of ['message', 'text', 'question', 'prompt', 'content', 'body']) {
    const val = record[key]
    if (typeof val === 'string' && val.trim().length > 0) {
      return val.trim()
    }
  }
  return null
}

function looksLikeQuestion(text: string): boolean {
  // A question mark near the end is a strong signal
  return text.trimEnd().endsWith('?')
}
