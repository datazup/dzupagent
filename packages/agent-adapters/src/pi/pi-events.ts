import type { AgentEvent, TokenUsage } from '../types.js'
import type { PiEvent, PiMessage, PiUsage } from './pi-sdk-types.js'

export function piText(content: PiMessage['content']): string {
  return typeof content === 'string' ? content : content
    .filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

/** Count finalized records, never lifetime session totals or partial stream usage. */
export class PiRunUsage {
  private records: Array<PiUsage | undefined> = []

  add(usage: PiUsage | undefined): void {
    this.records.push(usage ? structuredClone(usage) : undefined)
  }

  snapshot(): TokenUsage | undefined {
    if (this.records.length === 0) return undefined
    const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
    const tokenKeys = ['input', 'output', 'cacheRead', 'cacheWrite'] as const
    if (this.records.some(record => !record || tokenKeys.some(key =>
      !Number.isSafeInteger(record[key]) || record[key] < 0))) return undefined
    const records = this.records as PiUsage[]
    const sum = (key: typeof tokenKeys[number]) => records.reduce((total, record) => total + record[key], 0)
    const totals = tokenKeys.map(sum)
    if (totals.some(total => !Number.isSafeInteger(total))) return undefined
    const usage: TokenUsage = {
      inputTokens: totals[0]!, outputTokens: totals[1]!,
      cachedInputTokens: totals[2]!, cacheWriteTokens: totals[3]!,
    }
    // Reasoning is a subset of output; cacheWrite1h is a subset of cacheWrite.
    if (records.every(record => record.cost?.totalFromProvider === true && valid(record.cost.total))) {
      const costCents = records.reduce((total, record) => total + record.cost.total, 0) * 100
      if (valid(costCents)) usage.costCents = costCents
    }
    return usage
  }
}

export class PiEventMapper {
  readonly usage = new PiRunUsage()
  latest: PiMessage | undefined
  aborted = false
  readonly pendingTools = new Set<string>()
  private readonly finalized = new Set<PiMessage>()
  private readonly finishedTools = new Set<string>()
  private readonly oldMessages: Set<PiMessage>

  constructor(oldMessages: readonly PiMessage[], private readonly correlationId?: string) {
    this.oldMessages = new Set(oldMessages)
  }

  map(event: PiEvent): AgentEvent | undefined {
    const common = { providerId: 'pi' as const, timestamp: Date.now(), correlationId: this.correlationId }
    switch (event.type) {
      case 'message_update':
        if (event.assistantMessageEvent.type === 'text_delta' && typeof event.assistantMessageEvent.delta === 'string') {
          return { ...common, type: 'adapter:stream_delta', content: event.assistantMessageEvent.delta }
        }
        return undefined
      case 'message_end': {
        const message = event.message
        if (message.role !== 'assistant' || this.oldMessages.has(message) || this.finalized.has(message)) return undefined
        this.finalized.add(message)
        this.latest = structuredClone(message)
        this.usage.add(message.usage)
        const content = piText(message.content)
        return content ? { ...common, type: 'adapter:message', role: 'assistant', content } : undefined
      }
      case 'tool_execution_start':
        this.pendingTools.add(event.toolCallId)
        return { ...common, type: 'adapter:tool_call', toolName: event.toolName, toolCallId: event.toolCallId, input: event.args }
      case 'tool_execution_end':
        if (this.finishedTools.has(event.toolCallId)) return undefined
        this.finishedTools.add(event.toolCallId)
        this.pendingTools.delete(event.toolCallId)
        return { ...common, type: 'adapter:tool_result', toolName: event.toolName, toolCallId: event.toolCallId,
          output: piText(event.result.content), durationMs: event.durationMs ?? 0, isError: event.isError }
      case 'agent_settled':
        this.aborted ||= event.aborted
        return undefined
      default:
        // agent_end may precede retry, compaction or queued continuation.
        return undefined
    }
  }
}

/** Bounded event queue with a reserved terminal slot and drain-before-close. */
export class PiEventQueue {
  private readonly values: AgentEvent[] = []
  private readonly waiters: Array<(value: IteratorResult<AgentEvent, void>) => void> = []
  private terminal: AgentEvent | undefined
  private ended = false

  constructor(private readonly capacity: number) {}

  push(event: AgentEvent): boolean {
    if (this.ended || this.terminal) return false
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value: event, done: false })
    else if (this.values.length < this.capacity) this.values.push(event)
    else return false
    return true
  }

  finish(event: AgentEvent): void {
    if (this.ended || this.terminal) return
    this.terminal = event
    this.flush()
  }

  close(): void {
    this.values.length = 0
    this.terminal = undefined
    this.ended = true
    this.flush()
  }

  next(): Promise<IteratorResult<AgentEvent, void>> {
    const value = this.values.shift()
    if (value) return Promise.resolve({ value, done: false })
    if (this.terminal) {
      const terminal = this.terminal
      this.terminal = undefined
      this.ended = true
      this.flush()
      return Promise.resolve({ value: terminal, done: false })
    }
    if (this.ended) return Promise.resolve({ value: undefined, done: true })
    return new Promise(resolve => this.waiters.push(resolve))
  }

  private flush(): void {
    while (this.waiters.length && (this.values.length || this.terminal || this.ended)) {
      const waiter = this.waiters.shift()!
      const value = this.values.shift() ?? this.terminal
      if (value === this.terminal && this.terminal) { this.terminal = undefined; this.ended = true }
      waiter(value ? { value, done: false } : { value: undefined, done: true })
    }
  }
}
