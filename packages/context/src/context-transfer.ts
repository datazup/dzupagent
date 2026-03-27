/**
 * Cross-intent context transfer for LLM conversations.
 *
 * When a user switches tasks mid-conversation (e.g., from "generate feature"
 * to "edit feature"), relevant context from the previous intent is packaged
 * and injected into the new intent's message stream. This preserves decisions,
 * file references, and working state across intent boundaries.
 */
import { SystemMessage, type BaseMessage } from '@langchain/core/messages'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Recognized intent types (extensible — any string works) */
export type IntentType = string

/** Packaged context from a completed or paused intent */
export interface IntentContext {
  /** The intent type this context came from */
  fromIntent: IntentType
  /** The intent type this context is being transferred to */
  toIntent: IntentType
  /** Summary of what was accomplished in the source intent */
  summary: string
  /** Key decisions made during the source intent */
  decisions: string[]
  /** Files that were created, modified, or referenced */
  relevantFiles: string[]
  /** Current working state (key-value pairs) */
  workingState: Record<string, unknown>
  /** When the transfer was created (epoch ms) */
  transferredAt: number
  /** Estimated token cost of this context */
  tokenEstimate: number
}

/** Configuration for context transfer */
export interface ContextTransferConfig {
  /** Max tokens for transferred context (default: 2000) */
  maxTransferTokens?: number
  /** Chars per token for estimation (default: 4) */
  charsPerToken?: number
  /** Intent relevance rules: which source intents are relevant to which targets */
  relevanceRules?: IntentRelevanceRule[]
}

/** Rule defining which intents should transfer context to which */
export interface IntentRelevanceRule {
  /** Source intent pattern (string match or regex) */
  from: string | RegExp
  /** Target intent pattern */
  to: string | RegExp
  /** What to transfer */
  transferScope: TransferScope
  /** Priority (higher = more important, used for token budget allocation) */
  priority: number
}

export type TransferScope = 'all' | 'decisions-only' | 'files-only' | 'summary-only'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TRANSFER_TOKENS = 2000
const DEFAULT_CHARS_PER_TOKEN = 4
const MAX_DECISIONS = 10
const MAX_FILES = 20
const RECENT_MESSAGE_PAIRS = 6 // last 6 human/ai messages (~3 pairs)
const CONTENT_PREVIEW_LENGTH = 200
const MIN_DECISION_LENGTH = 10

const DECISION_PATTERNS: RegExp[] = [
  /\b(?:decided|decision|chose|chosen|going with|settled on|will use)\b/i,
  /\b(?:architecture|design choice|approach|strategy)\b.*:/i,
]

const FILE_PATH_PATTERN = /(?:^|\s)((?:[\w.-]+\/)+[\w.-]+\.\w+)/gm

const DEFAULT_RULES: IntentRelevanceRule[] = [
  { from: /generate/, to: /edit/, transferScope: 'all', priority: 10 },
  { from: /edit/, to: /generate/, transferScope: 'decisions-only', priority: 5 },
  { from: /implement/, to: /debug/, transferScope: 'all', priority: 10 },
  { from: /debug/, to: /implement/, transferScope: 'all', priority: 8 },
  { from: /plan/, to: /implement/, transferScope: 'all', priority: 10 },
  { from: /implement/, to: /review/, transferScope: 'files-only', priority: 7 },
  // Catch-all: cross-domain transfers get summary only
  { from: /.*/, to: /.*/, transferScope: 'summary-only', priority: 1 },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Safely extract string content from a BaseMessage */
function getContent(message: BaseMessage): string {
  const raw = message.content
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) {
    return raw
      .map((part) => {
        if (typeof part === 'string') return part
        if (typeof part === 'object' && part !== null && 'text' in part) {
          return String((part as { text: unknown }).text)
        }
        return ''
      })
      .join(' ')
  }
  return String(raw)
}

/** Test whether an intent string matches a pattern (string or RegExp) */
function matchesPattern(intent: string, pattern: string | RegExp): boolean {
  if (typeof pattern === 'string') return intent === pattern
  return pattern.test(intent)
}

/** Estimate token count from character length */
function estimateTokens(text: string, charsPerToken: number): number {
  return Math.ceil(text.length / charsPerToken)
}

/** Extract sentences that match any of the decision patterns */
function extractDecisionSentences(content: string): string[] {
  const results: string[] = []
  const sentences = content.split(/[.!?\n]/)
  for (const sentence of sentences) {
    const trimmed = sentence.trim()
    if (trimmed.length <= MIN_DECISION_LENGTH) continue
    for (const pattern of DECISION_PATTERNS) {
      if (pattern.test(trimmed)) {
        results.push(trimmed)
        break // one match per sentence is enough
      }
    }
  }
  return results
}

