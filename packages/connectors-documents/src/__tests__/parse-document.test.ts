import { describe, it, expect } from 'vitest'
import { parseDocument } from '../parse-document.js'
import { isSupportedDocumentType } from '../supported-types.js'
import {
  DEFAULT_MAX_DOCUMENT_BYTES,
  validateParseBoundary,
} from '../validation.js'

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

describe('validateParseBoundary', () => {
  it('rejects unsupported MIME type before parser execution', () => {
    const buffer = Buffer.from('text', 'utf-8')

    expect(() => {
      validateParseBoundary('application/octet-stream', buffer, DEFAULT_MAX_DOCUMENT_BYTES)
    }).toThrow('Unsupported document type')
  })

  it('rejects payloads larger than configured parser limit', () => {
    const buffer = Buffer.from('0123456789', 'utf-8')

    expect(() => {
      validateParseBoundary('text/plain', buffer, 9)
    }).toThrow('exceeds parser size limit')
  })

  it('accepts supported MIME and in-limit payloads', () => {
    const buffer = Buffer.from('small text', 'utf-8')

    expect(() => {
      validateParseBoundary('text/plain; charset=utf-8', buffer, DEFAULT_MAX_DOCUMENT_BYTES)
    }).not.toThrow()
  })

  it('can fail then succeed in sequence for changing limits (adversarial)', () => {
    const buffer = Buffer.from('0123456789', 'utf-8')

    expect(() => {
      validateParseBoundary('text/plain', buffer, 4)
    }).toThrow('exceeds parser size limit')

    expect(() => {
      validateParseBoundary('text/plain', buffer, 20)
    }).not.toThrow()
  })
})
