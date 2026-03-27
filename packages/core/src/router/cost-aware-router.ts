/**
 * Cost-aware model tier routing.
 *
 * Wraps IntentRouter to additionally decide which ModelTier should serve
 * a given turn. Simple/short messages are routed to the cheaper "chat" tier
 * even if the intent would normally use "codegen" or "reasoning".
 *
 * Inspired by Hermes Agent's smart_model_routing.py.
 */
import type { ModelTier } from '../llm/model-config.js'
import type { IntentRouter, ClassificationResult } from './intent-router.js'

/** Complexity level: simple → chat, moderate → codegen, complex → reasoning */
export type ComplexityLevel = 'simple' | 'moderate' | 'complex'

export interface CostAwareResult extends ClassificationResult {
  /** Recommended model tier for this turn */
  modelTier: ModelTier
  /** Why this tier was chosen */
  routingReason: 'simple_turn' | 'complex_turn' | 'reasoning_turn' | 'forced'
  /** Detected complexity level */
  complexity: ComplexityLevel
}

export interface CostAwareRouterConfig {
  intentRouter: IntentRouter
  /** Max character length for a "simple" message (default 200) */
  maxSimpleChars?: number
  /** Max word count for a "simple" message (default 30) */
  maxSimpleWords?: number
  /** Intents that always require the expensive tier regardless of message length */
  forceExpensiveIntents?: string[]
  /** Intents that always require the reasoning tier */
  forceReasoningIntents?: string[]
  /** Model tier for simple turns (default "chat") */
  cheapTier?: ModelTier
  /** Model tier for moderate complexity turns (default "codegen") */
  expensiveTier?: ModelTier
  /** Model tier for high complexity reasoning turns (default "reasoning") */
  reasoningTier?: ModelTier
}

/** Keywords that signal code/debugging complexity — route to codegen */
const COMPLEXITY_KEYWORDS = [
  'debug', 'implement', 'refactor', 'migrate', 'architect',
  'schema', 'migration', 'deploy', 'pipeline', 'generate',
  'create feature', 'build', 'fix bug', 'optimize', 'test',
  'security', 'authentication', 'database', 'api endpoint',
  'component', 'integration', 'dockerfile', 'ci/cd', 'prisma',
  'graphql', 'websocket', 'middleware', 'typescript', 'eslint',
]

/** Keywords that signal architecture/analysis complexity — route to reasoning */
const REASONING_KEYWORDS = [
  'architect', 'design system', 'trade-off', 'tradeoff', 'compare approaches',
  'evaluate', 'review architecture', 'plan migration', 'root cause',
  'system design', 'scaling strategy', 'data model', 'cross-cutting',
  'performance analysis', 'threat model', 'incident review',
  'multi-service', 'distributed', 'consensus', 'consistency model',
]

const DEFAULTS = {
  maxSimpleChars: 200,
  maxSimpleWords: 30,
  cheapTier: 'chat' as ModelTier,
  expensiveTier: 'codegen' as ModelTier,
  reasoningTier: 'reasoning' as ModelTier,
}

/**
 * Determines if a message is simple enough for the cheap model tier.
 *
 * A message is "simple" when it is short, single-line, has no code blocks
 * or URLs, and contains none of the complexity keywords.
 */
export function isSimpleTurn(
  text: string,
  maxChars = DEFAULTS.maxSimpleChars,
  maxWords = DEFAULTS.maxSimpleWords,
): boolean {
  if (text.length > maxChars) return false
  if (text.split(/\s+/).length > maxWords) return false
  if (text.includes('\n')) return false
  if (text.includes('```')) return false
  if (/https?:\/\//.test(text)) return false

  const lower = text.toLowerCase()
  for (const kw of COMPLEXITY_KEYWORDS) {
    if (lower.includes(kw)) return false
  }

  return true
}

/**
 * Score message complexity into 3 tiers:
 * - simple: short, no keywords, no code → chat model
 * - moderate: code/implementation keywords → codegen model
 * - complex: architecture/analysis/multi-system reasoning → reasoning model
 */
export function scoreComplexity(
  text: string,
  maxSimpleChars = DEFAULTS.maxSimpleChars,
  maxSimpleWords = DEFAULTS.maxSimpleWords,
): ComplexityLevel {
  if (isSimpleTurn(text, maxSimpleChars, maxSimpleWords)) {
    return 'simple'
  }

  const lower = text.toLowerCase()

  // Check for reasoning-level complexity first (higher priority)
  let reasoningSignals = 0
  for (const kw of REASONING_KEYWORDS) {
    if (lower.includes(kw)) reasoningSignals++
  }
  // Multi-line + long text + reasoning keywords = complex
  const lineCount = text.split('\n').length
  if (reasoningSignals >= 2) return 'complex'
  if (reasoningSignals >= 1 && lineCount > 5) return 'complex'
  if (lineCount > 10 && text.length > 1000) return 'complex'

  return 'moderate'
}

export class CostAwareRouter {
  private readonly cfg: Required<Omit<CostAwareRouterConfig, 'intentRouter' | 'forceExpensiveIntents' | 'forceReasoningIntents'>>
  private readonly intentRouter: IntentRouter
  private readonly forceExpensive: Set<string>
  private readonly forceReasoning: Set<string>

  constructor(config: CostAwareRouterConfig) {
    this.intentRouter = config.intentRouter
    this.forceExpensive = new Set(config.forceExpensiveIntents ?? [])
    this.forceReasoning = new Set(config.forceReasoningIntents ?? [])
    this.cfg = {
      maxSimpleChars: config.maxSimpleChars ?? DEFAULTS.maxSimpleChars,
      maxSimpleWords: config.maxSimpleWords ?? DEFAULTS.maxSimpleWords,
      cheapTier: config.cheapTier ?? DEFAULTS.cheapTier,
      expensiveTier: config.expensiveTier ?? DEFAULTS.expensiveTier,
      reasoningTier: config.reasoningTier ?? DEFAULTS.reasoningTier,
    }
  }

  /**
   * Classify the message and recommend a model tier.
   *
   * 1. Run intent classification via the wrapped IntentRouter
   * 2. If the intent is in forceReasoningIntents, use the reasoning tier
   * 3. If the intent is in forceExpensiveIntents, use the codegen tier
   * 4. Otherwise, score complexity: simple → chat, moderate → codegen, complex → reasoning
   */
  async classify(
    text: string,
    context?: Record<string, unknown>,
  ): Promise<CostAwareResult> {
    const classification = await this.intentRouter.classify(text, context)

    if (this.forceReasoning.has(classification.intent)) {
      return {
        ...classification,
        modelTier: this.cfg.reasoningTier,
        routingReason: 'forced',
        complexity: 'complex',
      }
    }

    if (this.forceExpensive.has(classification.intent)) {
      return {
        ...classification,
        modelTier: this.cfg.expensiveTier,
        routingReason: 'forced',
        complexity: 'moderate',
      }
    }

    const complexity = scoreComplexity(text, this.cfg.maxSimpleChars, this.cfg.maxSimpleWords)

    const tierMap: Record<ComplexityLevel, ModelTier> = {
      simple: this.cfg.cheapTier,
      moderate: this.cfg.expensiveTier,
      complex: this.cfg.reasoningTier,
    }

    const reasonMap: Record<ComplexityLevel, CostAwareResult['routingReason']> = {
      simple: 'simple_turn',
      moderate: 'complex_turn',
      complex: 'reasoning_turn',
    }

    return {
      ...classification,
      modelTier: tierMap[complexity],
      routingReason: reasonMap[complexity],
      complexity,
    }
  }
}
