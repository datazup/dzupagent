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

export interface CostAwareResult extends ClassificationResult {
  /** Recommended model tier for this turn */
  modelTier: ModelTier
  /** Why this tier was chosen */
  routingReason: 'simple_turn' | 'complex_turn' | 'forced'
}

export interface CostAwareRouterConfig {
  intentRouter: IntentRouter
  /** Max character length for a "simple" message (default 200) */
  maxSimpleChars?: number
  /** Max word count for a "simple" message (default 30) */
  maxSimpleWords?: number
  /** Intents that always require the expensive tier regardless of message length */
  forceExpensiveIntents?: string[]
  /** Model tier for simple turns (default "chat") */
  cheapTier?: ModelTier
  /** Model tier for complex turns (default "codegen") */
  expensiveTier?: ModelTier
}

/** Keywords that signal code/debugging complexity — never route to cheap model */
const COMPLEXITY_KEYWORDS = [
  'debug', 'implement', 'refactor', 'migrate', 'architect',
  'schema', 'migration', 'deploy', 'pipeline', 'generate',
  'create feature', 'build', 'fix bug', 'optimize', 'test',
  'security', 'authentication', 'database', 'api endpoint',
  'component', 'integration', 'dockerfile', 'ci/cd', 'prisma',
  'graphql', 'websocket', 'middleware', 'typescript', 'eslint',
]

const DEFAULTS = {
  maxSimpleChars: 200,
  maxSimpleWords: 30,
  cheapTier: 'chat' as ModelTier,
  expensiveTier: 'codegen' as ModelTier,
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

export class CostAwareRouter {
  private readonly cfg: Required<Omit<CostAwareRouterConfig, 'intentRouter' | 'forceExpensiveIntents'>>
  private readonly intentRouter: IntentRouter
  private readonly forceExpensive: Set<string>

  constructor(config: CostAwareRouterConfig) {
    this.intentRouter = config.intentRouter
    this.forceExpensive = new Set(config.forceExpensiveIntents ?? [])
    this.cfg = {
      maxSimpleChars: config.maxSimpleChars ?? DEFAULTS.maxSimpleChars,
      maxSimpleWords: config.maxSimpleWords ?? DEFAULTS.maxSimpleWords,
      cheapTier: config.cheapTier ?? DEFAULTS.cheapTier,
      expensiveTier: config.expensiveTier ?? DEFAULTS.expensiveTier,
    }
  }

  /**
   * Classify the message and recommend a model tier.
   *
   * 1. Run intent classification via the wrapped IntentRouter
   * 2. If the intent is in forceExpensiveIntents, use the expensive tier
   * 3. Otherwise, check if the message is "simple" enough for the cheap tier
   */
  async classify(
    text: string,
    context?: Record<string, unknown>,
  ): Promise<CostAwareResult> {
    const classification = await this.intentRouter.classify(text, context)

    if (this.forceExpensive.has(classification.intent)) {
      return {
        ...classification,
        modelTier: this.cfg.expensiveTier,
        routingReason: 'forced',
      }
    }

    const simple = isSimpleTurn(text, this.cfg.maxSimpleChars, this.cfg.maxSimpleWords)

    return {
      ...classification,
      modelTier: simple ? this.cfg.cheapTier : this.cfg.expensiveTier,
      routingReason: simple ? 'simple_turn' : 'complex_turn',
    }
  }
}
