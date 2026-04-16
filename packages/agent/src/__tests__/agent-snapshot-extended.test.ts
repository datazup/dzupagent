/**
 * Extended round-trip fidelity tests for agent snapshots and serialized messages.
 *
 * Covers:
 * - Tool-call-heavy history round-trips (serialize -> deserialize -> identical)
 * - Structured AI message content round-trips
 * - Unknown/future fields via passthrough
 * - Snapshot equality after normalization
 * - Empty history round-trip
 * - Large history (100+ messages) round-trip
 * - System message preservation
 * - Working memory and metadata round-trip through compression
 * - Hash stability (identical params produce identical hashes)
 * - Tamper detection on every field
 */
import { describe, it, expect } from 'vitest'
import {
  createSnapshot,
  verifySnapshot,
  compressSnapshot,
  decompressSnapshot,
} from '../snapshot/agent-snapshot.js'
import type { AgentStateSnapshot } from '../snapshot/agent-snapshot.js'
import {
  serializeMessage,
  migrateMessages,
} from '../snapshot/serialized-message.js'
import type { SerializedMessage } from '../snapshot/serialized-message.js'

// ---------------------------------------------------------------------------
// Round-trip with tool-call-heavy history
// ---------------------------------------------------------------------------

describe('Snapshot round-trip: tool-call-heavy history', () => {
  const toolCallMessages: SerializedMessage[] = Array.from({ length: 10 }, (_, i) => [
    {
      role: 'assistant' as const,
      content: `Calling tool ${i}`,
      toolCalls: [
        { id: `call_${i}a`, name: 'read_file', arguments: { path: `/src/file${i}.ts` } },
        { id: `call_${i}b`, name: 'search_code', arguments: { query: `pattern${i}`, maxResults: 10 } },
      ],
    },
    {
      role: 'tool' as const,
      content: `Result of read_file for file${i}.ts: export function fn${i}() {}`,
      toolCallId: `call_${i}a`,
    },
    {
      role: 'tool' as const,
      content: `Found 3 matches for pattern${i}`,
      toolCallId: `call_${i}b`,
    },
  ]).flat()

  it('compress/decompress preserves all tool calls and tool results', () => {
    const original = createSnapshot({
      agentId: 'tool-heavy-agent',
      agentName: 'Tool-Heavy Agent',
      messages: toolCallMessages,
    })

    const compressed = compressSnapshot(original)
    const decompressed = decompressSnapshot(compressed)

    expect(decompressed.messages).toEqual(toolCallMessages)
    expect(decompressed.messages).toHaveLength(30)
  })

  it('verifySnapshot passes on both compressed and decompressed forms', () => {
    const original = createSnapshot({
      agentId: 'tc-agent',
      agentName: 'TC Agent',
      messages: toolCallMessages,
    })

    const compressed = compressSnapshot(original)
    expect(verifySnapshot(compressed)).toBe(true)

    const decompressed = decompressSnapshot(compressed)
    expect(verifySnapshot(decompressed)).toBe(true)
  })

  it('tool call arguments with nested objects survive round-trip', () => {
    const messages: SerializedMessage[] = [
      {
        role: 'assistant',
        content: 'Calling with nested args',
        toolCalls: [{
          id: 'call_nested',
          name: 'complex_tool',
          arguments: {
            filter: { tags: ['a', 'b'], range: { min: 0, max: 100 } },
            options: { recursive: true, depth: 3 },
          },
        }],
      },
    ]

    const snap = createSnapshot({
      agentId: 'nested-args',
      agentName: 'Nested Args',
      messages,
    })

    const decompressed = decompressSnapshot(compressSnapshot(snap))
    const restored = decompressed.messages[0] as SerializedMessage
    expect(restored.toolCalls![0]!.arguments).toEqual({
      filter: { tags: ['a', 'b'], range: { min: 0, max: 100 } },
      options: { recursive: true, depth: 3 },
    })
  })
})

// ---------------------------------------------------------------------------
// Structured AI content round-trips
// ---------------------------------------------------------------------------

describe('Snapshot round-trip: structured content', () => {
  it('multimodal content array survives round-trip', () => {
    const messages = [
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: 'Describe this image' },
          { type: 'image' as const, url: 'https://example.com/photo.jpg', mimeType: 'image/jpeg' },
        ],
      },
      { role: 'assistant' as const, content: 'This image shows a landscape.' },
    ]

    const snap = createSnapshot({ agentId: 'mm', agentName: 'MM', messages })
    const rt = decompressSnapshot(compressSnapshot(snap))
    expect(rt.messages).toEqual(messages)
  })

  it('serialized messages with metadata survive round-trip', () => {
    const messages: SerializedMessage[] = [
      { role: 'assistant', content: 'response', metadata: { model: 'gpt-4', temperature: 0.7 } },
    ]

    const snap = createSnapshot({ agentId: 'meta', agentName: 'Meta', messages })
    const rt = decompressSnapshot(compressSnapshot(snap))
    const msg = rt.messages[0] as SerializedMessage
    expect(msg.metadata).toEqual({ model: 'gpt-4', temperature: 0.7 })
  })
})

