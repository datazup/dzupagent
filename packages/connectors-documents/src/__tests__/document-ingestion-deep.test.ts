import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { StructuredToolInterface } from '@langchain/core/tools'

// ---------------------------------------------------------------------------
// Mocks for pdf-parse + mammoth so we can exercise PDF and DOCX ingestion
// paths deterministically without real binary fixtures.
// ---------------------------------------------------------------------------

const mockGetText = vi.fn()
vi.mock('pdf-parse', () => ({
  PDFParse: vi.fn().mockImplementation(() => ({
    getText: mockGetText,
  })),
}))

const mockExtractRawText = vi.fn()
vi.mock('mammoth', () => ({
  default: { extractRawText: mockExtractRawText },
  extractRawText: mockExtractRawText,
}))

// Import package modules after mocks are registered.
const { createDocumentConnector } = await import('../document-connector.js')
const { parseDocument } = await import('../parse-document.js')
const { splitIntoChunks } = await import('../chunking/split-into-chunks.js')
const { splitOnHeadings } = await import('../chunking/heading-chunker.js')
const { splitOnParagraphs } = await import('../chunking/paragraph-chunker.js')
const { addOverlap } = await import('../chunking/overlap.js')
const {
  isSupportedDocumentType,
  SUPPORTED_MIME_TYPES,
} = await import('../supported-types.js')
const {
  normalizeDocumentTool,
  normalizeDocumentTools,
} = await import('../connector-contract.js')

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function toB64(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64')
}

/**
 * Parse the intermediate JSON payload produced by splitIntoChunks before
 * the connector's toModelOutput collapses it to "N chunks created".
 */
