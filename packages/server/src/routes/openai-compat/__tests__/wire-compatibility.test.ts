import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { BaseMessage } from '@langchain/core/messages'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  mapFinalStreamChunk,
  mapRequest,
  mapResponseWithTools,
  type EnhancedMappedRequest,
  validateCompletionRequest,
} from '../request-mapper.js'
import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
} from '../types.js'

function loadJsonFixture<T>(name: string): T {
  const path = resolve(import.meta.dirname, 'fixtures', name)
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function expectStringField(record: Record<string, unknown>, key: string): void {
  expect(typeof record[key]).toBe('string')
}

function expectNumberField(record: Record<string, unknown>, key: string): void {
  expect(typeof record[key]).toBe('number')
}

function expectChatCompletionRequestShape(value: unknown): asserts value is ChatCompletionRequest {
  expect(isRecord(value)).toBe(true)
  const record = value as Record<string, unknown>
  expectStringField(record, 'model')
  expect(Array.isArray(record['messages'])).toBe(true)
  for (const message of record['messages'] as unknown[]) {
    expect(isRecord(message)).toBe(true)
    expect(['system', 'user', 'assistant', 'tool']).toContain(
      (message as Record<string, unknown>)['role'],
    )
    const content = (message as Record<string, unknown>)['content']
    expect(content === null || typeof content === 'string').toBe(true)
  }
}

function expectMappedRequestShape(value: unknown): asserts value is EnhancedMappedRequest {
  expect(isRecord(value)).toBe(true)
  const record = value as Record<string, unknown>
  expectStringField(record, 'agentId')
  expect(typeof record['prompt']).toBe('string')
  expect(record['systemOverride'] === null || typeof record['systemOverride'] === 'string').toBe(true)
  expect(isRecord(record['options'])).toBe(true)
}

function expectChatCompletionResponseShape(
  value: unknown,
): asserts value is ChatCompletionResponse {
  expect(isRecord(value)).toBe(true)
  const record = value as Record<string, unknown>
  expect(record['object']).toBe('chat.completion')
  expectStringField(record, 'id')
  expectStringField(record, 'model')
  expectNumberField(record, 'created')
  expect(Array.isArray(record['choices'])).toBe(true)
  const choice = (record['choices'] as Array<Record<string, unknown>>)[0]
  expect(isRecord(choice)).toBe(true)
  expect(choice['index']).toBe(0)
  expect(['stop', 'length', 'tool_calls']).toContain(choice['finish_reason'])
  expect(isRecord(choice['message'])).toBe(true)
  const message = choice['message'] as Record<string, unknown>
  expect(message['role']).toBe('assistant')
  expect(message['content'] === null || typeof message['content'] === 'string').toBe(true)
  if ('tool_calls' in message) {
    expect(Array.isArray(message['tool_calls'])).toBe(true)
  }
  expect(isRecord(record['usage'])).toBe(true)
}

function expectChatCompletionChunkShape(value: unknown): asserts value is ChatCompletionChunk {
  expect(isRecord(value)).toBe(true)
  const record = value as Record<string, unknown>
  expect(record['object']).toBe('chat.completion.chunk')
  expectStringField(record, 'id')
  expectStringField(record, 'model')
  expectNumberField(record, 'created')
  expect(Array.isArray(record['choices'])).toBe(true)
  const choice = (record['choices'] as Array<Record<string, unknown>>)[0]
  expect(isRecord(choice)).toBe(true)
  expect(choice['index']).toBe(0)
  expect(isRecord(choice['delta'])).toBe(true)
  expect(['stop', 'length', null]).toContain(choice['finish_reason'] as string | null)
}

describe('OpenAI wire compatibility fixtures', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('accepts a backward-compatible rich request fixture and maps it deterministically', () => {
    const requestFixture = loadJsonFixture<unknown>('chat-completion-request.v1-rich.json')
    const expectedMapped = loadJsonFixture<unknown>('mapped-request.v1-rich.json')

    expectChatCompletionRequestShape(requestFixture)

    const validation = validateCompletionRequest(requestFixture)
    expect(validation.ok).toBe(true)
    if (!validation.ok) {
      throw new Error('Expected rich request fixture to validate')
    }

    const mapped = mapRequest(validation.request)
    expectMappedRequestShape(expectedMapped)
    expect(mapped).toEqual(expectedMapped)
  })

  it('keeps a tool-call response fixture backward compatible with the generated wire shape', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_746_000_100_000)

    const expectedResponse = loadJsonFixture<unknown>('chat-completion-response-with-tools.v1.json')
    const messages = [
      {
        _getType: () => 'ai',
        content: '',
        tool_calls: [{ id: 'call_1', name: 'search', args: { query: 'openai compat' } }],
      } as unknown as BaseMessage,
    ]

    const response = mapResponseWithTools(
      'Tool invocation complete.',
      'helper',
      'chatcmpl-fixed',
      { totalInputTokens: 12, totalOutputTokens: 7 },
      messages,
      false,
    )

    expectChatCompletionResponseShape(expectedResponse)
    expect(response).toEqual(expectedResponse)
  })

  it('keeps a final streaming chunk fixture backward compatible when iteration limits are hit', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_746_000_100_000)

    const expectedChunk = loadJsonFixture<unknown>('chat-completion-final-chunk-length.v1.json')
    const chunk = mapFinalStreamChunk('helper', 'chatcmpl-fixed', {
      hitIterationLimit: true,
      stopReason: 'iteration_limit',
    })

    expectChatCompletionChunkShape(expectedChunk)
    expect(chunk).toEqual(expectedChunk)
  })
})
