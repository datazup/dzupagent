import { describe, it, expect } from 'vitest'
import { normalizeUrl, isSameOrigin, matchesPattern, isHashRoute } from '../crawler/url-utils.js'

describe('isHashRoute', () => {
  it('returns true for #/ hash routes', () => {
    expect(isHashRoute('https://example.com/#/dashboard')).toBe(true)
  })

  it('returns true for #!/ hash routes', () => {
    expect(isHashRoute('https://example.com/#!/settings')).toBe(true)
  })

  it('returns false for plain anchors', () => {
    expect(isHashRoute('https://example.com/page#section')).toBe(false)
  })

  it('returns false for URLs without hash', () => {
    expect(isHashRoute('https://example.com/page')).toBe(false)
  })

  it('returns false for invalid URLs', () => {
    expect(isHashRoute('not a url')).toBe(false)
  })

  it('returns false for empty hash', () => {
    expect(isHashRoute('https://example.com/#')).toBe(false)
  })
})

describe('normalizeUrl', () => {
  const base = 'https://example.com/start'

  it('resolves relative URLs against the base', () => {
    expect(normalizeUrl('/docs', base)).toBe('https://example.com/docs')
  })

  it('strips plain hash anchors from regular URLs', () => {
    expect(normalizeUrl('/docs#section', base)).toBe('https://example.com/docs')
  })

  it('preserves hash routes (#/)', () => {
    expect(normalizeUrl('/#/dashboard', base)).toBe('https://example.com/#/dashboard')
  })

  it('preserves hash routes (#!/)', () => {
    expect(normalizeUrl('/#!/settings', base)).toBe('https://example.com/#!/settings')
  })

  it('strips trailing slashes except for root', () => {
    expect(normalizeUrl('/docs/', base)).toBe('https://example.com/docs')
  })

  it('keeps trailing slash on root path', () => {
    expect(normalizeUrl('/', base)).toBe('https://example.com/')
  })

  it('returns null for truly unparseable input', () => {
    // URL constructor is lenient — use a scheme that will actually fail
    expect(normalizeUrl('', '')).toBeNull()
  })

  it('preserves query parameters', () => {
    expect(normalizeUrl('/search?q=test', base)).toBe('https://example.com/search?q=test')
  })

  it('handles absolute URLs', () => {
    expect(normalizeUrl('https://example.com/about', base)).toBe('https://example.com/about')
  })
})

describe('isSameOrigin', () => {
  it('returns true for same origin', () => {
    expect(isSameOrigin('https://example.com/a', 'https://example.com/b')).toBe(true)
  })

  it('returns false for different hosts', () => {
    expect(isSameOrigin('https://evil.com/a', 'https://example.com/b')).toBe(false)
  })

  it('returns false for different protocols', () => {
    expect(isSameOrigin('http://example.com/a', 'https://example.com/b')).toBe(false)
  })

  it('returns false for different ports', () => {
    expect(isSameOrigin('https://example.com:8080/a', 'https://example.com/b')).toBe(false)
  })

  it('returns false for invalid URLs', () => {
    expect(isSameOrigin('not-a-url', 'https://example.com')).toBe(false)
  })

  it('returns false when both are invalid', () => {
    expect(isSameOrigin('bad', 'also-bad')).toBe(false)
  })
})

describe('matchesPattern', () => {
  it('matches a wildcard glob pattern', () => {
    expect(matchesPattern('https://example.com/docs/ref', ['https://example.com/docs/*'])).toBe(true)
  })

  it('rejects non-matching URLs', () => {
    expect(matchesPattern('https://example.com/about', ['https://example.com/docs/*'])).toBe(false)
  })

  it('supports ? single-char wildcard', () => {
    expect(matchesPattern('https://example.com/a1', ['https://example.com/a?'])).toBe(true)
    expect(matchesPattern('https://example.com/ab', ['https://example.com/a?'])).toBe(true)
    expect(matchesPattern('https://example.com/abc', ['https://example.com/a?'])).toBe(false)
  })

  it('returns true if any pattern matches', () => {
    expect(matchesPattern('https://example.com/help/faq', [
      'https://example.com/docs/*',
      'https://example.com/help/*',
    ])).toBe(true)
  })

  it('returns false for empty patterns array', () => {
    expect(matchesPattern('https://example.com/page', [])).toBe(false)
  })
})
