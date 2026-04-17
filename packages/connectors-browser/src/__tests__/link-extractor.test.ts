import { describe, it, expect, vi, afterEach } from 'vitest'
import { extractLinks } from '../crawler/link-extractor.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function anchor(href: string) {
  return { getAttribute: (name: string) => (name === 'href' ? href : null) }
}

function createMockPage(url: string) {
  return {
    url: () => url,
    evaluate: async <T>(fn: () => T | Promise<T>) => fn(),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('extractLinks', () => {
  it('filters out javascript: URIs', async () => {
    vi.stubGlobal('document', {
      querySelectorAll: (sel: string) =>
        sel === 'a[href]'
          ? [anchor('javascript:void(0)'), anchor('javascript:alert(1)')]
          : [],
      querySelector: () => null,
    })
    vi.stubGlobal('window', { location: { origin: 'https://example.com', hash: '' } })

    const links = await extractLinks(createMockPage('https://example.com') as never)
    expect(links).toEqual([])
  })

  it('filters out mailto: URIs', async () => {
    vi.stubGlobal('document', {
      querySelectorAll: (sel: string) =>
        sel === 'a[href]' ? [anchor('mailto:test@example.com')] : [],
      querySelector: () => null,
    })
    vi.stubGlobal('window', { location: { origin: 'https://example.com', hash: '' } })

    const links = await extractLinks(createMockPage('https://example.com') as never)
    expect(links).toEqual([])
  })

  it('filters out tel: URIs', async () => {
    vi.stubGlobal('document', {
      querySelectorAll: (sel: string) =>
        sel === 'a[href]' ? [anchor('tel:+1234567890')] : [],
      querySelector: () => null,
    })
    vi.stubGlobal('window', { location: { origin: 'https://example.com', hash: '' } })

    const links = await extractLinks(createMockPage('https://example.com') as never)
    expect(links).toEqual([])
  })

  it('filters out plain anchor links (#section)', async () => {
    vi.stubGlobal('document', {
      querySelectorAll: (sel: string) =>
        sel === 'a[href]' ? [anchor('#section'), anchor('#top')] : [],
      querySelector: () => null,
    })
    vi.stubGlobal('window', { location: { origin: 'https://example.com', hash: '' } })

    const links = await extractLinks(createMockPage('https://example.com') as never)
    expect(links).toEqual([])
  })

  it('keeps hash routes (#/ and #!/)', async () => {
    vi.stubGlobal('document', {
      querySelectorAll: (sel: string) => {
        if (sel === 'a[href]') return []
        if (sel.includes('#/')) return [anchor('/#/dashboard'), anchor('/#!/settings')]
        return []
      },
      querySelector: () => null,
    })
    vi.stubGlobal('window', { location: { origin: 'https://example.com', hash: '' } })

    const links = await extractLinks(createMockPage('https://example.com') as never)
    expect(links).toEqual(expect.arrayContaining([
      'https://example.com/#/dashboard',
      'https://example.com/#!/settings',
    ]))
  })

  it('filters out cross-origin links', async () => {
    vi.stubGlobal('document', {
      querySelectorAll: (sel: string) =>
        sel === 'a[href]'
          ? [anchor('https://evil.com/steal'), anchor('/local')]
          : [],
      querySelector: () => null,
    })
    vi.stubGlobal('window', { location: { origin: 'https://example.com', hash: '' } })

    const links = await extractLinks(createMockPage('https://example.com') as never)
    expect(links).toContain('https://example.com/local')
    expect(links).not.toContain('https://evil.com/steal')
  })

  it('deduplicates normalized URLs', async () => {
    vi.stubGlobal('document', {
      querySelectorAll: (sel: string) =>
        sel === 'a[href]'
          ? [anchor('/page'), anchor('/page'), anchor('/page/')]
          : [],
      querySelector: () => null,
    })
    vi.stubGlobal('window', { location: { origin: 'https://example.com', hash: '' } })

    const links = await extractLinks(createMockPage('https://example.com') as never)
    // All should normalize to the same URL
    expect(links).toHaveLength(1)
    expect(links[0]).toBe('https://example.com/page')
  })

  it('discovers data-href attributes', async () => {
    vi.stubGlobal('document', {
      querySelectorAll: (sel: string) => {
        if (sel.includes('data-href')) {
          return [{
            getAttribute: (name: string) => {
              if (name === 'data-href') return '/settings'
              return null
            },
          }]
        }
        return []
      },
      querySelector: () => null,
    })
    vi.stubGlobal('window', { location: { origin: 'https://example.com', hash: '' } })

    const links = await extractLinks(createMockPage('https://example.com') as never)
    expect(links).toContain('https://example.com/settings')
  })

  it('discovers nav links from navigation elements', async () => {
    vi.stubGlobal('document', {
      querySelectorAll: (sel: string) => {
        if (sel.includes('nav a[href]')) {
          return [anchor('/about'), anchor('/contact')]
        }
        return []
      },
      querySelector: () => null,
    })
    vi.stubGlobal('window', { location: { origin: 'https://example.com', hash: '' } })

    const links = await extractLinks(createMockPage('https://example.com') as never)
    expect(links).toEqual(expect.arrayContaining([
      'https://example.com/about',
      'https://example.com/contact',
    ]))
  })

  it('returns empty array when page has no links at all', async () => {
    vi.stubGlobal('document', {
      querySelectorAll: () => [],
      querySelector: () => null,
    })
    vi.stubGlobal('window', { location: { origin: 'https://example.com', hash: '' } })

    const links = await extractLinks(createMockPage('https://example.com') as never)
    expect(links).toEqual([])
  })
})
