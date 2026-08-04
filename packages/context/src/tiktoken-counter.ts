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
import type {
  TokenCounter,
  TokenMeasurementResult,
} from './token-lifecycle.js'

type JsTiktokenEncoder = { encode(text: string): number[] }

/** `js-tiktoken` exposes camelCase APIs; snake_case belongs to other packages. */
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
const O200K_PREFIXES = [
  'gpt-4o',
  'gpt-4.1',
  'gpt-5',
  'chatgpt-4o',
  'o1',
  'o3',
  'o4',
]

function resolveEncodingName(mod: JsTiktokenModule, model?: string): string {
  if (!model) return DEFAULT_ENCODING
  const normalized = model.toLowerCase()
  const bare = normalized.slice(normalized.lastIndexOf('/') + 1)
  if (O200K_PREFIXES.some((prefix) => bare.startsWith(prefix))) {
    return O200K_ENCODING
  }
  try {
    return mod.getEncodingNameForModel?.(bare) ?? DEFAULT_ENCODING
  } catch {
    return DEFAULT_ENCODING
  }
}

function getEncoder(
  mod: JsTiktokenModule,
  encodingName: string,
): JsTiktokenEncoder | null {
  const cached = encoderCache.get(encodingName)
  if (cached !== undefined) return cached
  let encoder: JsTiktokenEncoder | null = null
  try {
    encoder = mod.getEncoding?.(encodingName) ?? null
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

const MAX_TOKENIZABLE_RUN = 2000
const OVERLONG_RUN = new RegExp(`\\S{${MAX_TOKENIZABLE_RUN + 1},}`)

/**
 * Avoid quadratic tokenizer work on large whitespace-free blobs while still
 * tokenizing ordinary text exactly.
 */
function countWithRunGuard(
  countExact: (chunk: string) => number | undefined,
  text: string,
): number | undefined {
  if (!OVERLONG_RUN.test(text)) return countExact(text)

  let total = 0
  let buffered = ''
  const flush = (): boolean => {
    if (buffered.length === 0) return true
    const count = countExact(buffered)
    buffered = ''
    if (count === undefined) return false
    total += count
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
    return this.countDetailed(text, model).tokens
  }

  countDetailed(text: string, model?: string): TokenMeasurementResult {
    if (text.length === 0) {
      return {
        tokens: 0,
        method: 'exact',
        ...(model ? { model } : {}),
      }
    }

    if (isClaudeModel(model)) {
      try {
        const guarded = OVERLONG_RUN.test(text)
        const claudeCount = countWithRunGuard(countWithAnthropicTokenizer, text)
        if (typeof claudeCount === 'number' && Number.isFinite(claudeCount)) {
          return {
            tokens: Math.max(0, Math.ceil(claudeCount)),
            method: guarded ? 'heuristic' : 'exact',
            ...(model ? { model } : {}),
            encoding: 'anthropic-tokenizer',
            ...(guarded
              ? { reason: 'overlong whitespace-free run used guarded estimate' }
              : {}),
          }
        }
      } catch {
        // Optional Claude tokenizer failures degrade to the shared fallback.
      }
    }

    const mod = tryLoadModule()
    if (!mod) {
      // Fallback: chars/4 heuristic when js-tiktoken is not installed.
      return {
        tokens: heuristicCount(text),
        method: 'heuristic',
        ...(model ? { model } : {}),
        reason: 'optional tokenizer backend unavailable',
      }
    }

    try {
      const encoding = resolveEncodingName(mod, model)
      const encoder = getEncoder(mod, encoding)
      if (!encoder) throw new TypeError('js-tiktoken encoder is unavailable')
      const guarded = OVERLONG_RUN.test(text)
      const tokens = countWithRunGuard(
        (chunk) => encoder.encode(chunk).length,
        text,
      )
      if (tokens === undefined) {
        throw new TypeError('js-tiktoken encoder failed')
      }
      const modelExact = Boolean(
        model &&
          (O200K_PREFIXES.some((prefix) =>
            model.toLowerCase().split('/').at(-1)?.startsWith(prefix),
          ) || mod.getEncodingNameForModel),
      )
      return {
        tokens,
        method: guarded
          ? 'heuristic'
          : modelExact
            ? 'exact'
            : 'encoding-fallback',
        ...(model ? { model } : {}),
        encoding,
        ...(!guarded && modelExact
          ? {}
          : {
              reason: guarded
                ? 'overlong whitespace-free run used guarded estimate'
                : model
                  ? 'model-specific tokenizer unavailable'
                  : 'no model identifier supplied',
            }),
      }
    } catch {
      return {
        tokens: heuristicCount(text),
        method: 'heuristic',
        ...(model ? { model } : {}),
        reason: 'tokenizer encoding failed',
      }
    }
  }
}

export const __internals = {
  isClaudeModel,
  resolveEncodingName(model?: string): string {
    return resolveEncodingName(tryLoadModule() ?? {}, model)
  },
  resetCache(): void {
    cachedModule = undefined
    cachedAnthropicModule = undefined
  },
  resetEncoderCache(): void {
    encoderCache.clear()
  },
}
