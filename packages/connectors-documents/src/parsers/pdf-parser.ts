import { PDFParse } from 'pdf-parse'

/**
 * pdf-parse v2 result shape (no bundled types for v2).
 */
interface PDFTextResult {
  text: string
  total: number
  pages: Array<{ text: string; num: number }>
}

const MAX_PDF_PAGES = 50

/**
 * Parse a PDF buffer into plain text.
 *
 * @throws Error if the PDF contains no extractable text
 */
export async function parsePDF(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer })
  const result: PDFTextResult = await parser.getText({ first: MAX_PDF_PAGES })

  if (!result.text || result.text.trim().length === 0) {
    throw new Error('PDF contains no extractable text. It may be image-based or empty.')
  }

  return result.text
}
