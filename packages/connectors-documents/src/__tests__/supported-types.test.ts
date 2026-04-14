import { describe, it, expect } from 'vitest'
import { isSupportedDocumentType, SUPPORTED_MIME_TYPES } from '../supported-types.js'

describe('SUPPORTED_MIME_TYPES', () => {
  it('contains the expected set of types', () => {
    expect(SUPPORTED_MIME_TYPES.has('application/pdf')).toBe(true)
    expect(SUPPORTED_MIME_TYPES.has('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(true)
    expect(SUPPORTED_MIME_TYPES.has('text/markdown')).toBe(true)
    expect(SUPPORTED_MIME_TYPES.has('text/plain')).toBe(true)
  })

  it('has exactly 4 entries', () => {
    expect(SUPPORTED_MIME_TYPES.size).toBe(4)
  })
})

describe('isSupportedDocumentType', () => {
  it('returns true for application/pdf', () => {
    expect(isSupportedDocumentType('application/pdf')).toBe(true)
  })

  it('returns true for docx MIME type', () => {
    expect(isSupportedDocumentType(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )).toBe(true)
  })

  it('returns true for text/markdown', () => {
    expect(isSupportedDocumentType('text/markdown')).toBe(true)
  })

  it('returns true for text/plain', () => {
    expect(isSupportedDocumentType('text/plain')).toBe(true)
  })

  it('returns false for unsupported types', () => {
    expect(isSupportedDocumentType('application/octet-stream')).toBe(false)
    expect(isSupportedDocumentType('image/png')).toBe(false)
    expect(isSupportedDocumentType('application/json')).toBe(false)
    expect(isSupportedDocumentType('text/html')).toBe(false)
    expect(isSupportedDocumentType('text/csv')).toBe(false)
  })

  it('normalizes MIME type with charset parameter', () => {
    expect(isSupportedDocumentType('text/plain; charset=utf-8')).toBe(true)
    expect(isSupportedDocumentType('text/markdown; charset=utf-8')).toBe(true)
    expect(isSupportedDocumentType('application/pdf; charset=binary')).toBe(true)
  })

  it('normalizes case differences', () => {
    expect(isSupportedDocumentType('TEXT/PLAIN')).toBe(true)
    expect(isSupportedDocumentType('Application/PDF')).toBe(true)
    expect(isSupportedDocumentType('Text/Markdown')).toBe(true)
  })

  it('normalizes whitespace around MIME type', () => {
    expect(isSupportedDocumentType('  text/plain  ')).toBe(true)
    expect(isSupportedDocumentType(' application/pdf ; charset=utf-8')).toBe(true)
  })

  it('returns false for empty string', () => {
    expect(isSupportedDocumentType('')).toBe(false)
  })

  it('returns false for partial matches', () => {
    expect(isSupportedDocumentType('text')).toBe(false)
    expect(isSupportedDocumentType('application')).toBe(false)
    expect(isSupportedDocumentType('pdf')).toBe(false)
  })
})
