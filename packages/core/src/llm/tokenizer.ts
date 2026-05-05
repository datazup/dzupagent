/**
 * Tokenizer abstractions with lazy-loaded backends and a zero-dep heuristic
 * fallback.
 *
 * The framework cannot hard-depend on `@anthropic-ai/tokenizer` or
 * `js-tiktoken` (they are optional, large, and platform sensitive). Instead,
 * each provider-specific tokenizer attempts a lazy `require` of its backend
 * and falls back to the char/4 heuristic when the backend is unavailable.
 *
 * Public surface intentionally keeps `countTokens()` synchronous so callers
 * (compression triggers, budget warnings, fragment composers) can treat
 * tokenizers as cheap, predictable utilities.
 */
import type { BaseMessage } from '@langchain/core/messages'

/** Generic chat-message shape compatible with LangChain BaseMessage and plain objects. */
export interface TokenizableMessage {
  content: unknown
  role?: string
  type?: string
}

/** Common interface implemented by every tokenizer backend. */
export interface Tokenizer {
  /** Identifier of the underlying tokenizer model (e.g. `claude-3-5-sonnet`, `gpt-4o`, `heuristic`). */
  readonly model: string
  /**
   * Encode `text` into a numeric token-id array. When the underlying backend
   * is unavailable, returns an array of length `countTokens(text)` filled
   * with placeholder zeros so callers can still rely on `.length`.
   */
  encode(text: string): number[]
  /** Count tokens in `text`. Always synchronous and never throws. */
  countTokens(text: string): number
  /** Sum tokens across an array of messages. */
  countMessages(messages: ReadonlyArray<TokenizableMessage | BaseMessage>): number
}

function messageContentToString(content: unknown): string {
  if (typeof content === 'string') return content
  if (content == null) return ''
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

/**
 * Char/4 fallback tokenizer. Zero dependencies, always available, deterministic.
 * Treat as a coarse upper-bound rather than a precise count.
 */
export class HeuristicTokenizer implements Tokenizer {
  readonly model: string
  constructor(model = 'heuristic') {
    this.model = model
  }
  encode(text: string): number[] {
    return new Array<number>(this.countTokens(text)).fill(0)
  }
  countTokens(text: string): number {
    if (!text) return 0
    return Math.ceil(text.length / 4)
  }
  countMessages(messages: ReadonlyArray<TokenizableMessage | BaseMessage>): number {
    let sum = 0
    for (const m of messages) {
      sum += this.countTokens(messageContentToString((m as TokenizableMessage).content))
    }
    return sum
  }
}

/**
 * Attempt to load an optional tokenizer backend without breaking the build
 * when the dependency is not installed. Uses a dynamic, runtime resolution
 * via `Function('return import(...)')` to defer to ESM dynamic import while
 * keeping bundlers from statically following the path.
 */
function tryLoadOptionalSync<T = unknown>(moduleId: string): T | null {
  // We avoid top-level `import` so missing optional deps don't break the build.
  // We try CommonJS `require` first (works under tsx/node ESM with createRequire),
  // then fall back to nothing — async dynamic import is not safe here because
  // countTokens must remain synchronous.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req = (globalThis as any).require as undefined | ((id: string) => unknown)
    if (typeof req === 'function') {
      return req(moduleId) as T
    }
  } catch {
    // fall through
  }
  try {
    // Node ESM: use createRequire on import.meta.url-style fallback via process.cwd().
    // We avoid importing 'module' statically; lazy access keeps browser builds clean.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proc = (globalThis as any).process as { cwd?: () => string } | undefined
    if (!proc?.cwd) return null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodeModule = (globalThis as any).__non_webpack_require__ ?? null
    if (typeof nodeModule === 'function') {
      return nodeModule(moduleId) as T
    }
  } catch {
    // fall through
  }
  return null
}

/**
 * Anthropic tokenizer. Requires the optional `@anthropic-ai/tokenizer`
 * package. When unavailable, falls back to the heuristic char/4 estimator.
 */
export class AnthropicTokenizer implements Tokenizer {
  readonly model: string
  private backend: { countTokens?: (text: string) => number; getTokenizer?: () => { encode: (t: string) => { length: number } | number[] } } | null = null
  private fallback = new HeuristicTokenizer('heuristic')
  private resolved = false

