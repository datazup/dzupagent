import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock pdf-parse before importing the parser
// ---------------------------------------------------------------------------

const mockGetText = vi.fn()

vi.mock('pdf-parse', () => ({
  PDFParse: vi.fn().mockImplementation(() => ({
    getText: mockGetText,
  })),
}))

// ---------------------------------------------------------------------------
// Mock mammoth before importing the parser
// ---------------------------------------------------------------------------

const mockExtractRawText = vi.fn()

vi.mock('mammoth', () => ({
  default: { extractRawText: mockExtractRawText },
  extractRawText: mockExtractRawText,
}))

// ---------------------------------------------------------------------------
// Import parsers AFTER mocks are set up
// ---------------------------------------------------------------------------

const { parsePDF } = await import('../parsers/pdf-parser.js')
const { parseDOCX } = await import('../parsers/docx-parser.js')

// ---------------------------------------------------------------------------
// parsePDF
// ---------------------------------------------------------------------------

describe('parsePDF', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns extracted text from a PDF buffer', async () => {
    mockGetText.mockResolvedValue({
      text: 'Hello from PDF',
      total: 1,
      pages: [{ text: 'Hello from PDF', num: 1 }],
    })

    const result = await parsePDF(Buffer.from('fake-pdf'))
    expect(result).toBe('Hello from PDF')
  })

  it('throws when PDF has no extractable text (empty string)', async () => {
    mockGetText.mockResolvedValue({
      text: '',
      total: 0,
      pages: [],
    })

    await expect(parsePDF(Buffer.from('fake-pdf'))).rejects.toThrow(
      'PDF contains no extractable text',
    )
  })

  it('throws when PDF text is whitespace only', async () => {
    mockGetText.mockResolvedValue({
      text: '   \n\t  ',
      total: 1,
      pages: [{ text: '   ', num: 1 }],
    })

    await expect(parsePDF(Buffer.from('fake-pdf'))).rejects.toThrow(
      'PDF contains no extractable text',
    )
  })

  it('throws when PDF text is null/undefined', async () => {
    mockGetText.mockResolvedValue({
      text: null,
      total: 0,
      pages: [],
    })

    await expect(parsePDF(Buffer.from('fake-pdf'))).rejects.toThrow()
  })

  it('propagates parser errors', async () => {
    mockGetText.mockRejectedValue(new Error('Corrupt PDF'))

    await expect(parsePDF(Buffer.from('bad-data'))).rejects.toThrow('Corrupt PDF')
  })

  it('passes the MAX_PDF_PAGES limit to getText', async () => {
    mockGetText.mockResolvedValue({
      text: 'page content',
      total: 1,
      pages: [{ text: 'page content', num: 1 }],
    })

    await parsePDF(Buffer.from('data'))
    expect(mockGetText).toHaveBeenCalledWith({ first: 50 })
  })
})

// ---------------------------------------------------------------------------
// parseDOCX
// ---------------------------------------------------------------------------

describe('parseDOCX', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns extracted text from a DOCX buffer', async () => {
    mockExtractRawText.mockResolvedValue({ value: 'Hello from DOCX' })

    const result = await parseDOCX(Buffer.from('fake-docx'))
    expect(result).toBe('Hello from DOCX')
  })

  it('throws when DOCX has no extractable text', async () => {
    mockExtractRawText.mockResolvedValue({ value: '' })

    await expect(parseDOCX(Buffer.from('fake-docx'))).rejects.toThrow(
      'DOCX contains no extractable text',
    )
  })

  it('throws when DOCX text is whitespace only', async () => {
    mockExtractRawText.mockResolvedValue({ value: '   \n  ' })

    await expect(parseDOCX(Buffer.from('fake-docx'))).rejects.toThrow(
      'DOCX contains no extractable text',
    )
  })

  it('throws when DOCX value is null/undefined', async () => {
    mockExtractRawText.mockResolvedValue({ value: null })

    await expect(parseDOCX(Buffer.from('fake-docx'))).rejects.toThrow()
  })

  it('propagates mammoth errors', async () => {
    mockExtractRawText.mockRejectedValue(new Error('Invalid DOCX format'))

    await expect(parseDOCX(Buffer.from('bad-data'))).rejects.toThrow('Invalid DOCX format')
  })

  it('passes buffer option to mammoth', async () => {
    mockExtractRawText.mockResolvedValue({ value: 'text' })

    const buf = Buffer.from('docx-content')
    await parseDOCX(buf)
    expect(mockExtractRawText).toHaveBeenCalledWith({ buffer: buf })
  })
})
