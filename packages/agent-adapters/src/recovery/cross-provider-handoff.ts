/**
 * CrossProviderHandoff — packages partial execution context from a failed
 * provider so the fallback provider can continue the work intelligently.
 *
 * Problem: When `AdapterRecoveryCopilot` switches to a fallback provider,
 * the new provider receives only the original bare prompt with no knowledge
 * of what the failed provider already accomplished.
 *
 * Solution: This module extracts the meaningful partial output from the
 * failed provider's event stream and serialises it into a context block that
 * can be prepended to the fallback request's system prompt.
 *
 * Usage:
 *   const handoff = new CrossProviderHandoff()
 *   for await (const evt of failedAdapter.execute(input)) {
 *     handoff.recordEvent(evt)
 *   }
 *   const context = handoff.buildHandoffContext()
 *   if (context) {
 *     fallbackInput = {
 *       ...originalInput,
 *       systemPrompt: context + (originalInput.systemPrompt ?? ''),
 *     }
 *   }
 *
 * Or use the helper directly:
 *   const fallbackInput = CrossProviderHandoff.enrichInput(originalInput, partialEvents)
 */

import type { AgentEvent, AgentInput } from '../types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single captured item extracted from a partial event sequence. */
export interface HandoffItem {
  kind: 'message' | 'tool_call' | 'tool_result'
  content: string
  /** Tool name, present for tool_call and tool_result items. */
  toolName?: string
}

export interface CrossProviderHandoffOptions {
  /**
   * Header placed at the top of the handoff context block.
   * Defaults to `## Partial progress from previous provider\n`.
   */
  header?: string

  /**
   * Footer / instruction appended after the captured items.
   * Defaults to a one-liner asking the model to continue.
   */
  footer?: string

  /**
   * Maximum number of items to include (newest last, oldest truncated).
   * Defaults to 20.
   */
  maxItems?: number
}

// ---------------------------------------------------------------------------
// CrossProviderHandoff
// ---------------------------------------------------------------------------

export class CrossProviderHandoff {
  private readonly items: HandoffItem[] = []
  private readonly opts: Required<CrossProviderHandoffOptions>

  constructor(opts: CrossProviderHandoffOptions = {}) {
    this.opts = {
      header: opts.header ?? '## Partial progress from previous provider\n',
      footer: opts.footer ?? '\nContinue the task from where the previous provider left off.\n',
      maxItems: opts.maxItems ?? 20,
    }
  }

  /**
   * Record a single event from the failing provider's stream.
   * Call this for every event yielded before the failure.
   */
  recordEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'adapter:message': {
        const content = String(event.content ?? '')
        if (content.trim()) {
          this.items.push({ kind: 'message', content })
        }
        break
      }
      case 'adapter:tool_call': {
        const inputStr = event.input ? safeJson(event.input) : ''
        const content = inputStr ? `${event.toolName}(${inputStr})` : event.toolName
        this.items.push({ kind: 'tool_call', content, toolName: event.toolName })
        break
      }
      case 'adapter:tool_result': {
        const outputStr = String(event.output ?? '')
        const label = event.toolName ?? 'tool'
        if (outputStr.trim()) {
          this.items.push({
            kind: 'tool_result',
            content: outputStr,
            toolName: event.toolName ?? label,
          })
        }
        break
      }
      default:
        // adapter:started, adapter:stream_delta, adapter:completed, adapter:failed — skip
        break
    }
  }

  /** Record multiple events at once (convenience for batch processing). */
  recordEvents(events: AgentEvent[]): void {
    for (const event of events) this.recordEvent(event)
  }

  /** Returns true if any meaningful partial content was captured. */
  get hasContent(): boolean {
    return this.items.length > 0
  }

  /**
   * Build the handoff context string to inject into the fallback provider's
   * system prompt.  Returns `null` if nothing was captured.
   */
  buildHandoffContext(): string | null {
    if (this.items.length === 0) return null

    const visible = this.items.slice(-this.opts.maxItems)
    const lines = visible.map((item) => formatItem(item))
    return `${this.opts.header}${lines.join('\n')}\n${this.opts.footer}`
  }

  /** Reset all captured items (useful when reusing the instance). */
  reset(): void {
    this.items.length = 0
  }

  // ---------------------------------------------------------------------------
  // Static helpers
  // ---------------------------------------------------------------------------

  /**
   * Build a new `AgentInput` with the handoff context injected into the
   * system prompt.  Returns the original input unchanged if there were no
   * events to carry over.
   */
  static enrichInput(
    originalInput: AgentInput,
    events: AgentEvent[],
    opts?: CrossProviderHandoffOptions,
  ): AgentInput {
    const handoff = new CrossProviderHandoff(opts)
    handoff.recordEvents(events)
    const context = handoff.buildHandoffContext()
    if (!context) return originalInput

    const existingSystemPrompt = originalInput.systemPrompt ?? ''
    const combinedSystemPrompt = existingSystemPrompt
      ? `${context}\n${existingSystemPrompt}`
      : context

    return { ...originalInput, systemPrompt: combinedSystemPrompt }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatItem(item: HandoffItem): string {
  switch (item.kind) {
    case 'message':
      return `[assistant]: ${item.content}`
    case 'tool_call':
      return `[tool_call]: ${item.content}`
    case 'tool_result':
      return `[tool_result:${item.toolName ?? 'tool'}]: ${item.content}`
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
