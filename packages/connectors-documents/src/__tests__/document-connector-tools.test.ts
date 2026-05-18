import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DEFAULT_MAX_DOCUMENT_BYTES, MAX_CHUNK_SIZE_LIMIT } from '../validation.js'

// ---------------------------------------------------------------------------
// Mock pdf-parse and mammoth before importing
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

const { createDocumentConnector } = await import('../document-connector.js')

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
})

describe('createDocumentConnector', () => {
  it('returns exactly 2 tools', () => {
    const tools = createDocumentConnector()
    expect(tools).toHaveLength(2)
  })

  it('tools have correct names', () => {
    const tools = createDocumentConnector()
    expect(tools.map((t) => t.name)).toEqual(['parse-document', 'chunk-document'])
  })

  it('tools have descriptions', () => {
    const tools = createDocumentConnector()
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(10)
    }
  })

  it('accepts custom config', () => {
    const tools = createDocumentConnector({ maxChunkSize: 2000, overlap: 100 })
    expect(tools).toHaveLength(2)
  })

  it('rejects invalid default chunk config at connector creation', () => {
    expect(() => createDocumentConnector({ maxChunkSize: 0, overlap: 0 })).toThrow(
      'maxChunkSize must be a positive finite integer',
    )
  })
})

describe('parse-document tool', () => {
  it('parses plain text from base64', async () => {
    const [parseTool] = createDocumentConnector()
    const text = 'Hello world from plain text'
    const b64 = Buffer.from(text, 'utf-8').toString('base64')

    const result = await parseTool.invoke({ content: b64, contentType: 'text/plain' })
    expect(result).toBe(text)
  })

  it('parses markdown from base64', async () => {
    const [parseTool] = createDocumentConnector()
    const md = '# Title\n\nSome content here.'
    const b64 = Buffer.from(md, 'utf-8').toString('base64')

    const result = await parseTool.invoke({ content: b64, contentType: 'text/markdown' })
    expect(result).toBe(md)
  })

  it('handles content type with charset parameter', async () => {
    const [parseTool] = createDocumentConnector()
    const text = 'charset test'
    const b64 = Buffer.from(text, 'utf-8').toString('base64')

    const result = await parseTool.invoke({
      content: b64,
      contentType: 'text/plain; charset=utf-8',
    })
    expect(result).toBe(text)
  })

  it('parses PDF content via pdf-parse', async () => {
    mockGetText.mockResolvedValue({
      text: 'PDF content extracted',
      total: 1,
      pages: [{ text: 'PDF content extracted', num: 1 }],
    })

    const [parseTool] = createDocumentConnector()
    const b64 = Buffer.from('fake-pdf').toString('base64')

    const result = await parseTool.invoke({ content: b64, contentType: 'application/pdf' })
    expect(result).toBe('PDF content extracted')
  })

  it('parses DOCX content via mammoth', async () => {
    mockExtractRawText.mockResolvedValue({ value: 'DOCX content extracted' })

    const [parseTool] = createDocumentConnector()
    const b64 = Buffer.from('fake-docx').toString('base64')

    const result = await parseTool.invoke({
      content: b64,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    expect(result).toBe('DOCX content extracted')
  })

  it('rejects unsupported content type', async () => {
    const [parseTool] = createDocumentConnector()
    const b64 = Buffer.from('data').toString('base64')

    await expect(
      parseTool.invoke({
        content: b64,
        contentType: 'application/octet-stream',
      }),
    ).rejects.toThrow('Unsupported document type')
  })

  it('lists supported types in unsupported error message', async () => {
    const [parseTool] = createDocumentConnector()
    const b64 = Buffer.from('data').toString('base64')

    await expect(
      parseTool.invoke({
        content: b64,
        contentType: 'image/png',
      }),
    ).rejects.toThrow('application/pdf')
  })

  it('rejects when payload exceeds parser size limit', async () => {
    const [parseTool] = createDocumentConnector({ maxDocumentBytes: 8 })
    const b64 = Buffer.from('this document is too large', 'utf-8').toString('base64')

    await expect(
      parseTool.invoke({
        content: b64,
        contentType: 'text/plain',
      }),
    ).rejects.toThrow('exceeds parser size limit')
  })

  it('rejects invalid parser limit config before parsing', async () => {
    const [parseTool] = createDocumentConnector({ maxDocumentBytes: 0 })
    const b64 = Buffer.from('small', 'utf-8').toString('base64')

    await expect(
      parseTool.invoke({
        content: b64,
        contentType: 'text/plain',
      }),
    ).rejects.toThrow('maxDocumentBytes must be a positive finite integer')
  })

  it('rejects when PDF parsing fails', async () => {
    mockGetText.mockRejectedValue(new Error('Corrupt PDF file'))

    const [parseTool] = createDocumentConnector()
    const b64 = Buffer.from('bad-pdf').toString('base64')

    await expect(
      parseTool.invoke({ content: b64, contentType: 'application/pdf' }),
    ).rejects.toThrow('Corrupt PDF file')
  })

  it('rejects when DOCX parsing fails', async () => {
    mockExtractRawText.mockRejectedValue(new Error('Invalid DOCX'))

    const [parseTool] = createDocumentConnector()
    const b64 = Buffer.from('bad-docx').toString('base64')

    await expect(
      parseTool.invoke({
        content: b64,
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    ).rejects.toThrow('Invalid DOCX')
  })

  it('normalizes non-Error parser throws', async () => {
    mockGetText.mockRejectedValue('string error')

    const [parseTool] = createDocumentConnector()
    const b64 = Buffer.from('data').toString('base64')

    await expect(
      parseTool.invoke({ content: b64, contentType: 'application/pdf' }),
    ).rejects.toThrow('string error')
  })

  it('truncates long output to MAX_OUTPUT_LENGTH', async () => {
    const [parseTool] = createDocumentConnector()
    const longText = 'A'.repeat(10000)
    const b64 = Buffer.from(longText, 'utf-8').toString('base64')

    const result = await parseTool.invoke({ content: b64, contentType: 'text/plain' })
    expect((result as string).length).toBeLessThan(10000)
    expect(result).toContain('...[truncated]')
  })

  it('does not truncate short output', async () => {
    const [parseTool] = createDocumentConnector()
    const shortText = 'Short text.'
    const b64 = Buffer.from(shortText, 'utf-8').toString('base64')

    const result = await parseTool.invoke({ content: b64, contentType: 'text/plain' })
    expect(result).toBe(shortText)
    expect(result).not.toContain('truncated')
  })

  it('rejects empty PDF (no extractable text)', async () => {
    mockGetText.mockResolvedValue({ text: '', total: 0, pages: [] })

    const [parseTool] = createDocumentConnector()
    const b64 = Buffer.from('empty-pdf').toString('base64')

    await expect(
      parseTool.invoke({ content: b64, contentType: 'application/pdf' }),
    ).rejects.toThrow('no extractable text')
  })

  it('emits parse telemetry for success and failure in order (adversarial)', async () => {
    const events: Array<{ success: boolean; durationMs: number; error?: Error }> = []
    const [parseTool] = createDocumentConnector({
      maxDocumentBytes: DEFAULT_MAX_DOCUMENT_BYTES,
      telemetryCallback: (event) => {
        if (event.operation === 'parse') {
          events.push({ success: event.success, durationMs: event.durationMs, error: event.error })
        }
      },
    })

    mockGetText.mockRejectedValueOnce(new Error('first failure'))
    mockGetText.mockResolvedValueOnce({
      text: 'later success',
      total: 1,
      pages: [{ text: 'later success', num: 1 }],
    })

    const b64 = Buffer.from('pdf-bytes').toString('base64')

    await expect(
      parseTool.invoke({ content: b64, contentType: 'application/pdf' }),
    ).rejects.toThrow('first failure')

    const second = await parseTool.invoke({ content: b64, contentType: 'application/pdf' })
    expect(second).toBe('later success')

    expect(events).toHaveLength(2)
    expect(events[0]?.success).toBe(false)
    expect(events[0]?.error).toBeInstanceOf(Error)
    expect(events[1]?.success).toBe(true)
    expect(events[1]?.error).toBeUndefined()
    expect(events[0]?.durationMs).toBeGreaterThanOrEqual(0)
    expect(events[1]?.durationMs).toBeGreaterThanOrEqual(0)
  })
})

describe('chunk-document tool', () => {
  it('chunks text into multiple pieces', async () => {
    const [, chunkTool] = createDocumentConnector()
    const text = '## Section 1\n' + 'A'.repeat(500) + '\n\n## Section 2\n' + 'B'.repeat(500)

    const result = await chunkTool.invoke({ text, maxChunkSize: 200, overlap: 0 })
    expect(result).toMatch(/^\d+ chunks created$/)
  })

  it('uses default config values when not specified in input', async () => {
    const [, chunkTool] = createDocumentConnector({ maxChunkSize: 50, overlap: 0 })
    const text = 'A'.repeat(200)

    const result = await chunkTool.invoke({ text })
    expect(result).toMatch(/^\d+ chunks created$/)
  })

  it('returns single chunk for short text', async () => {
    const [, chunkTool] = createDocumentConnector()
    const result = await chunkTool.invoke({ text: 'Short text.', maxChunkSize: 4000, overlap: 0 })
    expect(result).toBe('1 chunks created')
  })

  it('returns empty array representation for empty text', async () => {
    const [, chunkTool] = createDocumentConnector()
    const result = await chunkTool.invoke({ text: '', maxChunkSize: 4000, overlap: 0 })
    expect(result).toBe('0 chunks created')
  })

  it('handles whitespace-only text as empty', async () => {
    const [, chunkTool] = createDocumentConnector()
    const result = await chunkTool.invoke({ text: '   \n  ', maxChunkSize: 4000, overlap: 0 })
    expect(result).toBe('0 chunks created')
  })

  it('respects custom overlap in input', async () => {
    const [, chunkTool] = createDocumentConnector()
    const text = '## A\n' + 'X'.repeat(300) + '\n## B\n' + 'Y'.repeat(300)

    const result = await chunkTool.invoke({ text, maxChunkSize: 200, overlap: 50 })
    expect(result).toMatch(/^\d+ chunks created$/)
  })

  it.each([
    { label: 'negative', maxChunkSize: -10 },
    { label: 'zero', maxChunkSize: 0 },
    { label: 'too large', maxChunkSize: MAX_CHUNK_SIZE_LIMIT + 1 },
  ])('rejects invalid maxChunkSize: $label', async ({ maxChunkSize }) => {
    const [, chunkTool] = createDocumentConnector()

    await expect(
      chunkTool.invoke({ text: 'Hello world', maxChunkSize, overlap: 0 }),
    ).rejects.toThrow()
  })

  it('rejects NaN maxChunkSize before chunking starts', async () => {
    const [, chunkTool] = createDocumentConnector()

    await expect(
      chunkTool.invoke({ text: 'Hello world', maxChunkSize: Number.NaN, overlap: 0 }),
    ).rejects.toThrow()
  })

  it('rejects overlap equal to maxChunkSize', async () => {
    const [, chunkTool] = createDocumentConnector()

    await expect(
      chunkTool.invoke({ text: 'Hello world', maxChunkSize: 200, overlap: 200 }),
    ).rejects.toThrow('overlap must be less than maxChunkSize')
  })

  it('rejects overlap greater than maxChunkSize', async () => {
    const [, chunkTool] = createDocumentConnector()

    await expect(
      chunkTool.invoke({ text: 'Hello world', maxChunkSize: 200, overlap: 500 }),
    ).rejects.toThrow('overlap must be less than maxChunkSize')
  })

  it('emits chunk telemetry success then failure in order (adversarial)', async () => {
    const events: Array<{ success: boolean; durationMs: number; error?: Error }> = []
    const [, chunkTool] = createDocumentConnector({
      telemetryCallback: (event) => {
        if (event.operation === 'chunk') {
          events.push({ success: event.success, durationMs: event.durationMs, error: event.error })
        }
      },
    })

    const successResult = await chunkTool.invoke({
      text: '## A\n' + 'x'.repeat(600),
      maxChunkSize: 200,
      overlap: 0,
    })
    expect(successResult).toMatch(/^\d+ chunks created$/)

    await expect(
      chunkTool.invoke({ text: 'Hello world', maxChunkSize: 100, overlap: 100 }),
    ).rejects.toThrow('overlap must be less than maxChunkSize')

    expect(events).toHaveLength(2)
    expect(events[0]?.success).toBe(true)
    expect(events[0]?.error).toBeUndefined()
    expect(events[1]?.success).toBe(false)
    expect(events[1]?.error).toBeInstanceOf(Error)
    expect(events[0]?.durationMs).toBeGreaterThanOrEqual(0)
    expect(events[1]?.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('works without telemetry callback configured', async () => {
    const [, chunkTool] = createDocumentConnector({ maxChunkSize: 300, overlap: 0 })
    const result = await chunkTool.invoke({ text: 'A'.repeat(1200) })
    expect(result).toMatch(/^\d+ chunks created$/)
  })
})