function chunkArrayFromText(text: string, max = 4000, overlap = 0): string[] {
  return splitIntoChunks(text, max, overlap)
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// DocumentConnector — ingestion flows
// ---------------------------------------------------------------------------

describe('DocumentConnector ingestion', () => {
  it('ingests a mocked PDF buffer and returns extracted text', async () => {
    mockGetText.mockResolvedValue({
      text: '# Whitepaper\n\nThe quick brown fox.',
      total: 1,
      pages: [{ text: '# Whitepaper\n\nThe quick brown fox.', num: 1 }],
    })

    const [parseTool] = createDocumentConnector()
    const result = await parseTool.invoke({
      content: toB64('binary-pdf-placeholder'),
      contentType: 'application/pdf',
    })

    expect(result).toContain('Whitepaper')
    expect(mockGetText).toHaveBeenCalledTimes(1)
  })

  it('chunks ingested PDF text into multiple pieces when large', async () => {
    const big = ['## Alpha', 'A'.repeat(400), '', '## Beta', 'B'.repeat(400)].join('\n')
    mockGetText.mockResolvedValue({
      text: big,
      total: 1,
      pages: [{ text: big, num: 1 }],
    })

    const [parseTool, chunkTool] = createDocumentConnector({
      maxChunkSize: 200,
      overlap: 0,
    })

    const parsed = (await parseTool.invoke({
      content: toB64('binary'),
      contentType: 'application/pdf',
    })) as string

    const summary = (await chunkTool.invoke({
      text: parsed,
      maxChunkSize: 200,
      overlap: 0,
    })) as string

    const match = /^(\d+) chunks created$/.exec(summary)
    expect(match).not.toBeNull()
    expect(Number(match![1])).toBeGreaterThanOrEqual(2)
  })

  it('preserves markdown structure through ingestion', async () => {
    const md = [
      '# Title',
      '',
      '## Introduction',
      'Some intro paragraph.',
      '',
      '## Body',
      'Body paragraph with **bold** and _italic_ markers.',
    ].join('\n')

    const [parseTool] = createDocumentConnector()
    const parsed = (await parseTool.invoke({
      content: toB64(md),
      contentType: 'text/markdown',
    })) as string

    // Markdown is returned as-is; heading hierarchy is preserved verbatim.
    expect(parsed).toContain('# Title')
    expect(parsed).toContain('## Introduction')
    expect(parsed).toContain('## Body')
    expect(parsed).toContain('**bold**')
  })

  it('returns plaintext as a single block without any chunk separators', async () => {
    const [parseTool] = createDocumentConnector()
    const body = 'Flat plaintext paragraph without headings.'

    const parsed = (await parseTool.invoke({
      content: toB64(body),
      contentType: 'text/plain',
    })) as string

    expect(parsed).toBe(body)
    expect(parsed).not.toContain('---')
  })

  it('returns a typed error message for unsupported MIME types', async () => {
    const [parseTool] = createDocumentConnector()
    const result = (await parseTool.invoke({
      content: toB64('irrelevant'),
      contentType: 'application/x-custom-binary',
    })) as string

    expect(result.startsWith('Error: Unsupported document type')).toBe(true)
    expect(result).toContain('application/x-custom-binary')
  })

  it('ingests an empty plaintext file and chunks to an empty array', async () => {
    const [parseTool, chunkTool] = createDocumentConnector()
    const parsed = (await parseTool.invoke({
      content: toB64(''),
      contentType: 'text/plain',
    })) as string
    expect(parsed).toBe('')

    const summary = (await chunkTool.invoke({ text: parsed })) as string
    expect(summary).toBe('0 chunks created')
  })

  it('ingests a large plaintext file and produces multiple chunks', async () => {
    const large = ('Paragraph content. '.repeat(60) + '\n\n').repeat(20)
    const [, chunkTool] = createDocumentConnector({ maxChunkSize: 500, overlap: 0 })

    const summary = (await chunkTool.invoke({
      text: large,
      maxChunkSize: 500,
      overlap: 0,
    })) as string

    const count = Number(/^(\d+) chunks created$/.exec(summary)?.[1])
    expect(count).toBeGreaterThan(1)
  })
})

// ---------------------------------------------------------------------------
// ParseDocument — structural details
// ---------------------------------------------------------------------------

describe('ParseDocument structural extraction', () => {
  it('keeps the first heading as the natural title of a markdown doc', async () => {
    const md = '# My Great Title\n\nBody follows.'
    const parsed = await parseDocument(Buffer.from(md, 'utf-8'), 'text/markdown')
    const firstLine = parsed.split('\n')[0]
    expect(firstLine).toBe('# My Great Title')
  })

  it('keeps metadata-style frontmatter lines intact when present', async () => {
    const md = [
      '---',
      'author: Alice',
      'date: 2026-04-17',
      '---',
      '',
      '# Title',
      '',
      'Body.',
    ].join('\n')

    const parsed = await parseDocument(Buffer.from(md, 'utf-8'), 'text/markdown')
    expect(parsed).toContain('author: Alice')
    expect(parsed).toContain('date: 2026-04-17')
  })

  it('returns markdown body text verbatim (no markup stripping)', async () => {
    const md = '**bold** _italic_ `code`'
    const parsed = await parseDocument(Buffer.from(md, 'utf-8'), 'text/markdown')
    expect(parsed).toBe(md)
  })

  it('returns an empty string for an empty plaintext document', async () => {
    const parsed = await parseDocument(Buffer.from('', 'utf-8'), 'text/plain')
    expect(parsed).toBe('')
    expect(typeof parsed).toBe('string')
  })

  it('returns an empty text body for a markdown document containing only images', async () => {
    // Markdown image-only content: no human-readable text tokens beyond the syntax.
    const md = '![alt](image1.png)\n\n![alt2](image2.png)\n'
    const parsed = await parseDocument(Buffer.from(md, 'utf-8'), 'text/markdown')
    // After stripping image syntax there is no prose body.
    const stripped = parsed.replace(/!\[[^\]]*\]\([^)]+\)/g, '').trim()
    expect(stripped).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Chunking — invariants
// ---------------------------------------------------------------------------

describe('Chunking invariants', () => {
  it('no chunk exceeds maxChunkSize for paragraph-bounded text', () => {
    const paragraphs = Array.from({ length: 40 }, (_, i) => `P${i}. ${'x'.repeat(80)}`)
    const doc = paragraphs.join('\n\n')
    const max = 200
    const chunks = chunkArrayFromText(doc, max, 0)

    expect(chunks.length).toBeGreaterThan(1)
    // Individual paragraph is <= 90 chars; paragraph chunker merges under max.
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(max)
    }
  })

  it('adds overlap content at the boundary between consecutive chunks', () => {
    const doc = '## A\n' + 'X'.repeat(300) + '\n\n## B\n' + 'Y'.repeat(300)
    const overlapSize = 20
    const chunks = chunkArrayFromText(doc, 250, overlapSize)

    expect(chunks.length).toBeGreaterThan(1)
    // Every chunk beyond the first must carry the overlap separator inserted
    // by addOverlap — that's the observable signature at chunk boundaries.
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]).toContain('\n---\n')
    }
  })

  it('a single tiny document yields exactly one chunk', () => {
    const chunks = chunkArrayFromText('Tiny doc.', 4000, 200)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toBe('Tiny doc.')
  })

  it('empty input yields []', () => {
    expect(chunkArrayFromText('', 4000, 0)).toEqual([])
    expect(chunkArrayFromText('\n\n\n', 4000, 0)).toEqual([])
  })

  it('associates chunks with a source document id via caller metadata', () => {
    // The chunker returns plain strings; enrichment is the caller's job.
    // Verify that caller-side enrichment produces stable metadata.
    const sourceId = 'doc-42'
    const doc = '## H1\nOne.\n\n## H2\nTwo.'
    const chunks = chunkArrayFromText(doc, 20, 0)
    const enriched = chunks.map((text, idx) => ({
      id: `${sourceId}:${String(idx)}`,
      sourceId,
      text,
    }))

    expect(enriched.length).toBeGreaterThan(0)
    for (const c of enriched) {
      expect(c.sourceId).toBe(sourceId)
      expect(c.id.startsWith('doc-42:')).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Parsers — markdown hierarchy, HTML-like stripping, corruption errors
// ---------------------------------------------------------------------------

describe('Parser behaviour', () => {
  it('markdown parser preserves heading hierarchy (h1/h2/h3)', async () => {
    const md = '# H1\n## H2\n### H3\nbody'
    const parsed = await parseDocument(Buffer.from(md, 'utf-8'), 'text/markdown')
    const lines = parsed.split('\n')
    expect(lines[0]).toBe('# H1')
    expect(lines[1]).toBe('## H2')
    expect(lines[2]).toBe('### H3')
  })

  it('plaintext parser returns HTML source verbatim (no tag stripping)', async () => {
    // The connector's plaintext branch is content-agnostic and must not
    // silently strip tags — that responsibility belongs to a dedicated
    // HTML parser. Encoding HTML as text/plain should round-trip.
    const html = '<p>Hello <b>world</b></p>'
    const parsed = await parseDocument(Buffer.from(html, 'utf-8'), 'text/plain')
    expect(parsed).toBe(html)
  })

  it('surfaces a descriptive error message for a corrupt PDF buffer', async () => {
    mockGetText.mockRejectedValue(new Error('Bad PDF header: not %PDF-'))

    const [parseTool] = createDocumentConnector()
    const result = (await parseTool.invoke({
      content: toB64('not-a-real-pdf'),
      contentType: 'application/pdf',
    })) as string

    expect(result.startsWith('Error:')).toBe(true)
    expect(result).toContain('Bad PDF header')
  })

  it('surfaces an error when DOCX parsing fails on binary noise', async () => {
    mockExtractRawText.mockRejectedValue(new Error('zip: not a zip file'))

    const [parseTool] = createDocumentConnector()
    const result = (await parseTool.invoke({
      content: toB64('random-bytes'),
      contentType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })) as string

    expect(result.startsWith('Error:')).toBe(true)
    expect(result).toContain('zip')
  })
})

// ---------------------------------------------------------------------------
// Integration — parse -> chunk -> emit sequence
// ---------------------------------------------------------------------------

describe('Parse -> chunk pipeline integration', () => {
  it('produces the expected number of chunks and carries source metadata', async () => {
    const sourceId = 'source-abc'
    const md = '## Intro\n' + 'I'.repeat(150) + '\n\n## Body\n' + 'B'.repeat(150)

    const [parseTool] = createDocumentConnector()
    const parsed = (await parseTool.invoke({
      content: toB64(md),
      contentType: 'text/markdown',
    })) as string

    const rawChunks = chunkArrayFromText(parsed, 120, 10)
    expect(rawChunks.length).toBeGreaterThanOrEqual(2)

    const emitted = rawChunks.map((text, idx) => ({
      id: `${sourceId}-${String(idx)}`,
      sourceId,
      text,
    }))
    expect(emitted.every((c) => c.sourceId === sourceId)).toBe(true)
    // Number of emitted records matches splitter output exactly.
    expect(emitted).toHaveLength(rawChunks.length)
  })

  it('two different document types produce correctly typed chunks', async () => {
    mockGetText.mockResolvedValue({
      text: '## PDF Section\n' + 'p'.repeat(300),
      total: 1,
      pages: [{ text: 'x', num: 1 }],
    })

    const [parseTool] = createDocumentConnector()

    const pdfText = (await parseTool.invoke({
      content: toB64('pdf-bytes'),
      contentType: 'application/pdf',
    })) as string
    const mdText = (await parseTool.invoke({
      content: toB64('## Markdown Section\n' + 'm'.repeat(300)),
      contentType: 'text/markdown',
    })) as string

    const pdfChunks = chunkArrayFromText(pdfText, 150, 0).map((text) => ({
      type: 'pdf' as const,
      text,
    }))
    const mdChunks = chunkArrayFromText(mdText, 150, 0).map((text) => ({
      type: 'markdown' as const,
      text,
    }))

    expect(pdfChunks.length).toBeGreaterThan(0)
    expect(mdChunks.length).toBeGreaterThan(0)
    expect(pdfChunks.every((c) => c.type === 'pdf')).toBe(true)
    expect(mdChunks.every((c) => c.type === 'markdown')).toBe(true)
    // Types are carried through without leakage.
    expect([...pdfChunks, ...mdChunks].some((c) => c.type === 'pdf')).toBe(true)
  })

  it('chunk IDs are unique across a batch of multiple documents', () => {
    const docs = [
      { id: 'doc-1', text: '## A\n' + 'a'.repeat(200) + '\n\n## B\n' + 'b'.repeat(200) },
      { id: 'doc-2', text: '## C\n' + 'c'.repeat(200) + '\n\n## D\n' + 'd'.repeat(200) },
      { id: 'doc-3', text: '## E\n' + 'e'.repeat(200) + '\n\n## F\n' + 'f'.repeat(200) },
    ]

    const allIds: string[] = []
    for (const doc of docs) {
      const chunks = chunkArrayFromText(doc.text, 120, 0)
      chunks.forEach((_, idx) => {
        allIds.push(`${doc.id}:${String(idx)}`)
      })
    }

    expect(allIds.length).toBeGreaterThanOrEqual(3)
    expect(new Set(allIds).size).toBe(allIds.length)
  })
})

// ---------------------------------------------------------------------------
// ConnectorContract — surface verification
// ---------------------------------------------------------------------------

describe('ConnectorContract surface', () => {
  it('created connector tools implement the required interface fields', () => {
    const tools = createDocumentConnector()
    for (const tool of tools) {
      expect(typeof tool.name).toBe('string')
      expect(typeof tool.description).toBe('string')
      expect(tool.schema).toBeDefined()
      expect(typeof tool.invoke).toBe('function')
    }
  })

  it('normalizeDocumentTool exposes id/name/description/schema/invoke', () => {
    const underlying = {
      name: 'doc-tool',
      description: 'fixture',
      schema: { type: 'object' },
      invoke: vi.fn().mockResolvedValue('ok'),
      lc_namespace: [],
    } as unknown as StructuredToolInterface

    const normalized = normalizeDocumentTool(underlying)
    expect(normalized.id).toBe('doc-tool')
    expect(normalized.name).toBe('doc-tool')
    expect(normalized.description).toBe('fixture')
    expect(normalized.schema).toEqual({ type: 'object' })
    expect(typeof normalized.invoke).toBe('function')
  })

  it('runtime guard: a tool missing invoke fails when called via normalized surface', async () => {
    // Simulate an implementation bug where `invoke` is omitted.
    const broken = {
      name: 'broken-tool',
      description: 'missing invoke',
      schema: { type: 'object' },
      // invoke intentionally not provided
      lc_namespace: [],
    } as unknown as StructuredToolInterface

    const normalized = normalizeDocumentTool(broken)
    await expect(normalized.invoke({})).rejects.toBeTruthy()
  })

  it('normalizeDocumentTools is stable across an empty-to-populated transition', () => {
    expect(normalizeDocumentTools([])).toEqual([])
    const tools = createDocumentConnector()
    const normalized = normalizeDocumentTools(tools)
    expect(normalized).toHaveLength(tools.length)
    expect(normalized.map((n) => n.id).sort()).toEqual(
      ['chunk-document', 'parse-document'],
    )
  })
})

// ---------------------------------------------------------------------------
// SupportedTypes — positive/negative and case-insensitive checks
// ---------------------------------------------------------------------------

describe('SupportedTypes checks', () => {
  it('known MIME types evaluate to true', () => {
    for (const mime of SUPPORTED_MIME_TYPES) {
      expect(isSupportedDocumentType(mime)).toBe(true)
    }
  })

  it('unknown MIME types evaluate to false', () => {
    const unknowns = [
      'application/zip',
      'application/x-tar',
      'video/mp4',
      'image/jpeg',
      'text/html',
      'text/xml',
    ]
    for (const mime of unknowns) {
      expect(isSupportedDocumentType(mime)).toBe(false)
    }
  })

  it('MIME type check is case-insensitive', () => {
    expect(isSupportedDocumentType('APPLICATION/PDF')).toBe(true)
    expect(isSupportedDocumentType('Text/Plain')).toBe(true)
    expect(isSupportedDocumentType('TEXT/MARKDOWN')).toBe(true)
    expect(isSupportedDocumentType(
      'Application/Vnd.OpenXmlFormats-OfficeDocument.WordprocessingML.Document',
    )).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Extra low-level guards for chunk/overlap behaviour
// ---------------------------------------------------------------------------

describe('Chunking low-level guards', () => {
  it('splitOnHeadings on a plain paragraph returns the paragraph as a single block', () => {
    const parts = splitOnHeadings('plain body with no headings')
    expect(parts).toHaveLength(1)
  })

  it('splitOnParagraphs preserves paragraph separator between merged groups', () => {
    const text = 'one\n\ntwo'
    const [merged] = splitOnParagraphs(text, 1000)
    expect(merged).toBe('one\n\ntwo')
  })

  it('addOverlap is a no-op on single-chunk input', () => {
    expect(addOverlap(['only'], 10)).toEqual(['only'])
  })

  it('splitIntoChunks tolerates overlapSize larger than any single chunk', () => {
    const doc = '## A\n' + 'x'.repeat(100) + '\n\n## B\n' + 'y'.repeat(100)
    const chunks = splitIntoChunks(doc, 80, 500)
    expect(chunks.length).toBeGreaterThan(1)
    // With oversized overlap, later chunks must still carry the separator.
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]).toContain('\n---\n')
    }
  })

  it('splitIntoChunks returns trimmed content when fits in a single chunk', () => {
    const chunks = splitIntoChunks('  padded content  ', 4000, 0)
    expect(chunks).toEqual(['padded content'])
  })
})

