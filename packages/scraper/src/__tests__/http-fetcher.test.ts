import { describe, it, expect, vi, afterEach } from 'vitest'
import { HttpFetcher } from '../http-fetcher.js'

function makeResponse(body: string, init?: { status?: number; headers?: Record<string, string> }): Response {
  return new Response(body, {
    status: init?.status ?? 200,
    headers: init?.headers ?? { 'content-type': 'text/html' },
  })
}

describe('HttpFetcher', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('honors extraction options passed to fetch', async () => {
    const html = `
      <html>
        <head><title>Title</title></head>
        <body><p>${'A'.repeat(100)}</p></body>
      </html>
    `
    vi.stubGlobal('fetch', vi.fn(async () => makeResponse(html)))

    const fetcher = new HttpFetcher({ respectRobotsTxt: false })
    const result = await fetcher.fetch('https://example.com', {
      extraction: { mode: 'text', cleanHtml: true, maxLength: 10 },
    })

    expect(result.title).toBe('Title')
    expect(result.text.length).toBe(10)
  })

  it('blocks fetch when robots.txt disallows path', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url)
      if (href.endsWith('/robots.txt')) {
        return makeResponse('User-agent: *\nDisallow: /private', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        })
      }
      return makeResponse('<html><body>ok</body></html>')
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: true, maxRetries: 0 })

    await expect(
      fetcher.fetch('https://example.com/private/page'),
    ).rejects.toThrow('robots.txt')
  })

  it('allows fetch when robots.txt permits the requested path', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url)
      if (href.endsWith('/robots.txt')) {
        return makeResponse('User-agent: *\nAllow: /public\nDisallow: /private', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        })
      }
      return makeResponse(
        '<html><head><title>Allowed</title></head><body>' + 'A'.repeat(120) + '</body></html>',
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const fetcher = new HttpFetcher({ respectRobotsTxt: true, maxRetries: 0 })
    const result = await fetcher.fetch('https://example.com/public/page')

    expect(result.status).toBe(200)
    expect(result.title).toBe('Allowed')
    expect(result.text.length).toBeGreaterThan(0)
  })
})
