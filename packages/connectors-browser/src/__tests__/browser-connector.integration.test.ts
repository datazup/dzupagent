import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createBrowserConnector,
  normalizeBrowserTools,
  extractLinks,
  isSameOrigin,
  matchesPattern,
  normalizeUrl,
} from '../index.js'

type MockAnchor = {
  getAttribute: (name: string) => string | null
}

function anchor(href: string): MockAnchor {
  return {
    getAttribute: (name: string) => (name === 'href' ? href : null),
  }
}

function dataLink(href: string): MockAnchor {
  return {
    getAttribute: (name: string) => {
      if (name === 'data-href') return href
      return null
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('browser connector integration', () => {
  it('normalizes and filters URLs using the public crawler helpers', () => {
    expect(normalizeUrl('/docs#section', 'https://example.com/start')).toBe(
      'https://example.com/docs',
    )
    expect(isSameOrigin(
      'https://example.com/docs',
      'https://example.com/start',
    )).toBe(true)
    expect(isSameOrigin(
      'https://evil.example.com/docs',
      'https://example.com/start',
    )).toBe(false)
    expect(matchesPattern('https://example.com/docs/reference', [
      'https://example.com/docs/*',
      'https://example.com/help/*',
    ])).toBe(true)
  })

  it('extracts and normalizes links from a mixed public page surface', async () => {
    const mockDocument = {
      querySelectorAll: (selector: string) => {
        switch (selector) {
          case 'a[href]':
            return [
              anchor('/docs'),
              anchor('/docs#section'),
              anchor('https://evil.example.com/outside'),
              anchor('mailto:help@example.com'),
              anchor('javascript:void(0)'),
            ]
          case 'a[href*="#/"], a[href*="#!/"]':
            return [
              anchor('/#!/dashboard'),
              anchor('/#/settings'),
            ]
          case 'a[href].router-link-active, a[href][class*="router-link"]':
            return [anchor('/account')]
          case 'nav a[href], [role="navigation"] a[href], aside a[href]':
            return [anchor('/profile')]
          case '[data-href], [data-to], [data-path]':
            return [dataLink('/preferences')]
          default:
            return []
        }
      },
      querySelector: () => null,
    }
    const mockWindow = {
      location: {
        origin: 'https://example.com',
        hash: '',
      },
    }

    vi.stubGlobal('document', mockDocument)
    vi.stubGlobal('window', mockWindow)

    const page = {
      url: () => 'https://example.com/start',
      evaluate: async <T>(fn: () => T | Promise<T>) => fn(),
    }

    const links = await extractLinks(page as never)

    expect(links).toEqual(expect.arrayContaining([
      'https://example.com/docs',
      'https://example.com/#!/dashboard',
      'https://example.com/#/settings',
      'https://example.com/account',
      'https://example.com/profile',
      'https://example.com/preferences',
    ]))
    expect(links).not.toContain('https://evil.example.com/outside')
    expect(links).not.toContain('mailto:help@example.com')
    expect(links).not.toContain('javascript:void(0)')
  })

  it('exposes the expected browser tool surface from the package entrypoint', () => {
    const tools = createBrowserConnector({
      headless: true,
      crawlOptions: { maxPages: 1, maxDepth: 0 },
    })
    const normalized = normalizeBrowserTools(tools)

    expect(tools.map((tool) => tool.name)).toEqual([
      'browser-crawl-site',
      'browser-capture-screenshot',
      'browser-extract-forms',
      'browser-extract-elements',
      'browser-extract-a11y-tree',
    ])
    expect(tools[0]!.description).toContain('Crawl a website')
    expect(normalized.map((tool) => tool.id)).toEqual(tools.map((tool) => tool.name))
    expect(normalized[0]!.schema).toBeDefined()
    expect(typeof normalized[0]!.invoke).toBe('function')
  })
})
