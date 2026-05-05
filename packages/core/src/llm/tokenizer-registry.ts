/**
 * Registry that maps model identifiers to {@link Tokenizer} implementations.
 *
 * Patterns are evaluated in registration order; the first match wins. Falls
 * back to a {@link HeuristicTokenizer} when no pattern matches so callers can
 * always rely on a non-null result.
 */
import {
  AnthropicTokenizer,
  HeuristicTokenizer,
  TiktokenTokenizer,
  type Tokenizer,
} from './tokenizer.js'

interface RegistryEntry {
  pattern: RegExp
  factory: (modelId: string) => Tokenizer
}

export class TokenizerRegistry {
  private readonly entries: RegistryEntry[] = []
  private readonly fallback: Tokenizer = new HeuristicTokenizer()

  /**
   * Register a tokenizer for models matching `pattern`.
   *
   * `tokenizer` may be:
   *  - a concrete {@link Tokenizer} instance (reused across all matched models)
   *  - a factory that receives the matched modelId and returns a tokenizer
   */
  register(
    pattern: RegExp | string,
    tokenizer: Tokenizer | ((modelId: string) => Tokenizer),
  ): this {
    const re = typeof pattern === 'string' ? new RegExp(pattern, 'i') : pattern
    const factory =
      typeof tokenizer === 'function' ? tokenizer : (() => tokenizer)
    this.entries.unshift({ pattern: re, factory })
    return this
  }

  /** Resolve the first matching tokenizer, or the heuristic fallback. */
  resolve(modelId: string): Tokenizer {
    for (const entry of this.entries) {
      if (entry.pattern.test(modelId)) {
        try {
          return entry.factory(modelId)
        } catch {
          // factory failure is non-fatal — try next pattern
        }
      }
    }
    return this.fallback
  }

  /** Alias of {@link resolve} for callers that prefer the explicit name. */
  resolveOrFallback(modelId: string): Tokenizer {
    return this.resolve(modelId)
  }

  /** Remove all registrations (primarily for tests). */
  clear(): this {
    this.entries.length = 0
    return this
  }
}

function buildDefaultRegistry(): TokenizerRegistry {
  const reg = new TokenizerRegistry()
  // Order matters because register() prepends — register the most generic
  // patterns first so they sit at the bottom of the match list.
  reg.register(/gpt-|o[0-9]/i, (id) => new TiktokenTokenizer(id))
  reg.register(/claude/i, (id) => new AnthropicTokenizer(id))
  return reg
}

/** Process-wide singleton with sensible defaults pre-registered. */
export const defaultTokenizerRegistry: TokenizerRegistry = buildDefaultRegistry()
