/**
 * Streaming action parser — detects and executes tool calls as tokens
 * stream in from the LLM, instead of waiting for the full response.
 *
 * Accumulates partial tool_call deltas from AIMessageChunk objects
 * and fires execution as each call's JSON args become complete.
 */
import type { StructuredToolInterface } from '@langchain/core/tools'

export interface StreamedToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface StreamActionEvent {
  type: 'text' | 'tool_call_start' | 'tool_call_complete' | 'tool_result' | 'error'
  data: {
    content?: string
    toolCall?: StreamedToolCall
    result?: string
    error?: string
  }
}

export interface StreamActionParserConfig {
  /** Execute tools in parallel as they complete (default: false) */
  parallelExecution?: boolean
  /** Max concurrent tool executions when parallel (default: 3) */
  maxParallelTools?: number
}

interface ChunkInput {
  content?: string | Array<{ type: string; text?: string }>
  tool_calls?: Array<{ id?: string; name?: string; args?: string | Record<string, unknown> }>
  tool_call_chunks?: Array<{ id?: string; name?: string; args?: string; index?: number }>
}

export class StreamActionParser {
  private tools: Map<string, StructuredToolInterface>
  private pending = new Map<string, { name: string; argsJson: string }>()
  private fired = new Set<string>()
  private parallel: boolean
  private maxConcurrent: number
  private active: Set<Promise<StreamActionEvent>> = new Set()

  constructor(tools: StructuredToolInterface[], config?: StreamActionParserConfig) {
    this.tools = new Map(tools.map(t => [t.name, t]))
    this.parallel = config?.parallelExecution ?? false
    this.maxConcurrent = config?.maxParallelTools ?? 3
  }

  async processChunk(chunk: ChunkInput): Promise<StreamActionEvent[]> {
    const events: StreamActionEvent[] = []
    const text = this.extractText(chunk.content)
    if (text) events.push({ type: 'text', data: { content: text } })

    // Streaming partial deltas — accumulate args by ID
    if (chunk.tool_call_chunks) {
      for (const d of chunk.tool_call_chunks) {
        const id = d.id ?? d.index?.toString() ?? ''
        if (!id) continue
        const p = this.pending.get(id)
        if (p) {
          p.argsJson += d.args ?? ''
          if (d.name) p.name = d.name
        } else {
          this.pending.set(id, { name: d.name ?? '', argsJson: d.args ?? '' })
        }
        if (!this.fired.has(id)) {
          const entry = this.pending.get(id)!
          if (entry.name) {
            const parsed = tryParseJson(entry.argsJson)
            if (parsed !== undefined) {
              this.fired.add(id)
              const tc: StreamedToolCall = { id, name: entry.name, args: parsed }
              events.push({ type: 'tool_call_start', data: { toolCall: tc } })
              events.push(...await this.exec(tc))
            }
          }
        }
      }
    }

    // Non-streaming complete tool calls
    if (chunk.tool_calls) {
      for (const c of chunk.tool_calls) {
        const id = c.id ?? `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        if (this.fired.has(id)) continue
        this.fired.add(id)
        const args = typeof c.args === 'string' ? (tryParseJson(c.args) ?? {}) : (c.args ?? {})
        const tc: StreamedToolCall = { id, name: c.name ?? '', args }
        events.push({ type: 'tool_call_start', data: { toolCall: tc } })
        events.push(...await this.exec(tc))
      }
    }
    return events
  }

  async flush(): Promise<StreamActionEvent[]> {
    const events: StreamActionEvent[] = []
    // Fire any pending calls with parseable args that were not yet executed
    for (const [id, p] of this.pending) {
      if (this.fired.has(id) || !p.name) continue
      const parsed = tryParseJson(p.argsJson)
      if (parsed !== undefined) {
        this.fired.add(id)
        const tc: StreamedToolCall = { id, name: p.name, args: parsed }
        events.push({ type: 'tool_call_start', data: { toolCall: tc } })
        events.push(...await this.exec(tc))
      }
    }
    // Drain parallel in-flight executions
    if (this.active.size > 0) {
      const settled = await Promise.allSettled([...this.active])
      for (const r of settled) {
        if (r.status === 'fulfilled') events.push(r.value)
      }
      this.active.clear()
    }
    return events
  }

  // --- private ---

  private extractText(content: ChunkInput['content']): string | undefined {
    if (!content) return undefined
    if (typeof content === 'string') return content || undefined
    const joined = content.filter(p => p.type === 'text' && p.text).map(p => p.text).join('')
    return joined || undefined
  }

  private async exec(tc: StreamedToolCall): Promise<StreamActionEvent[]> {
    const tool = this.tools.get(tc.name)
    if (!tool) return [{ type: 'error', data: { error: `Tool "${tc.name}" not found`, toolCall: tc } }]

    const run = async (): Promise<StreamActionEvent> => {
      try {
        const raw = await tool.invoke(tc.args)
        const result = typeof raw === 'string' ? raw : JSON.stringify(raw)
        return { type: 'tool_result', data: { toolCall: tc, result } }
      } catch (err: unknown) {
        return { type: 'error', data: { toolCall: tc, error: err instanceof Error ? err.message : String(err) } }
      }
    }

    if (this.parallel) {
      if (this.active.size >= this.maxConcurrent) {
        const first = await Promise.race([...this.active])
        this.active.add(this.runTracked(run))
        return [{ type: 'tool_call_complete', data: { toolCall: tc } }, first]
      }
      this.active.add(this.runTracked(run))
      return [{ type: 'tool_call_complete', data: { toolCall: tc } }]
    }
    return [{ type: 'tool_call_complete', data: { toolCall: tc } }, await run()]
  }

  private runTracked(run: () => Promise<StreamActionEvent>): Promise<StreamActionEvent> {
    const promise = run()
    promise.finally(() => {
      this.active.delete(promise)
    })
    return promise
  }
}

function tryParseJson(str: string): Record<string, unknown> | undefined {
  const t = str.trim()
  if (!t.startsWith('{') || !t.endsWith('}')) return undefined
  try { return JSON.parse(t) as Record<string, unknown> } catch { return undefined }
}
