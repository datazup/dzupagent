import { parsePDF } from './parsers/pdf-parser.js'
import { parseDOCX } from './parsers/docx-parser.js'

/**
 * Parse a document buffer into plain text.
 * Supports: PDF, DOCX, Markdown, plain text.
 *
 * @throws Error if the MIME type is unsupported or parsing fails
 */
export async function parseDocument(
  buffer: Buffer,
  contentType: string,
): Promise<string> {
  const normalizedType = contentType.split(';')[0]?.trim().toLowerCase() ?? ''

  switch (normalizedType) {
    case 'application/pdf':
      return parsePDF(buffer)

    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return parseDOCX(buffer)

    case 'text/markdown':
    case 'text/plain':
      return buffer.toString('utf-8')

    default:
      throw new Error(`Unsupported document type: ${contentType}`)
  }
}
