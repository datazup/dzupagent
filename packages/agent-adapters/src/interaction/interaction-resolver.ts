/**
 * InteractionResolver — applies the configured InteractionPolicy to resolve
 * mid-execution questions, permission prompts, and clarification requests.
 *
 * All resolution modes return a uniform { answer, resolvedBy } result that
 * adapters use to feed an answer back to the sub-agent and emit audit events.
 */

import type {
  AgentInteractionResolvedEvent,
  InteractionPolicy,
} from '../types.js'
import type { InteractionKind } from './interaction-detector.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface InteractionRequest {
  interactionId: string
  question: string
  kind: InteractionKind
  /** Optional context for AI-autonomous mode */
  context?: string | undefined
}

export interface InteractionResult {
  answer: string
  resolvedBy: AgentInteractionResolvedEvent['resolvedBy']
}

interface DeferredInteraction {
  resolve: (result: InteractionResult) => void
  timer: ReturnType<typeof setTimeout>
}

// ---------------------------------------------------------------------------
// InteractionResolver
// ---------------------------------------------------------------------------

export class InteractionResolver {
  private readonly policy: InteractionPolicy
  private readonly pending = new Map<string, DeferredInteraction>()

  constructor(policy: InteractionPolicy = { mode: 'auto-approve' }) {
    this.policy = policy
  }

  /**
   * Resolve a detected interaction according to the configured policy.
   *
   * For synchronous modes (auto-approve, auto-deny, default-answers) this
   * returns immediately. For 'ask-caller' it suspends until respond() is
   * called or the timeout fires. For 'ai-autonomous' it performs a lightweight
   * LLM call (with a deny fallback on error).
   */
  async resolve(req: InteractionRequest): Promise<InteractionResult> {
    switch (this.policy.mode) {
      case 'auto-approve':
        return { answer: 'yes', resolvedBy: 'auto-approve' }

      case 'auto-deny':
        return { answer: 'no', resolvedBy: 'auto-deny' }

      case 'default-answers':
        return this.resolveDefaultAnswers(req.question)

      case 'ai-autonomous':
        return this.resolveAiAutonomous(req)

      case 'ask-caller':
        return this.resolveAskCaller(req)

      default:
        // Exhaustive fallback — treat unknown modes as auto-approve
        return { answer: 'yes', resolvedBy: 'auto-approve' }
    }
  }

  /**
   * Called by the UI/orchestrator to answer a pending 'ask-caller' interaction.
   * Returns true if the interaction was found and resolved, false otherwise.
   */
  respond(interactionId: string, answer: string): boolean {
    const deferred = this.pending.get(interactionId)
    if (!deferred) return false

    clearTimeout(deferred.timer)
    this.pending.delete(interactionId)
    deferred.resolve({ answer, resolvedBy: 'caller' })
    return true
  }

  /**
   * Cancel all pending interactions with the configured timeout-fallback answer.
   * Call this on adapter teardown to avoid leaked Promises.
   */
  dispose(): void {
    for (const [id, deferred] of this.pending) {
      clearTimeout(deferred.timer)
      this.pending.delete(id)
      const fallback = this.policy.askCaller?.timeoutFallback ?? 'auto-deny'
      deferred.resolve({
        answer: fallback === 'auto-approve' ? 'yes' : 'no',
        resolvedBy: 'timeout-fallback',
      })
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private resolveDefaultAnswers(question: string): InteractionResult {
    const patterns = this.policy.defaultAnswers?.patterns ?? []
    for (const { pattern, answer } of patterns) {
      try {
        if (new RegExp(pattern, 'i').test(question)) {
          return { answer, resolvedBy: 'default-answers' }
        }
      } catch {
        // Malformed regex — skip silently, try next
      }
    }
    // No pattern matched → fail safe
    return { answer: 'no', resolvedBy: 'auto-deny' }
  }

  private async resolveAiAutonomous(req: InteractionRequest): Promise<InteractionResult> {
    try {
      const answer = await this.callLlmForDecision(req)
      return { answer, resolvedBy: 'ai-autonomous' }
    } catch {
      // Any error → fail safe
      return { answer: 'no', resolvedBy: 'auto-deny' }
    }
  }

  private resolveAskCaller(req: InteractionRequest): Promise<InteractionResult> {
    const timeoutMs = this.policy.askCaller?.timeoutMs ?? 60_000
    const fallback = this.policy.askCaller?.timeoutFallback ?? 'auto-deny'

    return new Promise<InteractionResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(req.interactionId)
        resolve({
          answer: fallback === 'auto-approve' ? 'yes' : 'no',
          resolvedBy: 'timeout-fallback',
        })
      }, timeoutMs)

      this.pending.set(req.interactionId, { resolve, timer })
    })
  }

  /**
   * Minimal LLM call for ai-autonomous mode.
   *
   * Uses the Anthropic Messages API directly (via fetch) with the smallest
   * available model so the decision is fast and cheap. The response is
   * normalized to a single word: 'yes' or 'no'.
   *
   * Callers catch all errors — a throw triggers the auto-deny fallback.
   */
  private async callLlmForDecision(req: InteractionRequest): Promise<string> {
    const apiKey = this.resolveApiKey()
    if (!apiKey) throw new Error('No API key available for ai-autonomous mode')

    const contextLine = req.context
      ? `\nContext about this agent run: ${req.context}`
      : ''

    const body = JSON.stringify({
      model: this.policy.aiAutonomous?.model ?? 'claude-haiku-4-5-20251001',
      max_tokens: 16,
      system: `You are an autonomous agent assistant deciding how to answer a permission or clarification question on behalf of the user.${contextLine}
Respond with ONLY "yes" or "no" (lowercase, no punctuation). Use the question context and kind to decide.
- For permission prompts (file writes, network access, tool execution): consider the stated context.
- For clarifications: "yes" means proceed with the most reasonable default; "no" means stop and wait.
- Default to "yes" only when the action is clearly safe and reversible.`,
      messages: [
        {
          role: 'user',
          content: `Question kind: ${req.kind}\nQuestion: ${req.question}`,
        },
      ],
    })

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body,
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      throw new Error(`LLM call failed: ${res.status} ${res.statusText}`)
    }

    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> }
    const text = data.content?.find((b) => b.type === 'text')?.text?.trim().toLowerCase() ?? ''

    // Normalize — treat anything starting with 'y' as yes
    return text.startsWith('y') ? 'yes' : 'no'
  }

  private resolveApiKey(): string | undefined {
    // Prefer explicit env var, fall back to common Anthropic key
    return (
      process.env['DZUPAGENT_LLM_API_KEY'] ??
      process.env['ANTHROPIC_API_KEY'] ??
      undefined
    )
  }
}
