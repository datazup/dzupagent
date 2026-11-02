import type { AgentEvent, TokenUsage } from '../types.js'
import type { OpenCodeMessage, OpenCodePart, OpenCodePromptResult } from './opencode-sdk-types.js'

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function usage(message: OpenCodeMessage): TokenUsage | undefined {
  const tokens = message.tokens
  const valid = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
  if (!tokens || !valid(tokens.input) || !valid(tokens.output)) return undefined
  return {
    inputTokens: tokens.input, outputTokens: tokens.output,
    ...(valid(tokens.cache?.read) ? { cachedInputTokens: tokens.cache!.read } : {}),
    ...(valid(tokens.cache?.write) ? { cacheWriteTokens: tokens.cache!.write } : {}),
    // SDK cost is an estimate, not proof of a billed amount.
  }
}

export class OpenCodeEvents {
  private bytes = 0
  private count = 0
  private readonly calls = new Set<string>()
  private readonly results = new Set<string>()
  readonly messages = new Set<string>()
  constructor(
    readonly sessionID: string,
    readonly parentID: string,
    readonly startedAt: number,
    private readonly maxBytes: number,
    private readonly allowedTools: ReadonlySet<string>,
    private readonly correlationId?: string,
  ) {}

  base() { return { providerId: 'opencode' as const, timestamp: Date.now(), correlationId: this.correlationId } }

  acceptMessage(info: OpenCodeMessage): boolean {
    if (info.sessionID !== this.sessionID || info.role !== 'assistant' || info.parentID !== this.parentID ||
        typeof info.id !== 'string' || !info.id || !Number.isFinite(info.time?.created) || info.time.created < this.startedAt) return false
    if (!this.messages.has(info.id)) this.bound(info.id)
    this.messages.add(info.id)
    return true
  }

  bound(value: unknown): void {
    this.bytes += Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value) ?? '')
    if (++this.count > 10000 || this.bytes > this.maxBytes) throw new Error('OpenCode output limit exceeded')
  }

  tool(part: OpenCodePart): AgentEvent[] {
    if (part.sessionID !== this.sessionID || !this.messages.has(part.messageID) || part.type !== 'tool') return []
    if (typeof part.callID !== 'string' || !part.callID || typeof part.tool !== 'string' || !this.allowedTools.has(part.tool) || !record(part.state) || !record(part.state.input)) throw new Error('OpenCode returned an unadmitted tool')
    const key = `${part.messageID}:${part.callID}`
    const events: AgentEvent[] = []
    if (!this.calls.has(key)) {
      this.bound(key); this.bound(part.state.input); this.calls.add(key)
      events.push({ ...this.base(), type: 'adapter:tool_call', toolName: part.tool, toolCallId: part.callID, input: part.state.input })
    }
    if (['completed', 'error'].includes(part.state.status) && !this.results.has(key)) {
      const output = part.state.status === 'error' ? part.state.error : part.state.output
      if (typeof output !== 'string') throw new Error('Invalid OpenCode tool result')
      this.bound(output); this.results.add(key)
      const time = part.state.time
      events.push({ ...this.base(), type: 'adapter:tool_result', toolName: part.tool, toolCallId: part.callID, output,
        durationMs: time && Number.isFinite(time.end) && Number.isFinite(time.start) ? Math.max(0, time.end! - time.start) : 0,
        isError: part.state.status === 'error' })
    }
    return events
  }

  complete(result: OpenCodePromptResult): { text: string; events: AgentEvent[]; usage?: TokenUsage } {
    if (!record(result) || !record(result.info) || !this.acceptMessage(result.info) || !Array.isArray(result.parts)) throw new Error('OpenCode response does not match the active turn')
    if (result.info.error !== undefined) throw new Error('OpenCode assistant failed')
    const seen = new Set<string>()
    const events: AgentEvent[] = []
    let text = ''
    for (const part of result.parts) {
      if (!record(part) || typeof part.id !== 'string' || !part.id || part.sessionID !== this.sessionID || part.messageID !== result.info.id) throw new Error('OpenCode response part does not match the active turn')
      if (seen.has(part.id)) continue
      this.bound(part.id); seen.add(part.id)
      if (part.type === 'text' && typeof part.text === 'string') { this.bound(part.text); text += part.text }
      else events.push(...this.tool(part))
    }
    return { text, events, usage: usage(result.info) }
  }
}
