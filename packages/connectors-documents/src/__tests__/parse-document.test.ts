import { describe, it, expect } from 'vitest'
import { parseDocument } from '../parse-document.js'
import { isSupportedDocumentType } from '../supported-types.js'

describe('parseDocument', () => {
  it('accepts text/plain with charset parameter', async () => {
    const buffer = Buffer.from('hello plain text', 'utf-8')
    const parsed = await parseDocument(buffer, 'text/plain; charset=utf-8')
    expect(parsed).toBe('hello plain text')
  })

  it('accepts text/markdown with charset parameter', async () => {
    const buffer = Buffer.from('# Title', 'utf-8')
    const parsed = await parseDocument(buffer, 'text/markdown; charset=utf-8')
    expect(parsed).toBe('# Title')
  })
})

describe('isSupportedDocumentType', () => {
  it('normalizes MIME parameters', () => {
    expect(isSupportedDocumentType('text/plain; charset=utf-8')).toBe(true)
    expect(isSupportedDocumentType('text/markdown; charset=utf-8')).toBe(true)
  })
})
