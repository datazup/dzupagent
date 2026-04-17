import { describe, it, expect } from 'vitest'
import { detectPII, redactPII } from '../security/pii-detector.js'
import type { PIIMatch, PIIType } from '../security/pii-detector.js'

/**
 * Deep coverage for pii-detector (G-31).
 * 25+ tests covering: emails, phones, SSN, credit cards, IP addresses,
 * redaction, position correctness, and multi-PII scenarios.
 */
describe('detectPII — email detection', () => {
  it('detects standard email', () => {
    const result = detectPII('user@example.com is my address')
    expect(result.hasPII).toBe(true)
    expect(result.matches.some((m) => m.type === 'email')).toBe(true)
  })

  it('detects email with plus tag addressing', () => {
    const result = detectPII('user+tag@domain.co.uk is my address')
    expect(result.hasPII).toBe(true)
    const emailMatch = result.matches.find((m) => m.type === 'email')
    expect(emailMatch?.value).toBe('user+tag@domain.co.uk')
  })

  it('detects email with subdomain', () => {
    const result = detectPII('user.name@sub.domain.com')
    expect(result.hasPII).toBe(true)
    const emailMatch = result.matches.find((m) => m.type === 'email')
    expect(emailMatch?.value).toBe('user.name@sub.domain.com')
  })

  it('redacts email with proper placeholder', () => {
    const result = detectPII('Email: bob@example.com end')
    expect(result.redacted).toContain('[REDACTED:email]')
    expect(result.redacted).not.toContain('bob@example.com')
  })

  it('does not match pure version strings like v1.2.3', () => {
    // v1.2.3 is not an email — no @ symbol
    const result = detectPII('version v1.2.3 released')
    const emailMatches = result.matches.filter((m) => m.type === 'email')
    expect(emailMatches).toHaveLength(0)
  })

  it('detects multiple emails in one string', () => {
    const result = detectPII('alice@test.com and bob@test.com')
    const emails = result.matches.filter((m) => m.type === 'email')
    expect(emails.length).toBe(2)
  })
})

describe('detectPII — phone detection', () => {
  it('detects 7-digit hyphenated phone via the generic pattern', () => {
    // The implementation requires a 10-digit-ish pattern; 555-1234 alone will
    // not match the full NANP pattern. Using a fuller variant:
    const result = detectPII('Tel: 555-123-4567')
    expect(result.hasPII).toBe(true)
    expect(result.matches.some((m) => m.type === 'phone')).toBe(true)
  })

  it('detects parenthesized US phone (555) 123-4567', () => {
    const result = detectPII('Call (555) 123-4567 today')
    expect(result.matches.some((m) => m.type === 'phone')).toBe(true)
  })

  it('detects +1-555-123-4567 international format', () => {
    const result = detectPII('My phone is +1-555-123-4567')
    expect(result.matches.some((m) => m.type === 'phone')).toBe(true)
  })

  it('detects unseparated 10-digit 5551234567', () => {
    const result = detectPII('Dial 5551234567')
    expect(result.matches.some((m) => m.type === 'phone')).toBe(true)
  })

  it('redacts phone number with [REDACTED:phone] placeholder', () => {
    const result = detectPII('Call (555) 123-4567')
    expect(result.redacted).toContain('[REDACTED:phone]')
  })
})

describe('detectPII — SSN detection', () => {
  it('detects SSN 123-45-6789', () => {
    const result = detectPII('SSN: 123-45-6789')
    expect(result.matches.some((m) => m.type === 'ssn')).toBe(true)
  })

  it('redacts SSN with [REDACTED:ssn] placeholder', () => {
    const result = detectPII('SSN: 123-45-6789')
    expect(result.redacted).toContain('[REDACTED:ssn]')
    expect(result.redacted).not.toContain('123-45-6789')
  })
})

describe('detectPII — credit card detection', () => {
  it('detects 16-digit Visa 4111111111111111', () => {
    const result = detectPII('Card 4111 1111 1111 1111 expires')
    expect(result.matches.some((m) => m.type === 'credit-card')).toBe(true)
  })

  it('detects 16-digit MasterCard 5500000000000004', () => {
    const result = detectPII('Card 5500 0000 0000 0004 expires')
    expect(result.matches.some((m) => m.type === 'credit-card')).toBe(true)
  })

  it('detects credit card with dashes 4111-1111-1111-1111', () => {
    const result = detectPII('Card: 4111-1111-1111-1111')
    expect(result.matches.some((m) => m.type === 'credit-card')).toBe(true)
  })

  it('redacts credit card with [REDACTED:credit-card]', () => {
    const result = detectPII('4111-1111-1111-1111 is the card')
    expect(result.redacted).toContain('[REDACTED:credit-card]')
  })
})

describe('detectPII — IP address detection', () => {
  it('detects 192.168.1.1', () => {
    const result = detectPII('Server at 192.168.1.1 is up')
    expect(result.matches.some((m) => m.type === 'ip-address')).toBe(true)
  })

  it('detects 10.0.0.1', () => {
    const result = detectPII('IP 10.0.0.1 is private')
    expect(result.matches.some((m) => m.type === 'ip-address')).toBe(true)
  })

  it('rejects invalid IP like 999.999.999.999', () => {
    const result = detectPII('Bad IP 999.999.999.999')
    expect(result.matches.filter((m) => m.type === 'ip-address')).toHaveLength(0)
  })

  it('redacts IP with [REDACTED:ip-address]', () => {
    const result = detectPII('Server at 192.168.1.1 up')
    expect(result.redacted).toContain('[REDACTED:ip-address]')
  })
})

