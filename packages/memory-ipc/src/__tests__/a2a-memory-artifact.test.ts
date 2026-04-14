import { describe, it, expect } from 'vitest'

import { FrameBuilder } from '../frame-builder.js'
import { FrameReader } from '../frame-reader.js'
import {
  createMemoryArtifact,
  parseMemoryArtifact,
  sanitizeForExport,
} from '../a2a-memory-artifact.js'
import { MEMORY_FRAME_VERSION } from '../schema.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildTestTable(count: number) {
  const builder = new FrameBuilder()
  for (let i = 0; i < count; i++) {
    builder.add(
      {
        text: `Memory ${i}`,
        _temporal: {
          systemCreatedAt: 1700000000000 + i * 60000,
          validFrom: 1700000000000 + i * 60000,
        },
        _decay: { strength: 0.9 - i * 0.1 },
        _agent: 'agent-alpha',
        category: i % 2 === 0 ? 'decision' : 'lesson',
        importance: 0.5 + i * 0.1,
        customPayload: `data-${i}`,
      },
      {
        id: `mem-${i}`,
        namespace: i < 2 ? 'decisions' : 'lessons',
        key: `key-${i}`,
        scope: { tenant: 't1', project: 'p1', agent: 'agent-alpha' },
      },
    )
  }
  return builder.build()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createMemoryArtifact', () => {
  it('creates artifact with correct structure and MIME type', () => {
    const table = buildTestTable(3)
    const artifact = createMemoryArtifact(table, 'agent://planner')

    expect(artifact.name).toBe('dzupagent_memory_batch')
    expect(artifact.description).toContain('agent://planner')
    expect(artifact.description).toContain('3 records')
    expect(artifact.parts.length).toBe(1)

    const part = artifact.parts[0]
    expect(part.kind).toBe('data')
    expect(part.mimeType).toBe('application/vnd.apache.arrow.stream')
    expect(typeof part.data).toBe('string')
    expect(part.data.length).toBeGreaterThan(0)

    // Metadata
    expect(part.metadata.schema_version).toBe(MEMORY_FRAME_VERSION)
    expect(part.metadata.record_count).toBe(3)
    expect(part.metadata.source_agent).toBe('agent://planner')
    expect(part.metadata.namespaces).toContain('decisions')
    expect(part.metadata.namespaces).toContain('lessons')
  })

  it('computes temporal range from system_created_at', () => {
    const table = buildTestTable(5)
    const artifact = createMemoryArtifact(table, 'agent://test')

    const range = artifact.parts[0].metadata.temporal_range
    expect(range.earliest).toBe(1700000000000)
    expect(range.latest).toBe(1700000000000 + 4 * 60000)
  })

  it('uses custom description when provided', () => {
    const table = buildTestTable(1)
    const artifact = createMemoryArtifact(table, 'agent://x', 'My custom batch')

    expect(artifact.description).toBe('My custom batch')
  })

  it('handles empty table', () => {
    const builder = new FrameBuilder()
    const table = builder.build()
    const artifact = createMemoryArtifact(table, 'agent://empty')

    expect(artifact.parts[0].metadata.record_count).toBe(0)
    expect(artifact.parts[0].metadata.temporal_range).toEqual({
      earliest: 0,
      latest: 0,
    })
  })
})

describe('parseMemoryArtifact', () => {
  it('round-trips table through artifact', () => {
    const original = buildTestTable(4)
    const artifact = createMemoryArtifact(original, 'agent://test')
    const { table, metadata } = parseMemoryArtifact(artifact)

    expect(table.numRows).toBe(4)
    expect(metadata.record_count).toBe(4)
    expect(metadata.source_agent).toBe('agent://test')

    // Verify records match
    const originalRecords = new FrameReader(original).toRecords()
    const restoredRecords = new FrameReader(table).toRecords()

    expect(restoredRecords.length).toBe(originalRecords.length)
    for (let i = 0; i < restoredRecords.length; i++) {
      expect(restoredRecords[i]!.meta.id).toBe(originalRecords[i]!.meta.id)
      expect(restoredRecords[i]!.value.text).toBe(
        originalRecords[i]!.value.text,
      )
    }
  })

  it('preserves metadata through round-trip', () => {
    const table = buildTestTable(2)
    const artifact = createMemoryArtifact(table, 'agent://keeper')
    const { metadata } = parseMemoryArtifact(artifact)

    expect(metadata.schema_version).toBe(MEMORY_FRAME_VERSION)
    expect(metadata.source_agent).toBe('agent://keeper')
    expect(metadata.namespaces).toContain('decisions')
  })
})

describe('sanitizeForExport', () => {
  it('redacts specified columns', () => {
    const table = buildTestTable(3)
    const { table: sanitized, redactedFields } = sanitizeForExport(table, {
      redactColumns: ['text', 'importance'],
    })

    expect(sanitized.numRows).toBe(3)
    expect(redactedFields).toContain('text')
    expect(redactedFields).toContain('importance')

    // Verify redacted columns are null
    const textCol = sanitized.getChild('text')
    for (let i = 0; i < sanitized.numRows; i++) {
      expect(textCol?.get(i)).toBeNull()
    }

    // Verify non-redacted columns are preserved
    const idCol = sanitized.getChild('id')
    expect(idCol?.get(0)).toBe('mem-0')
  })

  it('excludes specified namespaces', () => {
    const table = buildTestTable(4) // 2 decisions, 2 lessons
    const { table: sanitized } = sanitizeForExport(table, {
      excludeNamespaces: ['lessons'],
    })

    expect(sanitized.numRows).toBe(2)

    // All remaining should be 'decisions'
    const nsCol = sanitized.getChild('namespace')
    for (let i = 0; i < sanitized.numRows; i++) {
      expect(nsCol?.get(i)).toBe('decisions')
    }
  })

  it('strips payload_json when requested', () => {
    const table = buildTestTable(2)
    const { table: sanitized, redactedFields } = sanitizeForExport(table, {
      stripPayload: true,
    })

    expect(redactedFields).toContain('payload_json')
    const payloadCol = sanitized.getChild('payload_json')
    for (let i = 0; i < sanitized.numRows; i++) {
      expect(payloadCol?.get(i)).toBeNull()
    }
  })

  it('combines redact + exclude', () => {
    const table = buildTestTable(4)
    const { table: sanitized, redactedFields } = sanitizeForExport(table, {
      redactColumns: ['importance'],
      excludeNamespaces: ['lessons'],
    })

    // Only decisions remain (2 rows)
    expect(sanitized.numRows).toBe(2)
    expect(redactedFields).toContain('importance')

    // importance should be null
    const impCol = sanitized.getChild('importance')
    for (let i = 0; i < sanitized.numRows; i++) {
      expect(impCol?.get(i)).toBeNull()
    }
  })

  it('returns empty table when all namespaces excluded', () => {
    const table = buildTestTable(4)
    const { table: sanitized } = sanitizeForExport(table, {
      excludeNamespaces: ['decisions', 'lessons'],
    })

    expect(sanitized.numRows).toBe(0)
  })

  it('handles empty options (no-op)', () => {
    const table = buildTestTable(3)
    const { table: sanitized, redactedFields } = sanitizeForExport(table, {})

    expect(sanitized.numRows).toBe(3)
    expect(redactedFields).toEqual([])
  })
})
