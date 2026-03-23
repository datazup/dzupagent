/**
 * Fast keyword-based intent classification — no LLM needed.
 */

interface PatternEntry {
  pattern: RegExp
  intent: string
}

export class KeywordMatcher {
  private patterns: PatternEntry[] = []

  /** Add a regex pattern that maps to an intent */
  addPattern(pattern: RegExp, intent: string): this {
    this.patterns.push({ pattern, intent })
    return this
  }

  /** Return the first matching intent, or null */
  match(text: string): string | null {
    for (const entry of this.patterns) {
      if (entry.pattern.test(text)) {
        return entry.intent
      }
    }
    return null
  }

  /** Return all matching intents */
  matchAll(text: string): string[] {
    return this.patterns
      .filter(entry => entry.pattern.test(text))
      .map(entry => entry.intent)
  }
}