/** Extract file paths from text content */
function extractFilePaths(content: string): string[] {
  const paths: string[] = []
  for (const match of content.matchAll(FILE_PATH_PATTERN)) {
    if (match[1]) paths.push(match[1])
  }
  return paths
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ContextTransferService {
  private readonly maxTransferTokens: number
  private readonly charsPerToken: number
  private readonly rules: IntentRelevanceRule[]

  constructor(config?: ContextTransferConfig) {
    this.maxTransferTokens = config?.maxTransferTokens ?? DEFAULT_MAX_TRANSFER_TOKENS
    this.charsPerToken = config?.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN
    this.rules = config?.relevanceRules ?? DEFAULT_RULES
  }

  /**
   * Extract context from a set of messages belonging to a completed intent.
   * Scans messages for decisions, file paths, and working state.
   */
  extractContext(
    messages: readonly BaseMessage[],
    intentType: IntentType,
    workingState?: Record<string, unknown>,
  ): IntentContext {
    // 1. Build summary from recent human + ai messages
    const conversational = messages.filter((m) => {
      const t = m._getType()
      return t === 'human' || t === 'ai'
    })
    const recentMessages = conversational.slice(-RECENT_MESSAGE_PAIRS)
    const summary = recentMessages
      .map((m) => {
        const role = m._getType()
        const content = getContent(m).slice(0, CONTENT_PREVIEW_LENGTH)
        return `[${role}]: ${content}`
      })
      .join('\n')

    // 2. Extract decisions
    const allDecisions: string[] = []
    for (const m of messages) {
      const content = getContent(m)
      allDecisions.push(...extractDecisionSentences(content))
    }
    const uniqueDecisions = [...new Set(allDecisions)].slice(0, MAX_DECISIONS)

    // 3. Extract file paths
    const allPaths = new Set<string>()
    for (const m of messages) {
      const content = getContent(m)
      for (const p of extractFilePaths(content)) {
        allPaths.add(p)
      }
    }

    // 4. Assemble context
    const ctx: IntentContext = {
      fromIntent: intentType,
      toIntent: '', // filled in later by inject/transfer
      summary,
      decisions: uniqueDecisions,
      relevantFiles: [...allPaths].slice(0, MAX_FILES),
      workingState: workingState ?? {},
      transferredAt: Date.now(),
      tokenEstimate: 0,
    }

    // Compute token estimate from the formatted output
    const formatted = this.formatContextText(ctx, 'all')
    ctx.tokenEstimate = estimateTokens(formatted, this.charsPerToken)

    return ctx
  }

  /**
   * Check if context from sourceIntent is relevant to targetIntent.
   * Uses relevance rules, falling back to "always relevant" if no rules defined.
   */
  isRelevant(sourceIntent: IntentType, targetIntent: IntentType): boolean {
    if (this.rules.length === 0) return true
    return this.rules.some(
      (rule) => matchesPattern(sourceIntent, rule.from) && matchesPattern(targetIntent, rule.to),
    )
  }

  /**
   * Get the transfer scope for a source -> target intent pair.
   * Returns the scope of the highest-priority matching rule.
   */
  getTransferScope(sourceIntent: IntentType, targetIntent: IntentType): TransferScope {
    let bestRule: IntentRelevanceRule | undefined
    for (const rule of this.rules) {
      if (!matchesPattern(sourceIntent, rule.from)) continue
      if (!matchesPattern(targetIntent, rule.to)) continue
      if (!bestRule || rule.priority > bestRule.priority) {
        bestRule = rule
      }
    }
    return bestRule?.transferScope ?? 'summary-only'
  }

  /**
   * Format an IntentContext as a SystemMessage for injection into a new conversation.
   * Respects maxTransferTokens budget — truncates if needed.
   */
  formatAsMessage(context: IntentContext): SystemMessage {
    const scope = context.toIntent
      ? this.getTransferScope(context.fromIntent, context.toIntent)
      : 'all'

    let text = this.formatContextText(context, scope)

    // Truncate if over budget
    const maxChars = this.maxTransferTokens * this.charsPerToken
    if (text.length > maxChars) {
      text = text.slice(0, maxChars) + '\n\n[Context truncated to fit token budget]'
    }

    return new SystemMessage(text)
  }

  /**
   * Inject transferred context into a new intent's message array.
   * Inserts after the first system message, or at position 0 if none exists.
   * Returns a new array — does not mutate the input.
   */
  injectContext(context: IntentContext, messages: readonly BaseMessage[]): BaseMessage[] {
    const systemMsg = this.formatAsMessage(context)
    const result = [...messages]

    // Find the first system message and insert after it
    const firstSystemIdx = result.findIndex((m) => m._getType() === 'system')
    if (firstSystemIdx >= 0) {
      result.splice(firstSystemIdx + 1, 0, systemMsg)
    } else {
      result.unshift(systemMsg)
    }

    return result
  }

  /**
   * Full transfer pipeline: extract from source, check relevance, inject into target.
   * Returns the augmented target messages, or null if the transfer is not relevant.
   */
  transfer(
    sourceMessages: readonly BaseMessage[],
    sourceIntent: IntentType,
    targetMessages: readonly BaseMessage[],
    targetIntent: IntentType,
    workingState?: Record<string, unknown>,
  ): BaseMessage[] | null {
    if (!this.isRelevant(sourceIntent, targetIntent)) {
      return null
    }

    const context = this.extractContext(sourceMessages, sourceIntent, workingState)
    context.toIntent = targetIntent

    return this.injectContext(context, targetMessages)
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /** Build the markdown text for a context block, filtered by scope */
  private formatContextText(context: IntentContext, scope: TransferScope): string {
    let text = `## Context Transferred from "${context.fromIntent}"\n\n`

    // Summary is always included
    text += `### Summary\n${context.summary}\n\n`

    if ((scope === 'all' || scope === 'decisions-only') && context.decisions.length > 0) {
      text += `### Key Decisions\n`
      text += context.decisions.map((d) => `- ${d}`).join('\n')
      text += '\n\n'
    }

    if ((scope === 'all' || scope === 'files-only') && context.relevantFiles.length > 0) {
      text += `### Relevant Files\n`
      text += context.relevantFiles.map((f) => `- ${f}`).join('\n')
      text += '\n\n'
    }

    if (scope === 'all' && Object.keys(context.workingState).length > 0) {
      text += `### Working State\n`
      text += '```json\n' + JSON.stringify(context.workingState, null, 2) + '\n```\n'
    }

    return text
  }
}
