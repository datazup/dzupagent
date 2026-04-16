/**
 * Workflow command parser — parses natural-language workflow commands
 * into structured step sequences using separator detection, alias
 * lookup, and optional LLM-backed intent classification.
 */

import type { IntentRouter } from '../router/intent-router.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorkflowSeparatorStyle =
  | 'arrow' | 'pipe' | 'comma' | 'then-keyword' | 'whitespace' | 'alias' | 'unknown'

export interface ParsedStepToken {
  /** Original token, whitespace stripped. */
  raw: string
  /** Kebab-case lowercase normalized form. */
  normalized: string
  /** Zero-based position in the step sequence. */
  index: number
}

export type ParseConfidenceTier = 'heuristic' | 'keyword' | 'llm' | 'default'

export interface CandidateInterpretation {
  steps: string[]
  reason: string
  /** 0-1 confidence score. */
  score: number
}

export interface WorkflowCommandParseSuccess {
  readonly ok: true
  steps: ParsedStepToken[]
  separatorStyle: WorkflowSeparatorStyle
  confidence: ParseConfidenceTier
  rawTokens: string[]
}

export interface WorkflowCommandParseFailure {
  readonly ok: false
  reason: string
  candidateInterpretations: CandidateInterpretation[]
  inputText: string
}

export type WorkflowCommandParseResult = WorkflowCommandParseSuccess | WorkflowCommandParseFailure

export interface WorkflowKeywordPattern {
  pattern: string | RegExp
  impliedSeparator: WorkflowSeparatorStyle
}

export interface WorkflowAliasEntry {
  name: string
  steps: string[]
  description?: string
}

export interface WorkflowCommandParserConfig {
  keywordPatterns?: WorkflowKeywordPattern[]
  aliases?: WorkflowAliasEntry[]
  intentRouter?: IntentRouter
  normalizer?: (raw: string) => string
  logger?: Pick<Console, 'warn'>
}

// ---------------------------------------------------------------------------
// Default normalizer
// ---------------------------------------------------------------------------

function defaultNormalizer(raw: string): string {
  return raw
    .trim()
    .replace(/^sc:/i, '')  // strip sc: prefix
    .toLowerCase()
    .replace(/[\s_]+/g, '-')  // spaces/underscores → hyphens
}

// ---------------------------------------------------------------------------
// Default keyword patterns
// ---------------------------------------------------------------------------

const DEFAULT_KEYWORD_PATTERNS: WorkflowKeywordPattern[] = [
  { pattern: /(?:→|->)/, impliedSeparator: 'arrow' },
  { pattern: /\|/, impliedSeparator: 'pipe' },
  { pattern: /,/, impliedSeparator: 'comma' },
  { pattern: /\bthen\b/i, impliedSeparator: 'then-keyword' },
]

/** Map separator style to the regex used for splitting. */
function getSplitRegex(style: WorkflowSeparatorStyle): RegExp {
  switch (style) {
    case 'arrow': return /\s*(?:→|->)\s*/
    case 'pipe': return /\s*\|\s*/
    case 'comma': return /\s*,\s*/
    case 'then-keyword': return /\s+then\s+/i
    default: return /\s+/
  }
}

// ---------------------------------------------------------------------------
// ReDoS defense
// ---------------------------------------------------------------------------

/**
 * Heuristically detect potentially catastrophic regex patterns.
 * Detects nested quantifiers and alternation-with-common-prefix.
 */
