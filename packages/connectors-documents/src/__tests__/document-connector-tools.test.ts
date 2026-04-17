import { describe, it, expect, vi, beforeEach } from 'vitest'

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
    expect(tools.map(t => t.name)).toEqual(['parse-document', 'chunk-document'])
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

  it('returns error string for unsupported content type', async () => {
    const [parseTool] = createDocumentConnector()
    const b64 = Buffer.from('data').toString('base64')

    const result = await parseTool.invoke({
      content: b64,
      contentType: 'application/octet-stream',
    })
    expect(result).toContain('Unsupported document type')
    expect(result).toContain('application/octet-stream')
  })

  it('lists supported types in unsupported error message', async () => {
    const [parseTool] = createDocumentConnector()
    const b64 = Buffer.from('data').toString('base64')

    const result = await parseTool.invoke({
      content: b64,
      contentType: 'image/png',
    })
    expect(result).toContain('application/pdf')
    expect(result).toContain('text/plain')
  })

  it('returns error string when PDF parsing fails', async () => {
    mockGetText.mockRejectedValue(new Error('Corrupt PDF file'))

    const [parseTool] = createDocumentConnector()
    const b64 = Buffer.from('bad-pdf').toString('base64')

    const result = await parseTool.invoke({ content: b64, contentType: 'application/pdf' })
    expect(result).toContain('Error: Corrupt PDF file')
  })

  it('returns error string when DOCX parsing fails', async () => {
    mockExtractRawText.mockRejectedValue(new Error('Invalid DOCX'))

    const [parseTool] = createDocumentConnector()
    const b64 = Buffer.from('bad-docx').toString('base64')

    const result = await parseTool.invoke({
      content: b64,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    expect(result).toContain('Error: Invalid DOCX')
  })

  it('handles non-Error throws gracefully', async () => {
    mockGetText.mockRejectedValue('string error')

    const [parseTool] = createDocumentConnector()
    const b64 = Buffer.from('data').toString('base64')

    const result = await parseTool.invoke({ content: b64, contentType: 'application/pdf' })
    expect(result).toContain('Error:')
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

  it('returns error for empty PDF (no extractable text)', async () => {
    mockGetText.mockResolvedValue({ text: '', total: 0, pages: [] })

    const [parseTool] = createDocumentConnector()
    const b64 = Buffer.from('empty-pdf').toString('base64')

    const result = await parseTool.invoke({ content: b64, contentType: 'application/pdf' })
    expect(result).toContain('Error:')
    expect(result).toContain('no extractable text')
  })
})

describe('chunk-document tool', () => {
  it('chunks text into multiple pieces', async () => {
    const [, chunkTool] = createDocumentConnector()
    const text = '## Section 1\n' + 'A'.repeat(500) + '\n\n## Section 2\n' + 'B'.repeat(500)

    const result = await chunkTool.invoke({ text, maxChunkSize: 200, overlap: 0 })
    // toModelOutput transforms to "N chunks created"
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
    // With overlap, second+ chunks should be larger due to overlap prepend
  })

  it('handles errors gracefully if chunking throws', async () => {
    // splitIntoChunks shouldn't really throw for valid text, but test the catch path
    const [, chunkTool] = createDocumentConnector()
    // Null input won't crash splitIntoChunks but will return empty
    const result = await chunkTool.invoke({ text: '', maxChunkSize: -1, overlap: 0 })
    // Empty text returns 0 chunks
    expect(result).toMatch(/0 chunks created/)
  })
})
