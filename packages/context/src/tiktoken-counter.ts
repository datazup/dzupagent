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

type JsTiktokenModule = {
  encoding_for_model: (model: string) => { encode(text: string): number[] }
  get_encoding: (encoding: string) => { encode(text: string): number[] }
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

export class TiktokenCounter implements TokenCounter {
  count(text: string, model?: string): number {
    if (text.length === 0) return 0

    if (isClaudeModel(model)) {
      try {
        const claudeCount = countWithAnthropicTokenizer(text)
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
      const encoder = model && model.startsWith('gpt')
        ? mod.encoding_for_model(model)
        : mod.get_encoding('cl100k_base')
      return encoder.encode(text).length
    } catch {
      // Unknown model or encoder failure — degrade to heuristic.
      return heuristicCount(text)
    }
  }
}

export const __internals = {
  isClaudeModel,
  resetCache(): void {
    cachedModule = undefined
    cachedAnthropicModule = undefined
  },
}
