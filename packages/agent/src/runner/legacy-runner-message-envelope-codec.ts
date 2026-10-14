import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import type { AgentMessageItem } from '@dzupagent/agent-types/run'

import { digestRunnerJson } from './runner-values.js'

export type LegacyMessageRole = 'system' | 'human' | 'ai'

export type LegacyMessageContentEnvelope =
  | { readonly encoding: 'string'; readonly value: string }
  | {
      readonly encoding: 'standard-text-blocks'
      readonly value: readonly { readonly type: 'text'; readonly text: string }[]
    }

export interface LegacyMessageEnvelopeEntry {
  readonly index: number
  readonly role: LegacyMessageRole
  readonly content: LegacyMessageContentEnvelope
  readonly itemId: string
  readonly itemDigest: string
  readonly usageMetadata?: BasicUsageMetadata
}

interface BasicUsageMetadata {
  readonly input_tokens: number
  readonly output_tokens: number
  readonly total_tokens: number
}

export type LegacyMessageCaptureFailure =
  | 'message-class-unsupported'
  | 'message-content-unsupported'
  | 'message-metadata-unsupported'
  | 'message-item-mismatch'

function object(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function emptyObject(value: unknown): boolean {
  return object(value) && Object.keys(value).length === 0
}

function role(message: BaseMessage): LegacyMessageRole | undefined {
  if (SystemMessage.isInstance(message)) return 'system'
  if (HumanMessage.isInstance(message)) return 'human'
  if (AIMessage.isInstance(message)) return 'ai'
  return undefined
}

function content(value: BaseMessage['content']): LegacyMessageContentEnvelope | undefined {
  if (typeof value === 'string') return { encoding: 'string', value }
  if (!Array.isArray(value)) return undefined
  const blocks: Array<{ readonly type: 'text'; readonly text: string }> = []
  for (const block of value) {
    if (!object(block)
        || Object.keys(block).sort().join('|') !== 'text|type'
        || block.type !== 'text'
        || typeof block.text !== 'string') return undefined
    blocks.push({ type: 'text', text: block.text })
  }
  return { encoding: 'standard-text-blocks', value: blocks }
}

function usage(message: BaseMessage): BasicUsageMetadata | undefined | false {
  if (!AIMessage.isInstance(message)) return undefined
  const value = (message as unknown as { readonly usage_metadata?: unknown }).usage_metadata
  if (value === undefined) return undefined
  if (!object(value)
      || Object.keys(value).sort().join('|') !== 'input_tokens|output_tokens|total_tokens'
      || !Number.isSafeInteger(value.input_tokens)
      || !Number.isSafeInteger(value.output_tokens)
      || value.total_tokens !== Number(value.input_tokens) + Number(value.output_tokens)) return false
  return {
    input_tokens: Number(value.input_tokens),
    output_tokens: Number(value.output_tokens),
    total_tokens: Number(value.total_tokens),
  }
}

function cleanMetadata(message: BaseMessage, allowUsage: boolean): boolean {
  if (message.id !== undefined || message.name !== undefined
      || !emptyObject(message.additional_kwargs)
      || !emptyObject(message.response_metadata)) return false
  if (!AIMessage.isInstance(message)) return true
  if ((message.tool_calls?.length ?? 0) !== 0
      || (message.invalid_tool_calls?.length ?? 0) !== 0) return false
  const retainedUsage = usage(message)
  return retainedUsage !== false && (retainedUsage === undefined || allowUsage)
}

function runnerRole(value: LegacyMessageRole): AgentMessageItem['role'] {
  return value === 'human' ? 'user' : value === 'ai' ? 'assistant' : 'system'
}

function runnerContent(value: LegacyMessageContentEnvelope) {
  return value.encoding === 'string'
    ? [{ type: 'text' as const, text: value.value }]
    : value.value
}

/** @internal Build the canonical runner item before dispatch-time envelope capture. */
export function createLegacyRunnerMessageItem(
  message: BaseMessage,
  itemId: string,
): AgentMessageItem | LegacyMessageCaptureFailure {
  const messageRole = role(message)
  if (messageRole === undefined) return 'message-class-unsupported'
  if (!cleanMetadata(message, false)) return 'message-metadata-unsupported'
  const messageContent = content(message.content)
  if (messageContent === undefined) return 'message-content-unsupported'
  return {
    type: 'message',
    itemId,
    role: runnerRole(messageRole),
    content: runnerContent(messageContent),
  }
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function captureMessageEnvelopeEntry(
  message: BaseMessage,
  item: AgentMessageItem,
  index: number,
  allowUsage = false,
): LegacyMessageEnvelopeEntry | LegacyMessageCaptureFailure {
  const messageRole = role(message)
  if (messageRole === undefined) return 'message-class-unsupported'
  if (!cleanMetadata(message, allowUsage)) return 'message-metadata-unsupported'
  const messageContent = content(message.content)
  if (messageContent === undefined) return 'message-content-unsupported'
  if (item.providerRef !== undefined
      || item.role !== runnerRole(messageRole)
      || !same(item.content, runnerContent(messageContent))) return 'message-item-mismatch'
  const retainedUsage = usage(message)
  return {
    index,
    role: messageRole,
    content: messageContent,
    itemId: item.itemId,
    itemDigest: digestRunnerJson(item),
    ...(retainedUsage === undefined || retainedUsage === false
      ? {} : { usageMetadata: retainedUsage }),
  }
}

export function validMessageEnvelopeEntry(
  value: unknown,
  index: number,
): value is LegacyMessageEnvelopeEntry {
  const keys = object(value) ? Object.keys(value).sort().join('|') : ''
  const expectedKeys = value !== null && typeof value === 'object'
    && 'usageMetadata' in value
    ? 'content|index|itemDigest|itemId|role|usageMetadata'
    : 'content|index|itemDigest|itemId|role'
  if (!object(value)
      || keys !== expectedKeys
      || value.index !== index
      || !['system', 'human', 'ai'].includes(String(value.role))
      || typeof value.itemId !== 'string'
      || typeof value.itemDigest !== 'string'
      || !object(value.content)
      || Object.keys(value.content).sort().join('|') !== 'encoding|value') return false
  const retainedUsage = value.usageMetadata
  if (retainedUsage !== undefined && (value.role !== 'ai'
      || !object(retainedUsage)
      || Object.keys(retainedUsage).sort().join('|') !== 'input_tokens|output_tokens|total_tokens'
      || !Number.isSafeInteger(retainedUsage.input_tokens)
      || !Number.isSafeInteger(retainedUsage.output_tokens)
      || retainedUsage.total_tokens
        !== Number(retainedUsage.input_tokens) + Number(retainedUsage.output_tokens))) return false
  if (value.content.encoding === 'string') return typeof value.content.value === 'string'
  return value.content.encoding === 'standard-text-blocks'
    && Array.isArray(value.content.value)
    && value.content.value.every((block) => object(block)
      && Object.keys(block).sort().join('|') === 'text|type'
      && block.type === 'text'
      && typeof block.text === 'string')
}

export function reconstructLegacyMessage(entry: LegacyMessageEnvelopeEntry): BaseMessage {
  const messageContent = entry.content.encoding === 'string'
    ? entry.content.value
    : entry.content.value.map((block) => ({ ...block }))
  if (entry.role === 'system') return new SystemMessage(messageContent)
  if (entry.role === 'human') return new HumanMessage(messageContent)
  const message = new AIMessage(messageContent)
  if (entry.usageMetadata !== undefined) {
    ;(message as unknown as { usage_metadata: BasicUsageMetadata }).usage_metadata =
      entry.usageMetadata
  }
  return message
}

export function boundMessageEnvelopeEntry(
  entry: LegacyMessageEnvelopeEntry,
  item: AgentMessageItem,
): boolean {
  return entry.itemId === item.itemId
    && entry.itemDigest === digestRunnerJson(item)
    && item.providerRef === undefined
    && item.role === runnerRole(entry.role)
    && same(item.content, runnerContent(entry.content))
}
