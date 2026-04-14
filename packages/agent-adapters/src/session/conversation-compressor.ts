/**
 * ConversationCompressor — accumulates `AgentEvent[]` from a multi-turn
 * session and produces a trimmed conversation history string that fits within
 * a token budget, ready to inject as context into a follow-up request.
 *
 * Design notes:
 * - No hard dependency on `@dzupagent/context` or LangChain — works with a
 *   simple character-budget approximation (4 chars ≈ 1 token).
 * - Trims from the oldest turns first, always keeping the most recent context.
 * - Callers can swap the default trimmer for a LangChain-backed compressor by
 *   passing a custom `compress` option.
 * - Thread-safe for sequential use (generator-based sessions).
 *
 * Usage:
 *   const compressor = new ConversationCompressor({ tokenBudget: 4000 })
 *
 *   // First turn
 *   for await (const evt of adapter.execute({ prompt: 'Write a test.' })) {
 *     compressor.recordEvent(evt)
 *   }
 *
 *   // Build compressed history for next turn
 *   const history = compressor.buildHistory()
 *   const nextInput: AgentInput = {
 *     prompt: 'Now add error handling.',
 *     systemPrompt: history ?? undefined,
 *   }
 *
 *   // Second turn
 *   for await (const evt of adapter.execute(nextInput)) {
 *     compressor.recordEvent(evt)
 *   }
 */

import type { AgentEvent } from '../types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single turn in the conversation (all events from one execute() call). */
export interface ConversationTurn {
  /** The user's original prompt for this turn. */
  prompt: string
  /** Assistant response text (concatenated from adapter:message events). */
  response: string
  /** Tool interactions summary for this turn. */
  toolSummary: string[]
}

export interface ConversationCompressorOptions {
  /**
   * Maximum tokens to allow in the output history string.
   * Uses a 4-chars-per-token approximation.
   * Defaults to 4000 (≈ 16 KB).
   */
  tokenBudget?: number

  /**
   * Approximate chars per token used for budget calculation.
   * Defaults to 4.
   */
  charsPerToken?: number

  /**
   * Header placed at the top of the history block.
   * Defaults to `## Conversation history\n`.
   */
  header?: string

  /**
   * Optional custom compressor function that receives the full list of turns
   * and the token budget, and returns the trimmed text.
   * Overrides the built-in character-budget trimmer.
   */
  compress?: (turns: ConversationTurn[], tokenBudget: number) => string
}

// ---------------------------------------------------------------------------
// ConversationCompressor
// ---------------------------------------------------------------------------

export class ConversationCompressor {
  private readonly turns: ConversationTurn[] = []
  private currentTurnPrompt: string | null = null
  private currentResponseParts: string[] = []
  private currentToolSummary: string[] = []

  private readonly tokenBudget: number
  private readonly charsPerToken: number
  private readonly header: string
  private readonly customCompress: ((turns: ConversationTurn[], budget: number) => string) | undefined

  constructor(opts: ConversationCompressorOptions = {}) {
    this.tokenBudget = opts.tokenBudget ?? 4000
    this.charsPerToken = opts.charsPerToken ?? 4
    this.header = opts.header ?? '## Conversation history\n'
    this.customCompress = opts.compress
  }

  // ---------------------------------------------------------------------------
  // Event recording
  // ---------------------------------------------------------------------------

  /**
   * Record a single event from the active adapter stream.
   * Detects turn boundaries automatically via `adapter:started` and
   * `adapter:completed` / `adapter:failed` events.
   */
  recordEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'adapter:started':
        // Begin a new turn
        this.flushCurrentTurn()
        this.currentTurnPrompt = event.prompt ?? null
        this.currentResponseParts = []
        this.currentToolSummary = []
        break

      case 'adapter:message':
        if (event.content.trim()) {
          this.currentResponseParts.push(event.content)
        }
        break

      case 'adapter:tool_call':
        this.currentToolSummary.push(`call:${event.toolName}`)
        break

      case 'adapter:tool_result':
        this.currentToolSummary.push(`result:${event.toolName}`)
        break

      case 'adapter:completed':
      case 'adapter:failed':
        // End of turn — commit to history
        this.flushCurrentTurn()
        break

      default:
        // adapter:stream_delta — skip, content arrives via adapter:message
        break
    }
  }

  /** Record multiple events at once (e.g. replaying a captured stream). */
  recordEvents(events: AgentEvent[]): void {
    for (const evt of events) this.recordEvent(evt)
  }

  // ---------------------------------------------------------------------------
  // History output
  // ---------------------------------------------------------------------------

  /** Returns true if at least one complete turn has been captured. */
  get hasTurns(): boolean {
    return this.turns.length > 0
  }

  /**
   * Build a compressed conversation history string that fits within the token
   * budget.  Returns `null` if no turns have been captured yet.
   */
  buildHistory(): string | null {
    if (this.turns.length === 0) return null

    const text = this.customCompress
      ? this.customCompress(this.turns, this.tokenBudget)
      : this.defaultCompress(this.turns, this.tokenBudget)

    return text || null
  }

  /**
   * Return all recorded turns (useful for external compressors or testing).
   * Returns a defensive copy.
   */
  getTurns(): ConversationTurn[] {
    return [...this.turns]
  }

  /**
   * Clear all recorded turns.
   * Useful when starting a new conversation session with the same instance.
   */
  reset(): void {
    this.turns.length = 0
    this.currentTurnPrompt = null
    this.currentResponseParts = []
    this.currentToolSummary = []
  }

  /** Estimated token count of the current history (not including header). */
  estimateTokens(): number {
    const text = this.serializeTurns(this.turns)
    return Math.ceil(text.length / this.charsPerToken)
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private flushCurrentTurn(): void {
    if (this.currentTurnPrompt === null) return
    this.turns.push({
      prompt: this.currentTurnPrompt,
      response: this.currentResponseParts.join('\n'),
      toolSummary: [...this.currentToolSummary],
    })
    this.currentTurnPrompt = null
    this.currentResponseParts = []
    this.currentToolSummary = []
  }

  private defaultCompress(turns: ConversationTurn[], tokenBudget: number): string {
    const budgetChars = tokenBudget * this.charsPerToken
    // Try progressively fewer turns from the end until we fit the budget
    for (let start = 0; start < turns.length; start++) {
      const slice = turns.slice(start)
      const serialised = this.serializeTurns(slice)
      if (this.header.length + serialised.length <= budgetChars) {
        return `${this.header}${serialised}`
      }
    }
    // Even one turn doesn't fit — take the last turn and truncate
    const lastTurn = turns[turns.length - 1]!
    const truncated = `${this.header}${formatTurn(lastTurn)}`
    return truncated.slice(0, budgetChars)
  }

  private serializeTurns(turns: ConversationTurn[]): string {
    return turns.map((t) => formatTurn(t)).join('\n')
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTurn(turn: ConversationTurn): string {
  const parts: string[] = []
  parts.push(`[user]: ${turn.prompt}`)
  if (turn.response) {
    parts.push(`[assistant]: ${turn.response}`)
  }
  if (turn.toolSummary.length > 0) {
    parts.push(`[tools]: ${turn.toolSummary.join(', ')}`)
  }
  return parts.join('\n')
}
