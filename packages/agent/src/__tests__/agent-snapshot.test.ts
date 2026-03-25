import { describe, it, expect } from 'vitest'
import {
  createSnapshot,
  verifySnapshot,
  compressSnapshot,
  decompressSnapshot,
} from '../snapshot/agent-snapshot.js'

describe('createSnapshot', () => {
  it('includes hash, timestamp, and schemaVersion', () => {
    const snapshot = createSnapshot({
      agentId: 'test-agent',
      agentName: 'Test Agent',
      messages: [{ role: 'user', content: 'hello' }],
    })

    expect(snapshot.schemaVersion).toBe('1.0.0')
    expect(snapshot.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(snapshot.createdAt).toBeTruthy()
    expect(new Date(snapshot.createdAt).getTime()).not.toBeNaN()
  })

  it('includes all provided fields', () => {
    const snapshot = createSnapshot({
      agentId: 'agent-1',
      agentName: 'Agent One',
      messages: [{ role: 'user', content: 'test' }],
      budgetState: { tokensUsed: 1000, costCents: 5, iterations: 3 },
      config: { temperature: 0.7 },
      toolNames: ['read_file', 'write_file'],
      workingMemory: { lastFile: 'index.ts' },
      metadata: { runId: 'run-123' },
    })

    expect(snapshot.agentId).toBe('agent-1')
    expect(snapshot.agentName).toBe('Agent One')
    expect(snapshot.messages).toEqual([{ role: 'user', content: 'test' }])
    expect(snapshot.budgetState).toEqual({ tokensUsed: 1000, costCents: 5, iterations: 3 })
    expect(snapshot.config).toEqual({ temperature: 0.7 })
    expect(snapshot.toolNames).toEqual(['read_file', 'write_file'])
    expect(snapshot.workingMemory).toEqual({ lastFile: 'index.ts' })
    expect(snapshot.metadata).toEqual({ runId: 'run-123' })
  })
})

describe('verifySnapshot', () => {
  it('returns true for a valid (untampered) snapshot', () => {
    const snapshot = createSnapshot({
      agentId: 'test',
      agentName: 'Test',
      messages: [{ role: 'user', content: 'hello' }],
    })

    expect(verifySnapshot(snapshot)).toBe(true)
  })

  it('returns false for a tampered snapshot', () => {
    const snapshot = createSnapshot({
      agentId: 'test',
      agentName: 'Test',
      messages: [{ role: 'user', content: 'hello' }],
    })

    // Tamper with the messages
    const tampered = { ...snapshot, messages: [{ role: 'user', content: 'tampered' }] }
    expect(verifySnapshot(tampered)).toBe(false)
  })

  it('returns false when agentId is changed', () => {
    const snapshot = createSnapshot({
      agentId: 'original',
      agentName: 'Original',
      messages: [],
    })

    const tampered = { ...snapshot, agentId: 'changed' }
    expect(verifySnapshot(tampered)).toBe(false)
  })
})

describe('compressSnapshot / decompressSnapshot', () => {
  it('round-trips messages through compress/decompress', () => {
    const original = createSnapshot({
      agentId: 'compress-test',
      agentName: 'Compress Test',
      messages: [
        { role: 'user', content: 'hello world' },
        { role: 'assistant', content: 'hi there' },
        { role: 'user', content: 'how are you?' },
      ],
      budgetState: { tokensUsed: 500, costCents: 2, iterations: 1 },
      toolNames: ['search', 'write'],
    })

    const compressed = compressSnapshot(original)
    expect(compressed.compressed).toBe(true)
    // Compressed messages should be a single base64 string
    expect(compressed.messages).toHaveLength(1)
    expect(typeof compressed.messages[0]).toBe('string')

    // Verify the compressed snapshot has a valid hash
    expect(verifySnapshot(compressed)).toBe(true)

    const decompressed = decompressSnapshot(compressed)
    expect(decompressed.compressed).toBeUndefined()
    expect(decompressed.messages).toEqual(original.messages)
    expect(decompressed.agentId).toBe(original.agentId)
    expect(decompressed.agentName).toBe(original.agentName)
    expect(decompressed.budgetState).toEqual(original.budgetState)
    expect(decompressed.toolNames).toEqual(original.toolNames)
  })

  it('compressing an already compressed snapshot is idempotent', () => {
    const original = createSnapshot({
      agentId: 'test',
      agentName: 'Test',
      messages: [{ role: 'user', content: 'data' }],
    })

    const compressed1 = compressSnapshot(original)
    const compressed2 = compressSnapshot(compressed1)

    expect(compressed2.contentHash).toBe(compressed1.contentHash)
  })

  it('decompressing an uncompressed snapshot returns it unchanged', () => {
    const original = createSnapshot({
      agentId: 'test',
      agentName: 'Test',
      messages: [{ role: 'user', content: 'data' }],
    })

    const result = decompressSnapshot(original)
    expect(result.messages).toEqual(original.messages)
  })

  it('preserves createdAt through compress/decompress', () => {
    const original = createSnapshot({
      agentId: 'test',
      agentName: 'Test',
      messages: [{ role: 'user', content: 'data' }],
    })

    const compressed = compressSnapshot(original)
    const decompressed = decompressSnapshot(compressed)

    expect(decompressed.createdAt).toBe(original.createdAt)
  })
})