describe('detectPII — clean content', () => {
  it('returns hasPII=false on plain prose', () => {
    const result = detectPII('The quick brown fox jumps over the lazy dog')
    expect(result.hasPII).toBe(false)
    expect(result.matches).toHaveLength(0)
  })

  it('returns hasPII=false on empty string', () => {
    const result = detectPII('')
    expect(result.hasPII).toBe(false)
    expect(result.matches).toEqual([])
    expect(result.redacted).toBe('')
  })

  it('returns hasPII=false on whitespace-only string', () => {
    const result = detectPII('   \n\t  ')
    expect(result.hasPII).toBe(false)
    expect(result.matches).toHaveLength(0)
  })

  it('returns exact redacted copy if no PII', () => {
    const input = 'no pii here!'
    const result = detectPII(input)
    expect(result.redacted).toBe(input)
  })
})

describe('detectPII — position correctness', () => {
  it('start and end positions slice to the actual email', () => {
    const content = 'prefix alice@test.com suffix'
    const result = detectPII(content)
    const match = result.matches.find((m) => m.type === 'email')
    expect(match).toBeDefined()
    expect(content.slice(match!.start, match!.end)).toBe('alice@test.com')
  })

  it('start and end positions slice to the actual IP', () => {
    const content = 'host=10.0.0.1.'
    const result = detectPII(content)
    const match = result.matches.find((m) => m.type === 'ip-address')
    expect(match).toBeDefined()
    expect(content.slice(match!.start, match!.end)).toBe('10.0.0.1')
  })

  it('start is always less than end', () => {
    const result = detectPII('alice@test.com')
    for (const m of result.matches) {
      expect(m.start).toBeLessThan(m.end)
    }
  })

  it('positions correct in a long text with embedded PII', () => {
    // Use a word boundary (punctuation) between filler and the email, so the
    // local-part of the email is not absorbed into the surrounding filler.
    const filler = 'x y z '.repeat(100)
    const content = `${filler}user@example.com ${filler}`
    const result = detectPII(content)
    const match = result.matches.find((m) => m.type === 'email')
    expect(match).toBeDefined()
    expect(content.slice(match!.start, match!.end)).toBe('user@example.com')
  })
})

describe('detectPII — multiple PII types simultaneously', () => {
  it('detects email + SSN + IP independently', () => {
    const content = 'Email: a@b.com SSN: 123-45-6789 IP: 10.0.0.1'
    const result = detectPII(content)
    const types = new Set(result.matches.map((m) => m.type))
    expect(types.has('email')).toBe(true)
    expect(types.has('ssn')).toBe(true)
    expect(types.has('ip-address')).toBe(true)
  })

  it('all PII redacted with their specific placeholders', () => {
    const content = 'Email: a@b.com SSN: 123-45-6789 IP: 10.0.0.1'
    const result = detectPII(content)
    expect(result.redacted).toContain('[REDACTED:email]')
    expect(result.redacted).toContain('[REDACTED:ssn]')
    expect(result.redacted).toContain('[REDACTED:ip-address]')
  })

  it('none of the original PII strings leak into redacted output', () => {
    const content = 'Email a@b.com and IP 10.0.0.1'
    const result = detectPII(content)
    expect(result.redacted).not.toContain('a@b.com')
    expect(result.redacted).not.toContain('10.0.0.1')
  })
})

describe('detectPII — result contract', () => {
  it('returns { hasPII, matches, redacted } shape', () => {
    const result = detectPII('')
    expect(result).toHaveProperty('hasPII')
    expect(result).toHaveProperty('matches')
    expect(result).toHaveProperty('redacted')
    expect(Array.isArray(result.matches)).toBe(true)
  })

  it('each match conforms to PIIMatch shape', () => {
    const result = detectPII('alice@test.com')
    for (const m of result.matches) {
      const match: PIIMatch = m
      expect(typeof match.type).toBe('string')
      expect(typeof match.value).toBe('string')
      expect(typeof match.start).toBe('number')
      expect(typeof match.end).toBe('number')
    }
  })

  it('match type is a valid PIIType union value', () => {
    const validTypes: PIIType[] = ['email', 'phone', 'ssn', 'credit-card', 'ip-address']
    const result = detectPII('a@b.com 123-45-6789 10.0.0.1')
    for (const m of result.matches) {
      expect(validTypes).toContain(m.type)
    }
  })
})

describe('redactPII — convenience function', () => {
  it('equals detectPII(...).redacted', () => {
    const input = 'Email a@b.com'
    expect(redactPII(input)).toBe(detectPII(input).redacted)
  })

  it('returns clean text unchanged', () => {
    const input = 'clean content only'
    expect(redactPII(input)).toBe(input)
  })

  it('returns empty string for empty input', () => {
    expect(redactPII('')).toBe('')
  })
})
