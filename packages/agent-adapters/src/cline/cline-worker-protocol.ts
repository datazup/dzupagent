/** Deliberately small JSON-only protocol. No credentials or arbitrary SDK config. */
export const CLINE_PROTOCOL_VERSION = 1 as const
export const CLINE_LIMITS = Object.freeze({ frameBytes: 262_144, outputBytes: 8_388_608, queue: 128, approvals: 16 })
export interface ClineBinding { version: 1; runId: string; sessionId: string }
export interface ClineStart extends ClineBinding {
  type: 'start'
  profileDir: string
  cwd: string
  provider: string
  model: string
  prompt: string
  systemPrompt: string
  enableTools: boolean
  maxIterations?: number
  approvalTimeoutMs: number
}
export type ClineParentMessage = ClineStart
  | (ClineBinding & { type: 'approval_response'; requestId: string; approved: boolean })
  | (ClineBinding & { type: 'cancel' })
export type ClineStreamEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool_call'; name: string; id: string; input: unknown }
  | { kind: 'tool_result'; name: string; id: string; output: string; durationMs: number; isError: boolean }
export interface ClineUsage { inputTokens: number; outputTokens: number; cachedInputTokens?: number; cacheWriteTokens?: number }
export type ClineChildMessage =
  | (ClineBinding & { type: 'ready' })
  | (ClineBinding & { type: 'event'; event: ClineStreamEvent })
  | (ClineBinding & { type: 'approval_request'; requestId: string; toolName: string; toolCallId: string; action: string })
  | (ClineBinding & { type: 'result'; success: boolean; text: string; reason: string; usage?: ClineUsage })
  | (ClineBinding & { type: 'fatal'; code: string })

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function keys(value: Record<string, unknown>, names: string[]): boolean {
  return Object.keys(value).every(key => names.includes(key))
}
export function finiteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function short(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 512 }
export function boundedFrame(value: unknown): boolean {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8') <= CLINE_LIMITS.frameBytes } catch { return false }
}
function binding(value: unknown): value is Record<string, unknown> & ClineBinding {
  return record(value) && value.version === 1 && short(value.runId) && short(value.sessionId) && boundedFrame(value)
}
const BASE = ['type', 'version', 'runId', 'sessionId']
export function isParentMessage(value: unknown): value is ClineParentMessage {
  if (!binding(value)) return false
  if (value.type === 'cancel') return keys(value, BASE)
  if (value.type === 'approval_response') return keys(value, [...BASE, 'requestId', 'approved']) && short(value.requestId) && typeof value.approved === 'boolean'
  return value.type === 'start' && keys(value, [...BASE, 'profileDir', 'cwd', 'provider', 'model', 'prompt', 'systemPrompt', 'enableTools', 'maxIterations', 'approvalTimeoutMs'])
    && short(value.profileDir) && short(value.cwd) && short(value.provider) && short(value.model)
    && typeof value.prompt === 'string' && typeof value.systemPrompt === 'string' && typeof value.enableTools === 'boolean'
    && (value.maxIterations === undefined || (finiteCount(value.maxIterations) && value.maxIterations > 0))
    && finiteCount(value.approvalTimeoutMs) && value.approvalTimeoutMs > 0 && value.approvalTimeoutMs <= 300_000
}
export function isChildMessage(value: unknown): value is ClineChildMessage {
  if (!binding(value)) return false
  switch (value.type) {
    case 'ready': return keys(value, BASE)
    case 'fatal': return keys(value, [...BASE, 'code']) && short(value.code)
    case 'approval_request': return keys(value, [...BASE, 'requestId', 'toolName', 'toolCallId', 'action'])
      && short(value.requestId) && short(value.toolName) && short(value.toolCallId)
      && typeof value.action === 'string' && value.action.length > 0 && value.action.length <= 8192
    case 'event': {
      if (!keys(value, [...BASE, 'event']) || !record(value.event)) return false
      const event = value.event
      if (event.kind === 'text') return keys(event, ['kind', 'text']) && typeof event.text === 'string'
      if (event.kind === 'tool_call') return keys(event, ['kind', 'name', 'id', 'input']) && short(event.name) && short(event.id)
      return event.kind === 'tool_result' && keys(event, ['kind', 'name', 'id', 'output', 'durationMs', 'isError'])
        && short(event.name) && short(event.id) && typeof event.output === 'string' && finiteCount(event.durationMs) && typeof event.isError === 'boolean'
    }
    case 'result': return keys(value, [...BASE, 'success', 'text', 'reason', 'usage']) && typeof value.success === 'boolean'
      && typeof value.text === 'string' && short(value.reason) && (!value.success || value.reason === 'completed')
      && (value.usage === undefined || validUsage(value.usage))
    default: return false
  }
}
export function validUsage(value: unknown): value is ClineUsage {
  return record(value) && keys(value, ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens'])
    && finiteCount(value.inputTokens) && finiteCount(value.outputTokens)
    && (value.cachedInputTokens === undefined || finiteCount(value.cachedInputTokens))
    && (value.cacheWriteTokens === undefined || finiteCount(value.cacheWriteTokens))
}
export function sameBinding(a: ClineBinding, b: ClineBinding): boolean {
  return a.version === b.version && a.runId === b.runId && a.sessionId === b.sessionId
}

/** One consumer; bounded producers. close wakes an already pending next(). */
export class ClineQueue<T> {
  private items: T[] = []
  private wake?: () => void
  private closed = false
  push(item: T): boolean {
    if (this.closed || this.items.length >= CLINE_LIMITS.queue) return false
    this.items.push(item)
    this.wake?.()
    this.wake = undefined
    return true
  }
  close(): void { this.closed = true; this.wake?.(); this.wake = undefined }
  async next(): Promise<T | undefined> {
    while (!this.items.length && !this.closed) await new Promise<void>(resolve => { this.wake = resolve })
    return this.items.shift()
  }
}
