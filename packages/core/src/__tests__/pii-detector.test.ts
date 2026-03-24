import { describe, it, expect } from 'vitest'
import { detectPII, redactPII } from '../security/pii-detector.js'

describe('detectPII', () => {
  it('detects email addresses', () => {
    const result = detectPII('Contact me at john.doe@example.com for details.')
    expect(result.hasPII).toBe(true)
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]?.type).toBe('email')
    expect(result.matches[0]?.value).toBe('john.doe@example.com')
    expect(result.redacted).toContain('[REDACTED:email]')
    expect(result.redacted).not.toContain('john.doe@example.com')
  })

  it('detects US phone numbers', () => {
    const result = detectPII('Call me at (555) 123-4567.')
    expect(result.hasPII).toBe(true)
    expect(result.matches.some((m) => m.type === 'phone')).toBe(true)
    expect(result.redacted).toContain('[REDACTED:phone]')
  })

  it('detects international phone numbers', () => {
    const result = detectPII('Phone: +1-555-123-4567')
    expect(result.hasPII).toBe(true)
    expect(result.matches.some((m) => m.type === 'phone')).toBe(true)
  })

  it('detects phone numbers without separators', () => {
    const result = detectPII('Dial 5551234567 now')
    expect(result.hasPII).toBe(true)
    expect(result.matches.some((m) => m.type === 'phone')).toBe(true)
  })

  it('detects SSNs', () => {
    const result = detectPII('SSN: 123-45-6789')
    expect(result.hasPII).toBe(true)
    expect(result.matches.some((m) => m.type === 'ssn')).toBe(true)
    expect(result.redacted).toContain('[REDACTED:ssn]')
    expect(result.redacted).not.toContain('123-45-6789')
  })

  it('detects credit card numbers', () => {
    const result = detectPII('Card: 4111 1111 1111 1111')
    expect(result.hasPII).toBe(true)
    expect(result.matches.some((m) => m.type === 'credit-card')).toBe(true)
    expect(result.redacted).toContain('[REDACTED:credit-card]')
  })

  it('detects credit card numbers with dashes', () => {
    const result = detectPII('Card: 4111-1111-1111-1111')
    expect(result.hasPII).toBe(true)
    expect(result.matches.some((m) => m.type === 'credit-card')).toBe(true)
  })

  it('detects IP addresses', () => {
    const result = detectPII('Server at 192.168.1.100 is down.')
    expect(result.hasPII).toBe(true)
    expect(result.matches.some((m) => m.type === 'ip-address')).toBe(true)
    expect(result.redacted).toContain('[REDACTED:ip-address]')
  })

  it('does not flag invalid IP octets (>255)', () => {
    const result = detectPII('Value 999.999.999.999 is not an IP.')
    const ipMatches = result.matches.filter((m) => m.type === 'ip-address')
    expect(ipMatches).toHaveLength(0)
  })

  it('returns clean result for safe content', () => {
    const result = detectPII('The quick brown fox jumps over the lazy dog.')
    expect(result.hasPII).toBe(false)
    expect(result.matches).toHaveLength(0)
    expect(result.redacted).toBe('The quick brown fox jumps over the lazy dog.')
  })

  it('handles multiple PII types in one string', () => {
    const content = 'Email: alice@test.com, SSN: 111-22-3333, IP: 10.0.0.1'
    const result = detectPII(content)
    expect(result.hasPII).toBe(true)
    expect(result.matches.length).toBeGreaterThanOrEqual(3)
    expect(result.redacted).not.toContain('alice@test.com')
    expect(result.redacted).not.toContain('111-22-3333')
    expect(result.redacted).not.toContain('10.0.0.1')
  })

  it('records start and end positions correctly', () => {
    const content = 'Hi alice@test.com bye'
    const result = detectPII(content)
    const match = result.matches[0]
    expect(match).toBeDefined()
    expect(content.slice(match!.start, match!.end)).toBe('alice@test.com')
  })

  it('handles empty string', () => {
    const result = detectPII('')
    expect(result.hasPII).toBe(false)
    expect(result.matches).toHaveLength(0)
    expect(result.redacted).toBe('')
  })
})

describe('redactPII', () => {
  it('returns redacted text directly', () => {
    const redacted = redactPII('Email me at bob@example.com')
    expect(redacted).not.toContain('bob@example.com')
    expect(redacted).toContain('[REDACTED:email]')
  })

  it('passes through clean content unchanged', () => {
    const clean = 'Just some normal text here.'
    expect(redactPII(clean)).toBe(clean)
  })
})