function validatePattern(pattern: string, source: string): void {
  // Detect nested quantifiers: (a+)+ or (a*)* or (a+)* etc.
  const nestedQuantifier = /\([^)]*[+*][^)]*\)[+*?]/
  if (nestedQuantifier.test(pattern)) {
    throw new Error(
      `Potentially unsafe regex pattern "${source}": nested quantifiers detected (ReDoS risk). ` +
      `Review the pattern before use.`
    )
  }
  // Detect alternation with overlapping options: (a|a)+ or (abc|ab)+
  // Simple heuristic: (x|y)+ where the group contains | and a quantifier follows
  const overlappingAlternation = /\([^)]*\|[^)]*\)[+*]/
  if (overlappingAlternation.test(pattern)) {
    throw new Error(
      `Potentially unsafe regex pattern "${source}": alternation with quantifier detected (ReDoS risk). ` +
      `Review the pattern before use.`
    )
  }
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export class WorkflowCommandParser {
  private readonly aliases: Map<string, WorkflowAliasEntry> = new Map()
  private readonly compiledPatterns: Array<{ regex: RegExp; impliedSeparator: WorkflowSeparatorStyle }>
  private readonly intentRouter: IntentRouter | undefined
  private readonly normalize: (raw: string) => string
  private readonly logger: Pick<Console, 'warn'> | undefined

  constructor(config?: WorkflowCommandParserConfig) {
    this.compiledPatterns = (config?.keywordPatterns ?? DEFAULT_KEYWORD_PATTERNS).map(kp => {
      try {
        const patternStr = kp.pattern instanceof RegExp ? null : kp.pattern
        if (patternStr !== null) {
          validatePattern(patternStr, patternStr)
        }
        return { regex: kp.pattern instanceof RegExp ? kp.pattern : new RegExp(kp.pattern), impliedSeparator: kp.impliedSeparator }
      } catch (e) {
        throw new Error(`Invalid regex pattern "${String(kp.pattern)}": ${(e as Error).message}`)
      }
    })
    this.intentRouter = config?.intentRouter
    this.normalize = config?.normalizer ?? defaultNormalizer
    this.logger = config?.logger

    if (config?.aliases) {
      for (const alias of config.aliases) {
        this.aliases.set(alias.name.toLowerCase().trim(), alias)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Alias management
  // -------------------------------------------------------------------------

  addAlias(name: string, steps: string[]): void {
    const key = name.toLowerCase().trim()
    this.aliases.set(key, { name, steps })
  }

  listAliases(): ReadonlyArray<WorkflowAliasEntry> {
    return [...this.aliases.values()]
  }

  // -------------------------------------------------------------------------
  // Synchronous parse
  // -------------------------------------------------------------------------

  parse(text: string): WorkflowCommandParseResult {
    const trimmed = text.trim()
    if (trimmed.length === 0) {
      return {
        ok: false,
        reason: 'Empty input text',
        candidateInterpretations: [],
        inputText: text,
      }
    }

    // 1. Alias lookup
    const aliasKey = trimmed.toLowerCase().trim()
    const alias = this.aliases.get(aliasKey)
    if (alias) {
      const tokens = alias.steps.map((s, i) => this.buildToken(s, i))
      return {
        ok: true,
        steps: tokens,
        separatorStyle: 'alias',
        confidence: 'heuristic',
        rawTokens: alias.steps,
      }
    }

    // 2. Pattern matching (uses pre-compiled regexps)
    for (const cp of this.compiledPatterns) {
      if (cp.regex.test(trimmed)) {
        const splitRe = getSplitRegex(cp.impliedSeparator)
        const rawTokens = trimmed.split(splitRe).filter((t) => t.trim().length > 0)
        if (rawTokens.length >= 2) {
          const tokens = rawTokens.map((t, i) => this.buildToken(t, i))
          return {
            ok: true,
            steps: tokens,
            separatorStyle: cp.impliedSeparator,
            confidence: 'keyword',
            rawTokens,
          }
        }
      }
    }

    // 3. Single-token check
    const normalized = this.normalize(trimmed)
    if (normalized.length > 0) {
      return {
        ok: true,
        steps: [this.buildToken(trimmed, 0)],
        separatorStyle: 'unknown',
        confidence: 'default',
        rawTokens: [trimmed],
      }
    }

    // 4. Failure
    return {
      ok: false,
      reason: 'No separator detected and normalization produced empty result',
      candidateInterpretations: [],
      inputText: text,
    }
  }

  // -------------------------------------------------------------------------
  // Async parse (with optional LLM fallback)
  // -------------------------------------------------------------------------

  async parseAsync(text: string): Promise<WorkflowCommandParseResult> {
    const result = this.parse(text)
    if (result.ok) return result

    if (this.intentRouter) {
      try {
        const classification = await this.intentRouter.classify(text)
        if (classification.confidence !== 'default') {
          const steps = [classification.intent]
          const tokens = steps.map((s, i) => this.buildToken(s, i))
          return {
            ok: true,
            steps: tokens,
            separatorStyle: 'unknown',
            confidence: 'llm',
            rawTokens: steps,
          }
        }
      } catch (err) {
        // LLM failure is non-fatal — log and fall through to returning the parse failure
        this.logger?.warn('[WorkflowCommandParser] LLM fallback failed', { error: err, inputText: text })
      }
    }

    return result
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private buildToken(raw: string, index: number): ParsedStepToken {
    return {
      raw: raw.trim(),
      normalized: this.normalize(raw),
      index,
    }
  }
}
