import { describe, expect, it } from 'vitest'
import {
  createDocumentConnector,
  normalizeDocumentTools,
  isSupportedDocumentType,
  parseDocument,
  splitIntoChunks,
} from '../index.js'

describe('document connector integration', () => {
  it('parses and chunks documents through the public connector tools', async () => {
    const [parseTool, chunkTool] = createDocumentConnector({
      maxChunkSize: 40,
      overlap: 0,
    })
    const normalized = normalizeDocumentTools([parseTool, chunkTool])

    expect(parseTool.name).toBe('parse-document')
    expect(chunkTool.name).toBe('chunk-document')
    expect(normalized.map((tool) => tool.id)).toEqual(['parse-document', 'chunk-document'])
    expect(typeof normalized[0]!.invoke).toBe('function')

    const plainText = 'Hello connector integration'
    const parsed = await parseTool.invoke({
      content: Buffer.from(plainText, 'utf-8').toString('base64'),
      contentType: 'text/plain; charset=utf-8',
    })
    expect(parsed).toBe(plainText)

    const chunked = await chunkTool.invoke({
      text: '## Intro\nAlpha beta gamma.\n\n## Next\nDelta epsilon zeta.',
      maxChunkSize: 30,
      overlap: 0,
    })

    expect(chunked).toMatch(/^\d+ chunks created$/)
  })

  it('rejects unsupported content types and keeps MIME normalization consistent', async () => {
    expect(isSupportedDocumentType('text/plain; charset=utf-8')).toBe(true)
    expect(isSupportedDocumentType('application/octet-stream')).toBe(false)

    const [parseTool] = createDocumentConnector()
    const result = await parseTool.invoke({
      content: Buffer.from('hello', 'utf-8').toString('base64'),
      contentType: 'application/octet-stream',
    })

    expect(result).toContain('Unsupported document type')
  })

  it('matches the direct parser and chunker public helpers', async () => {
    const parsed = await parseDocument(
      Buffer.from('# Title\n\nParagraph one.', 'utf-8'),
      'text/markdown; charset=utf-8',
    )
    expect(parsed).toContain('# Title')

    const chunks = splitIntoChunks(
      '# Title\n\nParagraph one.\n\nParagraph two.',
      20,
      0,
    )

    expect(chunks).toEqual(expect.arrayContaining(['# Title']))
    expect(chunks.length).toBeGreaterThan(1)
  })
})
