import { types as utilTypes } from 'node:util'

import {
  ToolMessage,
  type AIMessage,
  type BaseMessage,
} from '@langchain/core/messages'

import {
  measureTokenText,
  type TokenCounter,
  type TokenMeasurementResult,
} from '../token-lifecycle.js'

export const COMPACTED_CONTENT = '[Completed tool result compacted]'
export const MAX_TOOL_CALLS_PER_MESSAGE = 64
export const MAX_TOOL_CALL_ID_LENGTH = 256
const MAX_SERIALIZED_CONTENT_LENGTH = 4_000_000
const MAX_SAFE_CLONE_NODES = 20_000
const MAX_SAFE_CLONE_DEPTH = 64
const MAX_SAFE_CLONE_STRING_BYTES = 4_000_000

export interface CompactionOptions {
  tokenCounter?: TokenCounter
  model?: string
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  try {
    if (utilTypes.isProxy(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

export function hasOnlyDataProperties(value: object): boolean {
  try {
    if (utilTypes.isProxy(value)) return false
    return Reflect.ownKeys(value).every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return descriptor !== undefined && 'value' in descriptor
    })
  } catch {
    return false
  }
}

export function safeMessageType(message: BaseMessage): string | null {
  try {
    if (utilTypes.isProxy(message)) return null
    if (typeof message._getType !== 'function') return null
    const type = message._getType()
    return typeof type === 'string' ? type : null
  } catch {
    return null
  }
}

export function safeToolCalls(message: BaseMessage): Array<{ id?: string }> | null {
  try {
    const calls = (message as AIMessage).tool_calls
    if (calls === undefined) return []
    if (!Array.isArray(calls) || calls.length > MAX_TOOL_CALLS_PER_MESSAGE) return null
    if (!hasOnlyDataProperties(calls)) return null
    return calls as Array<{ id?: string }>
  } catch {
    return null
  }
}

function assertSafeCloneValue(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
  counter = { nodes: 0, stringBytes: 0 },
): void {
  if (typeof value === 'string') {
    counter.stringBytes += Buffer.byteLength(value, 'utf8')
    if (counter.stringBytes > MAX_SAFE_CLONE_STRING_BYTES) {
      throw new Error('clone string size exceeded')
    }
    return
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'undefined') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('unsafe number')
    return
  }
  if (typeof value === 'bigint') return
  if (typeof value !== 'object') throw new Error('unsafe clone value')
  if (utilTypes.isProxy(value)) throw new Error('proxy rejected')
  if (depth > MAX_SAFE_CLONE_DEPTH) throw new Error('clone depth exceeded')
  counter.nodes += 1
  if (counter.nodes > MAX_SAFE_CLONE_NODES) throw new Error('clone size exceeded')
  if (seen.has(value)) return
  seen.add(value)
  if (!hasOnlyDataProperties(value)) throw new Error('accessor rejected')
  const prototype = Object.getPrototypeOf(value)
  const supportedPrototype =
    prototype === Object.prototype || prototype === null || prototype === Array.prototype ||
    prototype === Date.prototype || prototype === RegExp.prototype ||
    prototype === Map.prototype || prototype === Set.prototype ||
    prototype === ArrayBuffer.prototype || ArrayBuffer.isView(value)
  if (!supportedPrototype) throw new Error('unsupported clone prototype')
  if (value instanceof Map) {
    for (const [key, entry] of value) {
      assertSafeCloneValue(key, seen, depth + 1, counter)
      assertSafeCloneValue(entry, seen, depth + 1, counter)
    }
    return
  }
  if (value instanceof Set) {
    for (const entry of value) assertSafeCloneValue(entry, seen, depth + 1, counter)
    return
  }
  if (value instanceof Date || value instanceof RegExp || value instanceof ArrayBuffer ||
      ArrayBuffer.isView(value)) return
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !('value' in descriptor)) throw new Error('accessor rejected')
    assertSafeCloneValue(descriptor.value, seen, depth + 1, counter)
  }
}

