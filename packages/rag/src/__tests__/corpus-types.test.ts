/**
 * Unit tests for corpus-types (W24-A1).
 *
 * corpus-types.ts exports:
 *   - Type-only: Corpus, CorpusConfig, CorpusSource, IngestJobResult,
 *     CorpusStats, CorpusScoredDocument
 *   - Runtime: CorpusNotFoundError, SourceNotFoundError
 *
 * These tests exercise the runtime error classes exhaustively and type-check
 * the exported interfaces via constructible objects.
 */

import { describe, it, expect } from 'vitest'
import {
  CorpusNotFoundError,
  SourceNotFoundError,
} from '../corpus-types.js'
import type {
  Corpus,
  CorpusConfig,
  CorpusSource,
  IngestJobResult,
  CorpusStats,
  CorpusScoredDocument,
} from '../corpus-types.js'

// ===========================================================================
// CorpusNotFoundError
// ===========================================================================

describe('CorpusNotFoundError', () => {
  it('is a subclass of Error', () => {
    const err = new CorpusNotFoundError('my-corpus')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(CorpusNotFoundError)
  })

  it('sets the name property to CorpusNotFoundError', () => {
    const err = new CorpusNotFoundError('x')
    expect(err.name).toBe('CorpusNotFoundError')
  })

  it('includes the corpus id in the message', () => {
    const err = new CorpusNotFoundError('research-kb')
    expect(err.message).toBe('Corpus not found: research-kb')
    expect(err.message).toContain('research-kb')
  })

  it('handles empty corpus id gracefully', () => {
    const err = new CorpusNotFoundError('')
    expect(err.message).toBe('Corpus not found: ')
    expect(err.name).toBe('CorpusNotFoundError')
  })

  it('handles corpus ids with special characters', () => {
    const err = new CorpusNotFoundError('tenant/corp:42 spaces')
    expect(err.message).toBe('Corpus not found: tenant/corp:42 spaces')
  })

  it('produces a stack trace', () => {
    const err = new CorpusNotFoundError('x')
    expect(err.stack).toBeDefined()
    expect(typeof err.stack).toBe('string')
  })

  it('is catchable via try/catch as Error', () => {
    let caught: unknown
    try {
      throw new CorpusNotFoundError('missing')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
    expect(caught).toBeInstanceOf(CorpusNotFoundError)
    expect((caught as Error).message).toContain('missing')
  })

  it('is distinguishable from other error types at runtime', () => {
    const cnf = new CorpusNotFoundError('a')
    const snf = new SourceNotFoundError('b')
    const plain = new Error('generic')
    expect(cnf instanceof CorpusNotFoundError).toBe(true)
    expect(snf instanceof CorpusNotFoundError).toBe(false)
    expect(plain instanceof CorpusNotFoundError).toBe(false)
  })
})

// ===========================================================================
// SourceNotFoundError
// ===========================================================================

describe('SourceNotFoundError', () => {
  it('is a subclass of Error', () => {
    const err = new SourceNotFoundError('src-42')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(SourceNotFoundError)
  })

  it('sets the name property to SourceNotFoundError', () => {
    const err = new SourceNotFoundError('src-42')
    expect(err.name).toBe('SourceNotFoundError')
  })

  it('includes the source id in the message', () => {
    const err = new SourceNotFoundError('document-abc')
    expect(err.message).toBe('Source not found: document-abc')
    expect(err.message).toContain('document-abc')
  })

  it('handles empty source id gracefully', () => {
    const err = new SourceNotFoundError('')
    expect(err.message).toBe('Source not found: ')
    expect(err.name).toBe('SourceNotFoundError')
  })

  it('handles unicode source ids', () => {
    const err = new SourceNotFoundError('文档-✓')
    expect(err.message).toBe('Source not found: 文档-✓')
  })

  it('is catchable as Error and SourceNotFoundError', () => {
    let caught: unknown
    try {
      throw new SourceNotFoundError('missing-src')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
    expect(caught).toBeInstanceOf(SourceNotFoundError)
  })

  it('is not an instance of CorpusNotFoundError', () => {
    const err = new SourceNotFoundError('src')
    expect(err instanceof CorpusNotFoundError).toBe(false)
  })

  it('produces a usable stack trace', () => {
    const err = new SourceNotFoundError('x')
    expect(err.stack).toBeDefined()
    expect(err.stack).toContain('SourceNotFoundError')
  })
})

// ===========================================================================
// Type contracts (compile-time assertion via constructible objects)
// ===========================================================================

describe('Corpus type contract', () => {
  it('constructs a minimal Corpus without config', () => {
    const corpus: Corpus = {
      id: 'c1',
      name: 'Research',
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-02'),
    }
    expect(corpus.id).toBe('c1')
    expect(corpus.name).toBe('Research')
    expect(corpus.createdAt).toBeInstanceOf(Date)
    expect(corpus.updatedAt).toBeInstanceOf(Date)
    expect(corpus.config).toBeUndefined()
  })

  it('constructs a Corpus with full config', () => {
    const corpus: Corpus = {
      id: 'c2',
      name: 'Named',
      createdAt: new Date(),
      updatedAt: new Date(),
      config: {
        collectionPrefix: 'foo_',
        chunkingConfig: { targetTokens: 500, overlapFraction: 0.1 },
      },
    }
    expect(corpus.config!.collectionPrefix).toBe('foo_')
    expect(corpus.config!.chunkingConfig!.targetTokens).toBe(500)
  })
})

describe('CorpusConfig type contract', () => {
  it('allows empty config', () => {
    const cfg: CorpusConfig = {}
    expect(cfg).toEqual({})
  })

  it('allows only collectionPrefix', () => {
    const cfg: CorpusConfig = { collectionPrefix: 'abc_' }
    expect(cfg.collectionPrefix).toBe('abc_')
    expect(cfg.chunkingConfig).toBeUndefined()
  })

  it('allows partial chunkingConfig', () => {
    const cfg: CorpusConfig = { chunkingConfig: { targetTokens: 100 } }
    expect(cfg.chunkingConfig!.targetTokens).toBe(100)
    expect(cfg.chunkingConfig!.overlapFraction).toBeUndefined()
  })
})

describe('CorpusSource type contract', () => {
  it('constructs minimal source with id and text', () => {
    const src: CorpusSource = { id: 's1', text: 'hello world' }
    expect(src.id).toBe('s1')
    expect(src.text).toBe('hello world')
    expect(src.metadata).toBeUndefined()
  })

  it('supports arbitrary metadata record', () => {
    const src: CorpusSource = {
      id: 's2',
      text: 'content',
      metadata: { author: 'alice', year: 2024, tags: ['a', 'b'] },
    }
    expect(src.metadata).toMatchObject({ author: 'alice', year: 2024 })
  })
})

describe('IngestJobResult type contract', () => {
  it('constructs a fresh ingestion result', () => {
    const r: IngestJobResult = {
      corpusId: 'c',
      sourceId: 's',
      chunksCreated: 10,
      chunksReplaced: 0,
    }
    expect(r.chunksReplaced).toBe(0)
    expect(r.chunksCreated).toBe(10)
  })

  it('constructs a replacement ingestion result', () => {
    const r: IngestJobResult = {
      corpusId: 'c',
      sourceId: 's',
      chunksCreated: 8,
      chunksReplaced: 4,
    }
    expect(r.chunksReplaced).toBeGreaterThan(0)
  })
})

describe('CorpusStats type contract', () => {
  it('constructs stats with empty collections', () => {
    const stats: CorpusStats = {
      corpusId: 'c',
      totalSources: 0,
      totalChunks: 0,
      collections: [],
    }
    expect(stats.collections).toEqual([])
  })

  it('constructs stats with multiple collections', () => {
    const stats: CorpusStats = {
      corpusId: 'c',
      totalSources: 3,
      totalChunks: 42,
      collections: ['coll_a', 'coll_b'],
    }
    expect(stats.collections).toHaveLength(2)
    expect(stats.totalChunks).toBe(42)
  })
})

describe('CorpusScoredDocument type contract', () => {
  it('constructs a scored document', () => {
    const doc: CorpusScoredDocument = {
      id: 'd1',
      text: 'snippet',
      score: 0.87,
      metadata: { kind: 'article' },
    }
    expect(doc.score).toBeCloseTo(0.87)
    expect(doc.metadata['kind']).toBe('article')
  })

  it('allows empty metadata record', () => {
    const doc: CorpusScoredDocument = {
      id: 'd',
      text: 't',
      score: 0,
      metadata: {},
    }
    expect(doc.metadata).toEqual({})
  })
})
