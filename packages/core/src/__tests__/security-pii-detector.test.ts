import { describe, it, expect } from 'vitest'
import { detectPII, redactPII } from '../security/pii-detector.js'
import type { PIIType } from '../security/pii-detector.js'

describe('PII Detector — extended coverage', () => {
  // -----------------------------------------------------------------------
  // Email edge cases
  // -----------------------------------------------------------------------

  describe('email detection', () => {
    it('detects emails with subdomains', () => {
      const r = detectPII('reach me at user@mail.example.co.uk')
      expect(r.hasPII).toBe(true)
      expect(r.matches[0]?.type).toBe('email')
    })

    it('detects emails with plus addressing', () => {
      const r = detectPII('send to user+tag@gmail.com please')
      expect(r.hasPII).toBe(true)
      expect(r.matches[0]?.type).toBe('email')
      expect(r.matches[0]?.value).toBe('user+tag@gmail.com')
    })

    it('detects emails with percent in local part', () => {
      const r = detectPII('user%name@domain.com')
      expect(r.hasPII).toBe(true)
      expect(r.matches[0]?.type).toBe('email')
    })

    it('detects multiple emails', () => {
      const r = detectPII('CC: a@b.com and c@d.org for info')
      expect(r.hasPII).toBe(true)
      const emails = r.matches.filter((m) => m.type === 'email')
      expect(emails).toHaveLength(2)
    })

    it('does not flag @ in non-email context (e.g. Twitter handle without TLD)', () => {
      // @handle has no dot-TLD, so the regex should not match
      const r = detectPII('Follow @username on social media')
      const emails = r.matches.filter((m) => m.type === 'email')
      expect(emails).toHaveLength(0)
    })
  })

  // -----------------------------------------------------------------------
  // SSN edge cases
  // -----------------------------------------------------------------------

  describe('SSN detection', () => {
    it('detects SSN at start of string', () => {
      const r = detectPII('123-45-6789 is the SSN')
      expect(r.matches.some((m) => m.type === 'ssn')).toBe(true)
    })

    it('detects SSN at end of string', () => {
      const r = detectPII('SSN is 987-65-4321')
      expect(r.matches.some((m) => m.type === 'ssn')).toBe(true)
    })

    it('does not flag numbers without dashes as SSN', () => {
      const r = detectPII('Number 123456789 is not an SSN format')
      const ssns = r.matches.filter((m) => m.type === 'ssn')
      expect(ssns).toHaveLength(0)
    })

    it('does not flag partial SSN-like patterns (e.g. 12-34-5678)', () => {
      const r = detectPII('Date: 12-34-5678')
      const ssns = r.matches.filter((m) => m.type === 'ssn')
      expect(ssns).toHaveLength(0)
    })
  })

  // -----------------------------------------------------------------------
  // Credit card edge cases
  // -----------------------------------------------------------------------

  describe('credit card detection', () => {
    it('detects credit cards without separators', () => {
      const r = detectPII('Card number: 4111111111111111')
      expect(r.hasPII).toBe(true)
      expect(r.matches.some((m) => m.type === 'credit-card')).toBe(true)
    })

    it('detects credit cards with mixed separators (spaces)', () => {
      const r = detectPII('Pay with 5500 0000 0000 0004')
      expect(r.matches.some((m) => m.type === 'credit-card')).toBe(true)
    })

    it('does not flag 12-digit numbers as credit cards', () => {
      const r = detectPII('Ref: 123456789012')
      const cards = r.matches.filter((m) => m.type === 'credit-card')
      expect(cards).toHaveLength(0)
    })
  })

  // -----------------------------------------------------------------------
  // Phone number edge cases
  // -----------------------------------------------------------------------

  describe('phone number detection', () => {
    it('detects phone with dots as separator', () => {
      const r = detectPII('Call 555.123.4567')
      expect(r.matches.some((m) => m.type === 'phone')).toBe(true)
    })

    it('detects phone with country code and spaces', () => {
      const r = detectPII('Number: +44 555 123 4567')
      expect(r.matches.some((m) => m.type === 'phone')).toBe(true)
    })

    it('does not flag version numbers as phone (e.g. 1.2.3.4567)', () => {
      // The negative lookbehind (?<![.\d]) should help prevent this
      const r = detectPII('Version 1.2.3.4567 released')
      const phones = r.matches.filter((m) => m.type === 'phone')
      expect(phones).toHaveLength(0)
    })
  })

  // -----------------------------------------------------------------------
  // IP address edge cases
  // -----------------------------------------------------------------------

  describe('IP address detection', () => {
    it('detects 0.0.0.0', () => {
      const r = detectPII('Bind to 0.0.0.0')
      expect(r.matches.some((m) => m.type === 'ip-address')).toBe(true)
    })

    it('detects 255.255.255.255', () => {
      const r = detectPII('Broadcast: 255.255.255.255')
      expect(r.matches.some((m) => m.type === 'ip-address')).toBe(true)
    })

    it('detects 127.0.0.1 (localhost)', () => {
      const r = detectPII('Connect to 127.0.0.1:8080')
      expect(r.matches.some((m) => m.type === 'ip-address')).toBe(true)
      expect(r.matches.find((m) => m.type === 'ip-address')?.value).toBe('127.0.0.1')
    })

    it('rejects 256.0.0.1 (octet out of range)', () => {
      const r = detectPII('Address 256.0.0.1')
      const ips = r.matches.filter((m) => m.type === 'ip-address')
      expect(ips).toHaveLength(0)
    })

    it('rejects 1.2.3.999 (last octet out of range)', () => {
      const r = detectPII('IP: 1.2.3.999')
      const ips = r.matches.filter((m) => m.type === 'ip-address')
      expect(ips).toHaveLength(0)
    })
  })

  // -----------------------------------------------------------------------
  // Overlap handling
  // -----------------------------------------------------------------------

  describe('overlap and priority handling', () => {
    it('SSN takes priority over phone when patterns overlap (123-45-6789)', () => {
      // SSN pattern is checked before phone
      const r = detectPII('Number: 123-45-6789')
      const ssns = r.matches.filter((m) => m.type === 'ssn')
      expect(ssns).toHaveLength(1)
      // The SSN region should prevent a duplicate phone match for the same digits
      const phones = r.matches.filter(
        (m) => m.type === 'phone' && m.value.includes('123-45-6789'),
      )
      expect(phones).toHaveLength(0)
    })
  })

  // -----------------------------------------------------------------------
  // Redaction correctness
  // -----------------------------------------------------------------------

  describe('redaction correctness', () => {
    it('preserves surrounding text', () => {
      const r = detectPII('Hello alice@test.com world')
      expect(r.redacted).toBe('Hello [REDACTED:email] world')
    })

    it('redacts multiple items preserving order', () => {
      const text = 'Email: a@b.com SSN: 111-22-3333'
      const r = detectPII(text)
      expect(r.redacted).toContain('[REDACTED:email]')
      expect(r.redacted).toContain('[REDACTED:ssn]')
      // Order preserved: email before SSN
      const emailIdx = r.redacted.indexOf('[REDACTED:email]')
      const ssnIdx = r.redacted.indexOf('[REDACTED:ssn]')
      expect(emailIdx).toBeLessThan(ssnIdx)
    })

    it('redactPII returns same result as detectPII.redacted', () => {
      const text = 'Call 555-123-4567 or email test@example.com'
      const fromDetect = detectPII(text).redacted
      const fromRedact = redactPII(text)
      expect(fromRedact).toBe(fromDetect)
    })
  })

  // -----------------------------------------------------------------------
  // Repeated calls (regex lastIndex reset)
  // -----------------------------------------------------------------------

  describe('repeated calls', () => {
    it('gives consistent results across multiple calls', () => {
      const text = 'Email: foo@bar.com'
      const r1 = detectPII(text)
      const r2 = detectPII(text)
      expect(r1.matches).toEqual(r2.matches)
      expect(r1.redacted).toBe(r2.redacted)
    })

    it('gives consistent results when alternating different inputs', () => {
      const r1 = detectPII('foo@bar.com')
      const r2 = detectPII('no pii here')
      const r3 = detectPII('foo@bar.com')
      expect(r1.matches).toEqual(r3.matches)
      expect(r2.hasPII).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // Negative cases — strings that look similar but aren't PII
  // -----------------------------------------------------------------------

  describe('negative cases', () => {
    it('does not flag simple numbers', () => {
      const r = detectPII('The answer is 42.')
      expect(r.hasPII).toBe(false)
    })

    it('does not flag date-like strings (2026-01-15)', () => {
      const r = detectPII('Date: 2026-01-15')
      // This should not match SSN (only 2 digits in middle)
      const ssns = r.matches.filter((m) => m.type === 'ssn')
      expect(ssns).toHaveLength(0)
    })

    it('does not flag markdown text', () => {
      const r = detectPII('# Heading\n\nSome **bold** text and `code`.')
      expect(r.hasPII).toBe(false)
    })

    it('does not flag URLs as email', () => {
      const r = detectPII('Visit https://example.com/path?q=1')
      const emails = r.matches.filter((m) => m.type === 'email')
      expect(emails).toHaveLength(0)
    })
  })

  // -----------------------------------------------------------------------
  // Position tracking
  // -----------------------------------------------------------------------

  describe('position tracking', () => {
    it('tracks start/end correctly for mid-string match', () => {
      const text = 'prefix 192.168.0.1 suffix'
      const r = detectPII(text)
      const ip = r.matches.find((m) => m.type === 'ip-address')
      expect(ip).toBeDefined()
      expect(text.slice(ip!.start, ip!.end)).toBe('192.168.0.1')
    })

    it('tracks positions for multiple matches', () => {
      const text = 'a@b.com and c@d.org'
      const r = detectPII(text)
      for (const m of r.matches) {
        expect(text.slice(m.start, m.end)).toBe(m.value)
      }
    })
  })
})
