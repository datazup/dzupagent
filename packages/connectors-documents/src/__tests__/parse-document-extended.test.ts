import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock pdf-parse and mammoth
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

const { parseDocument } = await import('../parse-document.js')

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
})

describe('parseDocument extended', () => {
  it('parses text/plain content type', async () => {
    const buffer = Buffer.from('Hello plain text')
    const result = await parseDocument(buffer, 'text/plain')
    expect(result).toBe('Hello plain text')
  })

  it('parses text/markdown content type', async () => {
    const buffer = Buffer.from('# Title\n\nBody paragraph')
    const result = await parseDocument(buffer, 'text/markdown')
    expect(result).toBe('# Title\n\nBody paragraph')
  })

  it('normalizes content type with charset parameter', async () => {
    const buffer = Buffer.from('Test content')
    const result = await parseDocument(buffer, 'text/plain; charset=utf-8')
    expect(result).toBe('Test content')
  })

  it('normalizes content type case', async () => {
    const buffer = Buffer.from('Case test')
    // parseDocument normalizes to lowercase
    const result = await parseDocument(buffer, 'TEXT/PLAIN')
    expect(result).toBe('Case test')
  })

  it('delegates PDF to parsePDF', async () => {
    mockGetText.mockResolvedValue({
      text: 'PDF text content',
      total: 1,
      pages: [{ text: 'PDF text content', num: 1 }],
    })

    const buffer = Buffer.from('fake-pdf-data')
    const result = await parseDocument(buffer, 'application/pdf')
    expect(result).toBe('PDF text content')
    expect(mockGetText).toHaveBeenCalled()
  })

  it('delegates DOCX to parseDOCX', async () => {
    mockExtractRawText.mockResolvedValue({ value: 'DOCX text content' })

    const buffer = Buffer.from('fake-docx-data')
    const result = await parseDocument(
      buffer,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
    expect(result).toBe('DOCX text content')
    expect(mockExtractRawText).toHaveBeenCalledWith({ buffer })
  })

  it('throws for unsupported content type', async () => {
    const buffer = Buffer.from('data')
    await expect(parseDocument(buffer, 'application/json')).rejects.toThrow(
      'Unsupported document type: application/json',
    )
  })

  it('throws for image content types', async () => {
    const buffer = Buffer.from('data')
    await expect(parseDocument(buffer, 'image/png')).rejects.toThrow('Unsupported document type')
  })

  it('throws for audio content types', async () => {
    const buffer = Buffer.from('data')
    await expect(parseDocument(buffer, 'audio/mpeg')).rejects.toThrow('Unsupported document type')
  })

  it('throws for empty content type', async () => {
    const buffer = Buffer.from('data')
    await expect(parseDocument(buffer, '')).rejects.toThrow('Unsupported document type')
  })

  it('propagates PDF parser errors', async () => {
    mockGetText.mockRejectedValue(new Error('PDF is encrypted'))

    const buffer = Buffer.from('encrypted-pdf')
    await expect(parseDocument(buffer, 'application/pdf')).rejects.toThrow('PDF is encrypted')
  })

  it('propagates DOCX parser errors', async () => {
    mockExtractRawText.mockRejectedValue(new Error('DOCX zip is corrupted'))

    const buffer = Buffer.from('corrupt-docx')
    await expect(
      parseDocument(
        buffer,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    ).rejects.toThrow('DOCX zip is corrupted')
  })

  it('handles UTF-8 encoded text', async () => {
    const unicodeText = 'Hello 世界 مرحبا 🌍'
    const buffer = Buffer.from(unicodeText, 'utf-8')
    const result = await parseDocument(buffer, 'text/plain')
    expect(result).toBe(unicodeText)
  })

  it('handles empty plain text buffer', async () => {
    const buffer = Buffer.from('', 'utf-8')
    const result = await parseDocument(buffer, 'text/plain')
    expect(result).toBe('')
  })

  it('handles content type with extra whitespace', async () => {
    const buffer = Buffer.from('spaced')
    const result = await parseDocument(buffer, '  text/plain  ; charset=utf-8')
    expect(result).toBe('spaced')
  })
})