  constructor(model = 'claude-3-5-sonnet-20241022') {
    this.model = model
  }

  private ensureBackend(): void {
    if (this.resolved) return
    this.resolved = true
    const mod = tryLoadOptionalSync<{
      countTokens?: (text: string) => number
      getTokenizer?: () => { encode: (t: string) => { length: number } | number[] }
    }>('@anthropic-ai/tokenizer')
    if (mod) this.backend = mod
  }

  encode(text: string): number[] {
    this.ensureBackend()
    if (this.backend?.getTokenizer) {
      try {
        const tk = this.backend.getTokenizer()
        const out = tk.encode(text)
        if (Array.isArray(out)) return out
        if (out && typeof (out as { length?: number }).length === 'number') {
          return new Array<number>((out as { length: number }).length).fill(0)
        }
      } catch {
        // fall through to heuristic
      }
    }
    return this.fallback.encode(text)
  }

  countTokens(text: string): number {
    if (!text) return 0
    this.ensureBackend()
    if (this.backend?.countTokens) {
      try {
        const n = this.backend.countTokens(text)
        if (typeof n === 'number' && Number.isFinite(n) && n >= 0) return n
      } catch {
        // fall through
      }
    }
    if (this.backend?.getTokenizer) {
      try {
        const tk = this.backend.getTokenizer()
        const out = tk.encode(text)
        if (Array.isArray(out)) return out.length
        if (out && typeof (out as { length?: number }).length === 'number') {
          return (out as { length: number }).length
        }
      } catch {
        // fall through
      }
    }
    return this.fallback.countTokens(text)
  }

  countMessages(messages: ReadonlyArray<TokenizableMessage | BaseMessage>): number {
    let sum = 0
    for (const m of messages) {
      sum += this.countTokens(messageContentToString((m as TokenizableMessage).content))
    }
    return sum
  }
}

/**
 * OpenAI/Codex tokenizer backed by `js-tiktoken` (browser-safe pure JS).
 * Falls back to heuristic when the dependency is missing.
 */
export class TiktokenTokenizer implements Tokenizer {
  readonly model: string
  private encoder: { encode: (t: string) => { length: number } | number[] } | null = null
  private fallback = new HeuristicTokenizer('heuristic')
  private resolved = false

  constructor(model = 'gpt-4o') {
    this.model = model
  }

  private ensureBackend(): void {
    if (this.resolved) return
    this.resolved = true
    const mod = tryLoadOptionalSync<{
      encodingForModel?: (m: string) => { encode: (t: string) => number[] }
      getEncoding?: (name: string) => { encode: (t: string) => number[] }
    }>('js-tiktoken')
    if (!mod) return
    try {
      if (mod.encodingForModel) {
        this.encoder = mod.encodingForModel(this.model)
        return
      }
      if (mod.getEncoding) {
        this.encoder = mod.getEncoding('cl100k_base')
      }
    } catch {
      this.encoder = null
    }
  }

  encode(text: string): number[] {
    this.ensureBackend()
    if (this.encoder) {
      try {
        const out = this.encoder.encode(text)
        if (Array.isArray(out)) return out
        if (out && typeof (out as { length?: number }).length === 'number') {
          return new Array<number>((out as { length: number }).length).fill(0)
        }
      } catch {
        // fall through
      }
    }
    return this.fallback.encode(text)
  }

  countTokens(text: string): number {
    if (!text) return 0
    this.ensureBackend()
    if (this.encoder) {
      try {
        const out = this.encoder.encode(text)
        if (Array.isArray(out)) return out.length
        if (out && typeof (out as { length?: number }).length === 'number') {
          return (out as { length: number }).length
        }
      } catch {
        // fall through
      }
    }
    return this.fallback.countTokens(text)
  }

  countMessages(messages: ReadonlyArray<TokenizableMessage | BaseMessage>): number {
    // OpenAI accounts ~3 tokens of overhead per message plus role naming.
    // We approximate with +4/message which matches their published guidance.
    let sum = 0
    for (const m of messages) {
      sum += this.countTokens(messageContentToString((m as TokenizableMessage).content)) + 4
    }
    // +2 for the assistant priming the reply
    return sum > 0 ? sum + 2 : 0
  }
}
