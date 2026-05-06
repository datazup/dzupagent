import { describe, it, expect } from 'vitest'
import { PiiDetector } from '../pii/detector.js'

describe('PiiDetector — scan', () => {
  const det = new PiiDetector()

  it('detects SSN', () => {
    const r = det.scan('My SSN is 123-45-6789.')
    expect(r.hasPii).toBe(true)
    expect(r.types).toContain('SSN')
  })

  it('detects email, phone, and IP address patterns used by core', () => {
    const r = det.scan('Email a@test.com, phone (555) 123-4567, IP 10.0.0.1')
    expect(r.types).toContain('EMAIL')
    expect(r.types).toContain('PHONE')
    expect(r.types).toContain('IP_ADDRESS')
  })

  it('detects Visa credit card numbers', () => {
    const r = det.scan('Card: 4111111111111111')
    expect(r.hasPii).toBe(true)
    expect(r.types).toContain('CREDIT_CARD')
  })

  it('detects MasterCard credit card numbers', () => {
    const r = det.scan('My card: 5555555555554444 expires next year.')
    expect(r.types).toContain('CREDIT_CARD')
  })

  it('detects IBAN', () => {
    const r = det.scan('IBAN: DE89370400440532013000')
    expect(r.hasPii).toBe(true)
    expect(r.types).toContain('IBAN')
  })

  it('detects JWT-shaped tokens', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    const r = det.scan(`Authorization: Bearer ${jwt}`)
    expect(r.types).toContain('JWT')
  })

  it('detects generic API key tokens', () => {
    const r = det.scan('export sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ12345')
    expect(r.types).toContain('API_KEY_GENERIC')
  })

  it('returns no PII for clean text', () => {
    const r = det.scan('The capital of France is Paris.')
    expect(r.hasPii).toBe(false)
    expect(r.types).toEqual([])
  })

  it('returns empty result for empty input', () => {
    const r = det.scan('')
    expect(r.hasPii).toBe(false)
    expect(r.types).toEqual([])
  })
})

describe('PiiDetector — sanitize', () => {
  const det = new PiiDetector()

  it('redacts SSN with typed marker', () => {
    expect(det.sanitize('SSN: 123-45-6789')).toBe('SSN: [REDACTED-SSN]')
  })

  it('redacts core-compatible PII patterns with security markers', () => {
    const out = det.sanitize('Email a@test.com, phone (555) 123-4567, IP 10.0.0.1')
    expect(out).toContain('[REDACTED-EMAIL]')
    expect(out).toContain('[REDACTED-PHONE]')
    expect(out).toContain('[REDACTED-IP]')
    expect(out).not.toContain('a@test.com')
    expect(out).not.toContain('(555) 123-4567')
    expect(out).not.toContain('10.0.0.1')
  })

  it('exposes detailed match positions for compatibility adapters', () => {
    const input = 'Hi alice@test.com bye'
    const r = det.scanDetailed(input)
    const match = r.matches.find((item) => item.type === 'EMAIL')
    expect(match).toBeDefined()
    expect(input.slice(match!.start, match!.end)).toBe('alice@test.com')
    expect(match!.canonicalType).toBe('email')
  })

  it('redacts credit card with typed marker', () => {
    expect(det.sanitize('CC: 4111111111111111')).toBe('CC: [REDACTED-CC]')
  })

  it('redacts IBAN with typed marker', () => {
    expect(det.sanitize('IBAN: DE89370400440532013000')).toBe('IBAN: [REDACTED-IBAN]')
  })

  it('redacts JWT with typed marker', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    expect(det.sanitize(`token=${jwt}`)).toBe('token=[REDACTED-JWT]')
  })

  it('redacts generic API key with typed marker', () => {
    expect(det.sanitize('use sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ12345 here'))
      .toBe('use [REDACTED-API-KEY] here')
  })

  it('passes clean text through unchanged', () => {
    expect(det.sanitize('hello world')).toBe('hello world')
  })

  it('is idempotent on already-sanitized text', () => {
    const once = det.sanitize('SSN: 123-45-6789')
    const twice = det.sanitize(once)
    expect(twice).toBe(once)
  })

  it('handles multiple PII types in one input', () => {
    const r = det.sanitize('SSN 123-45-6789 and card 4111111111111111')
    expect(r).toContain('[REDACTED-SSN]')
    expect(r).toContain('[REDACTED-CC]')
  })
})