function cloneSafe<T>(value: T): T {
  assertSafeCloneValue(value)
  return structuredClone(value)
}

export function cloneCompactedToolMessage(message: ToolMessage): ToolMessage {
  let fields: ConstructorParameters<typeof ToolMessage>[0]
  try {
    fields = {
      content: COMPACTED_CONTENT,
      tool_call_id: message.tool_call_id,
      ...(message.id !== undefined ? { id: message.id } : {}),
      ...(message.name !== undefined ? { name: message.name } : {}),
      ...(message.status !== undefined ? { status: message.status } : {}),
      ...(message.artifact !== undefined ? { artifact: cloneSafe(message.artifact) } : {}),
      ...(message.metadata !== undefined ? { metadata: cloneSafe(message.metadata) } : {}),
      additional_kwargs: cloneSafe(message.additional_kwargs),
      response_metadata: cloneSafe(message.response_metadata),
    }
  } catch {
    throw new Error('clone rejected')
  }
  return new ToolMessage(fields)
}

export function contentText(message: BaseMessage): string {
  const content = message.content
  if (typeof content === 'string') {
    if (content.length > MAX_SERIALIZED_CONTENT_LENGTH) throw new Error('input too large')
    return content
  }
  assertSafeCloneValue(content)
  const serialized = JSON.stringify(content)
  if (serialized === undefined || serialized.length > MAX_SERIALIZED_CONTENT_LENGTH) {
    throw new Error('invalid content')
  }
  return serialized
}

function serializePromptMessages(messages: BaseMessage[]): string {
  const payload: Array<Record<string, unknown>> = []
  let chargedBytes = 0
  const charge = (value: string): void => {
    chargedBytes += Buffer.byteLength(value, 'utf8')
    if (chargedBytes > MAX_SERIALIZED_CONTENT_LENGTH) throw new Error('input too large')
  }
  for (const message of messages) {
    const type = safeMessageType(message)
    if (type === null) throw new Error('invalid message')
    const content = contentText(message)
    charge(content)
    const name = message.name
    if (name !== undefined) {
      if (typeof name !== 'string' || name.length > 1_024) throw new Error('invalid name')
      charge(name)
    }
    if (type === 'tool') {
      const tool = message as ToolMessage
      if (typeof tool.tool_call_id !== 'string' || tool.tool_call_id.length > MAX_TOOL_CALL_ID_LENGTH) {
        throw new Error('invalid tool call id')
      }
      charge(tool.tool_call_id)
      payload.push({ type, content, tool_call_id: tool.tool_call_id, name })
    } else if (type === 'ai') {
      const toolCalls = safeToolCalls(message)
      if (toolCalls === null) throw new Error('invalid tool calls')
      assertSafeCloneValue(toolCalls)
      const serializedToolCalls = JSON.stringify(toolCalls)
      if (serializedToolCalls === undefined) throw new Error('invalid tool calls')
      charge(serializedToolCalls)
      payload.push({ type, content, tool_calls: toolCalls, name })
    } else {
      payload.push({ type, content, name })
    }
  }
  const serialized = JSON.stringify(payload)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SERIALIZED_CONTENT_LENGTH) {
    throw new Error('input too large')
  }
  return serialized
}

export function measureMessages(
  messages: BaseMessage[],
  options: CompactionOptions,
): TokenMeasurementResult {
  return measureText(serializePromptMessages(messages), options)
}

export function measureText(
  text: string,
  options: CompactionOptions,
): TokenMeasurementResult {
  const measurement = measureTokenText(text, options.tokenCounter, options.model)
  if (
    !Number.isInteger(measurement.tokens) ||
    !Number.isFinite(measurement.tokens) ||
    measurement.tokens < 0
  ) throw new Error('invalid token measurement')
  return measurement
}

export function measurementIsProven(measurement: TokenMeasurementResult): boolean {
  return measurement.method === 'exact' || measurement.method === 'encoding-fallback'
}
