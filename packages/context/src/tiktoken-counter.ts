/**
 * `js-tiktoken`-backed token counter. Accurate for OpenAI-compatible
 * vocabularies (GPT-3.5 / GPT-4 / GPT-4o / GPT-5 families), falls back to
 * `cl100k_base` for unknown model identifiers and finally to a `chars/4`
 * heuristic if the `js-tiktoken` dependency isn't installed at runtime.
 *
 * `js-tiktoken` is declared as an optional peer dependency of
 * `@dzupagent/context` — callers who want accurate counting should install
 * it in their top-level app:
 *
 *     yarn add js-tiktoken
 *
 * No import of `js-tiktoken` is performed at module load: the lookup is
 * lazy inside `count()` and swallowed on any error to keep this module
 * safe when the dep is missing.
 */

import { createRequire } from 'node:module'
import type { TokenCounter } from './token-lifecycle.js'

type JsTiktokenEncoder = { encode(text: string): number[] }

/**
 * `js-tiktoken`'s public surface is camelCase (`getEncoding`,
 * `encodingForModel`, `getEncodingNameForModel`). The snake_case names
 * (`get_encoding` / `encoding_for_model`) belong to the *wasm* `tiktoken` /
 * `@dqbd/tiktoken` packages and are `undefined` here — calling them threw on
 * every count, which silently degraded 100% of counts to the chars/4
 * heuristic (DZUPAGENT-AGENT-C-01).
 */
type JsTiktokenModule = {
  encodingForModel?: (model: string) => JsTiktokenEncoder
  getEncoding?: (encoding: string) => JsTiktokenEncoder
  getEncodingNameForModel?: (model: string) => string
}

type AnthropicTokenizerModule = {
  countTokens?: (text: string) => number
  count_tokens?: (text: string) => number
  encode?: (text: string) => number[]
  default?: {
    countTokens?: (text: string) => number
    count_tokens?: (text: string) => number
    encode?: (text: string) => number[]
  }
}

let cachedModule: JsTiktokenModule | null | undefined
let cachedAnthropicModule: AnthropicTokenizerModule | null | undefined
const encoderCache = new Map<string, JsTiktokenEncoder | null>()

const DEFAULT_ENCODING = 'cl100k_base'
const O200K_ENCODING = 'o200k_base'

/**
 * Model-id prefixes that use the `o200k_base` vocabulary. Everything else
 * that looks like an OpenAI id keeps `cl100k_base`.
 */
const O200K_PREFIXES = ['gpt-4o', 'gpt-4.1', 'gpt-5', 'chatgpt-4o', 'o1', 'o3', 'o4']

/**
 * Resolve the tiktoken encoding name for a model id. Explicit prefix routing
 * runs first so newer ids (`gpt-5.x`, `o4-*`) resolve correctly even on a
 * `js-tiktoken` build whose model table predates them; the library's own
 * lookup is consulted second, and `cl100k_base` is the final default.
 */
function resolveEncodingName(mod: JsTiktokenModule, model?: string): string {
  if (!model) return DEFAULT_ENCODING
  const normalized = model.toLowerCase()
  // Strip a provider prefix such as `openai/` or `azure/`.
  const bare = normalized.slice(normalized.lastIndexOf('/') + 1)
  if (O200K_PREFIXES.some(p => bare.startsWith(p))) return O200K_ENCODING
  if (typeof mod.getEncodingNameForModel === 'function') {
    try {
      return mod.getEncodingNameForModel(bare)
    } catch {
      // Unknown model id — fall through to the default vocabulary.
    }
  }
  return DEFAULT_ENCODING
}

function getEncoder(mod: JsTiktokenModule, encodingName: string): JsTiktokenEncoder | null {
  const cached = encoderCache.get(encodingName)
  if (cached !== undefined) return cached
  let encoder: JsTiktokenEncoder | null = null
  try {
    encoder = typeof mod.getEncoding === 'function' ? mod.getEncoding(encodingName) : null
  } catch {
    encoder = null
  }
  encoderCache.set(encodingName, encoder)
  return encoder
}

function tryLoadModule(): JsTiktokenModule | null {
  if (cachedModule !== undefined) return cachedModule
  try {
    // `js-tiktoken` is an optional peer dep — use createRequire so the
    // module loader doesn't bundle it at build time. When it's missing the
    // thrown error is caught below and we fall back to the chars/4
    // heuristic.
    const req = createRequire(import.meta.url)
    const mod = req('js-tiktoken') as JsTiktokenModule
    cachedModule = mod
    return mod
  } catch {
    cachedModule = null
    return null
  }
}

function tryLoadAnthropicModule(): AnthropicTokenizerModule | null {
  if (cachedAnthropicModule !== undefined) return cachedAnthropicModule
  try {
    const req = createRequire(import.meta.url)
    const mod = req('@anthropic-ai/tokenizer') as AnthropicTokenizerModule
    cachedAnthropicModule = mod
    return mod
  } catch {
    cachedAnthropicModule = null
    return null
  }
}

