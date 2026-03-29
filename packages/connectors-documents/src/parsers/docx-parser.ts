import * as mammoth from 'mammoth'

/**
 * Parse a DOCX buffer into plain text.
 * Uses mammoth to extract text with heading structure preserved.
 *
 * @throws Error if the DOCX contains no extractable text
 */
export async function parseDOCX(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer })

  if (!result.value || result.value.trim().length === 0) {
    throw new Error('DOCX contains no extractable text.')
  }

  return result.value
}