// ---------------------------------------------------------------------------
// Unknown/future fields passthrough
// ---------------------------------------------------------------------------

describe('Snapshot round-trip: unknown fields', () => {
  it('extra fields on messages are preserved through compress/decompress', () => {
    const messages = [
      { role: 'user', content: 'hello', futureField: 'extra-data', priority: 5 },
    ]

    const snap = createSnapshot({ agentId: 'uf', agentName: 'UF', messages })
    const rt = decompressSnapshot(compressSnapshot(snap))
    const msg = rt.messages[0] as Record<string, unknown>
    expect(msg['futureField']).toBe('extra-data')
    expect(msg['priority']).toBe(5)
  })

  it('extra fields on workingMemory are preserved', () => {
    const snap = createSnapshot({
      agentId: 'wm',
      agentName: 'WM',
      messages: [],
      workingMemory: { known: 'value', futureKey: { nested: true } },
    })

    const rt = decompressSnapshot(compressSnapshot(snap))
    expect(rt.workingMemory).toEqual({ known: 'value', futureKey: { nested: true } })
  })
})

// ---------------------------------------------------------------------------
// Empty history round-trip
// ---------------------------------------------------------------------------

describe('Snapshot round-trip: empty history', () => {
  it('round-trips empty messages array', () => {
    const snap = createSnapshot({ agentId: 'empty', agentName: 'Empty', messages: [] })
    const compressed = compressSnapshot(snap)
    const decompressed = decompressSnapshot(compressed)
    expect(decompressed.messages).toEqual([])
  })

  it('verifies both compressed and decompressed empty snapshots', () => {
    const snap = createSnapshot({ agentId: 'e', agentName: 'E', messages: [] })
    expect(verifySnapshot(snap)).toBe(true)
    expect(verifySnapshot(compressSnapshot(snap))).toBe(true)
    expect(verifySnapshot(decompressSnapshot(compressSnapshot(snap)))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Large history round-trip
// ---------------------------------------------------------------------------

describe('Snapshot round-trip: large history (100+ messages)', () => {
  const largeHistory = Array.from({ length: 120 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `Message number ${i}: ${'x'.repeat(200)}`,
  }))

  it('round-trips 120 messages without data loss', () => {
    const snap = createSnapshot({
      agentId: 'large',
      agentName: 'Large Agent',
      messages: largeHistory,
    })

    const rt = decompressSnapshot(compressSnapshot(snap))
    expect(rt.messages).toHaveLength(120)
    expect(rt.messages).toEqual(largeHistory)
  })

  it('compressed snapshot is smaller than original JSON', () => {
    const snap = createSnapshot({
      agentId: 'large',
      agentName: 'Large Agent',
      messages: largeHistory,
    })

    const compressed = compressSnapshot(snap)
    const compressedSize = JSON.stringify(compressed).length
    const originalSize = JSON.stringify(snap).length
    expect(compressedSize).toBeLessThan(originalSize)
  })

  it('hash changes when any message in large history is modified', () => {
    const snap = createSnapshot({
      agentId: 'large',
      agentName: 'Large Agent',
      messages: largeHistory,
    })

    const modified = [...largeHistory]
    modified[60] = { ...modified[60]!, content: 'TAMPERED' }
    const snap2 = createSnapshot({
      agentId: 'large',
      agentName: 'Large Agent',
      messages: modified,
    })

    expect(snap.contentHash).not.toBe(snap2.contentHash)
  })
})

// ---------------------------------------------------------------------------
// System message preservation
// ---------------------------------------------------------------------------

describe('Snapshot round-trip: system message preservation', () => {
  it('preserves system messages through round-trip', () => {
    const messages: SerializedMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ]

    const snap = createSnapshot({ agentId: 'sys', agentName: 'Sys', messages })
    const rt = decompressSnapshot(compressSnapshot(snap))
    expect(rt.messages[0]).toEqual({ role: 'system', content: 'You are a helpful assistant.' })
  })

  it('preserves multiple system messages in history', () => {
    const messages: SerializedMessage[] = [
      { role: 'system', content: 'Initial instructions' },
      { role: 'user', content: 'Question' },
      { role: 'system', content: 'Updated instructions mid-conversation' },
      { role: 'assistant', content: 'Answer' },
    ]

    const snap = createSnapshot({ agentId: 'ms', agentName: 'MS', messages })
    const rt = decompressSnapshot(compressSnapshot(snap))
    const systemMsgs = (rt.messages as SerializedMessage[]).filter((m) => m.role === 'system')
    expect(systemMsgs).toHaveLength(2)
    expect(systemMsgs[0]!.content).toBe('Initial instructions')
    expect(systemMsgs[1]!.content).toBe('Updated instructions mid-conversation')
  })
})

// ---------------------------------------------------------------------------
// Hash stability and tamper detection on every field
// ---------------------------------------------------------------------------

describe('Snapshot hash stability', () => {
  it('identical params produce identical hashes', () => {
    const params = {
      agentId: 'stable',
      agentName: 'Stable',
      messages: [{ role: 'user' as const, content: 'test' }],
      budgetState: { tokensUsed: 100, costCents: 1, iterations: 2 },
    }

    const snap1 = createSnapshot(params)
    const snap2 = createSnapshot(params)
    expect(snap1.contentHash).toBe(snap2.contentHash)
  })

  it('tamper detection: changing agentName invalidates hash', () => {
    const snap = createSnapshot({ agentId: 'a', agentName: 'Original', messages: [] })
    const tampered = { ...snap, agentName: 'Changed' }
    expect(verifySnapshot(tampered)).toBe(false)
  })

  it('tamper detection: changing budgetState invalidates hash', () => {
    const snap = createSnapshot({
      agentId: 'a',
      agentName: 'A',
      messages: [],
      budgetState: { tokensUsed: 100, costCents: 5, iterations: 1 },
    })
    const tampered = { ...snap, budgetState: { tokensUsed: 999, costCents: 5, iterations: 1 } }
    expect(verifySnapshot(tampered)).toBe(false)
  })

  it('tamper detection: changing toolNames invalidates hash', () => {
    const snap = createSnapshot({
      agentId: 'a',
      agentName: 'A',
      messages: [],
      toolNames: ['read_file'],
    })
    const tampered = { ...snap, toolNames: ['read_file', 'write_file'] }
    expect(verifySnapshot(tampered)).toBe(false)
  })

  it('tamper detection: changing workingMemory invalidates hash', () => {
    const snap = createSnapshot({
      agentId: 'a',
      agentName: 'A',
      messages: [],
      workingMemory: { key: 'original' },
    })
    const tampered = { ...snap, workingMemory: { key: 'tampered' } }
    expect(verifySnapshot(tampered)).toBe(false)
  })

  it('tamper detection: changing metadata invalidates hash', () => {
    const snap = createSnapshot({
      agentId: 'a',
      agentName: 'A',
      messages: [],
      metadata: { runId: 'run-1' },
    })
    const tampered = { ...snap, metadata: { runId: 'run-2' } }
    expect(verifySnapshot(tampered)).toBe(false)
  })

  it('tamper detection: changing config invalidates hash', () => {
    const snap = createSnapshot({
      agentId: 'a',
      agentName: 'A',
      messages: [],
      config: { temperature: 0.7 },
    })
    const tampered = { ...snap, config: { temperature: 1.0 } }
    expect(verifySnapshot(tampered)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// serializeMessage round-trip normalization fidelity
// ---------------------------------------------------------------------------

describe('serializeMessage normalization fidelity', () => {
  it('double-serialization is idempotent for plain messages', () => {
    const original = { role: 'user', content: 'hello' }
    const first = serializeMessage(original)
    const second = serializeMessage(first)
    expect(first).toEqual(second)
  })

  it('double-serialization is idempotent for tool call messages', () => {
    const original: SerializedMessage = {
      role: 'assistant',
      content: 'calling',
      toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'a.ts' } }],
    }
    const first = serializeMessage(original)
    const second = serializeMessage(first)
    expect(first).toEqual(second)
  })

  it('migrateMessages produces stable output on re-migration', () => {
    const mixed = [
      { role: 'human', content: 'hi' },
      { role: 'ai', content: 'hello', tool_calls: [{ id: 'c1', function: { name: 'fn', arguments: '{"x":1}' } }] },
      { role: 'function', content: 'result', tool_call_id: 'c1' },
    ]

    const first = migrateMessages(mixed)
    const second = migrateMessages(first)
    expect(first).toEqual(second)
  })

  it('normalizes null content to empty string', () => {
    const msg = serializeMessage({ role: 'user', content: null })
    expect(msg.content).toBe('')
  })

  it('normalizes undefined content to empty string', () => {
    const msg = serializeMessage({ role: 'user', content: undefined })
    expect(msg.content).toBe('')
  })
})