function isClaudeModel(model?: string): boolean {
  if (!model) return false
  const normalized = model.toLowerCase()
  return normalized.startsWith('claude-')
    || normalized.includes('/claude')
    || normalized.includes('.claude')
}

function countWithAnthropicTokenizer(text: string): number | undefined {
  const mod = tryLoadAnthropicModule()
  if (!mod) return undefined

  const candidate = mod.default ?? mod
  if (typeof candidate.countTokens === 'function') {
    return candidate.countTokens(text)
  }
  if (typeof candidate.count_tokens === 'function') {
    return candidate.count_tokens(text)
  }
  if (typeof candidate.encode === 'function') {
    return candidate.encode(text).length
  }
  return undefined
}

function heuristicCount(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Longest whitespace-free run handed to the BPE encoder.
 *
 * `js-tiktoken` splits input into words with a regex and then runs byte-pair
 * merges **per word**, and that merge loop is quadratic in the word's length.
 * Ordinary prose never trips it (measured: a 2.5 KB English paragraph encodes
 * in microseconds), but a base64 blob, a minified bundle or a long hash in a
 * tool result is a single multi-kilobyte "word" — measured 9.9 s for a 1 000
 * char run and 66 s for 5 000 on a loaded box, growing quadratically, all of
 * it blocking the event loop.
 *
 * Runs longer than this are estimated with the chars/4 heuristic instead. The
 * surrounding text is still tokenized exactly, so this only degrades accuracy
 * for the opaque blobs where an exact count is least meaningful.
 */
const MAX_TOKENIZABLE_RUN = 2000
const OVERLONG_RUN = new RegExp(`\\S{${MAX_TOKENIZABLE_RUN + 1},}`)

/**
 * Count `text` with `countExact`, substituting the chars/4 heuristic for any
 * whitespace-free run longer than {@link MAX_TOKENIZABLE_RUN}. Applies to both
 * backends — `js-tiktoken` and `@anthropic-ai/tokenizer` are both quadratic
 * per word (measured: a 50 KB unbroken run costs 2 ms guarded vs 38 600 ms
 * unguarded on the Anthropic tokenizer).
 *
 * Returns `undefined` as soon as `countExact` does, so an unavailable backend
 * still falls through to the caller's own fallback.
 */
function countWithRunGuard(
  countExact: (chunk: string) => number | undefined,
  text: string,
): number | undefined {
  if (!OVERLONG_RUN.test(text)) return countExact(text)

  let total = 0
  let buffered = ''
  // Splitting on a capturing whitespace group keeps the separators, so
  // `buffered` reconstructs the original text exactly for tokenized parts.
  const flush = (): boolean => {
    if (buffered.length === 0) return true
    const n = countExact(buffered)
    buffered = ''
    if (n === undefined) return false
    total += n
    return true
  }

  for (const part of text.split(/(\s+)/)) {
    if (part.length > MAX_TOKENIZABLE_RUN && part.trim().length > 0) {
      if (!flush()) return undefined
      total += heuristicCount(part)
    } else {
      buffered += part
    }
  }
  return flush() ? total : undefined
}

export class TiktokenCounter implements TokenCounter {
  count(text: string, model?: string): number {
    if (text.length === 0) return 0

    if (isClaudeModel(model)) {
      try {
        const claudeCount = countWithRunGuard(countWithAnthropicTokenizer, text)
        if (typeof claudeCount === 'number' && Number.isFinite(claudeCount)) {
          return Math.max(0, Math.ceil(claudeCount))
        }
      } catch {
        // Optional Claude tokenizer failures degrade to the shared fallback.
      }
    }

    const mod = tryLoadModule()
    if (!mod) {
      // Fallback: chars/4 heuristic when js-tiktoken is not installed.
      return heuristicCount(text)
    }
    try {
      const encoder = getEncoder(mod, resolveEncodingName(mod, model))
      if (!encoder) return heuristicCount(text)
      return countWithRunGuard(chunk => encoder.encode(chunk).length, text)
        ?? heuristicCount(text)
    } catch {
      // Unknown model or encoder failure — degrade to heuristic.
      return heuristicCount(text)
    }
  }
}

export const __internals = {
  isClaudeModel,
  /** Encoding routing, exposed for tests (`gpt-4o` → `o200k_base`). */
  resolveEncodingName(model?: string): string {
    return resolveEncodingName(tryLoadModule() ?? {}, model)
  },
  /**
   * Reset the optional-module lookups. Deliberately does **not** discard
   * built encoders: they are pure, keyed by encoding name, and rebuilding a
   * BPE rank table costs seconds. Use {@link __internals.resetEncoderCache}
   * when a test genuinely needs a cold encoder.
   */
  resetCache(): void {
    cachedModule = undefined
    cachedAnthropicModule = undefined
  },
  resetEncoderCache(): void {
    encoderCache.clear()
  },
}
