import { describe, expect, it, vi, beforeEach } from 'vitest'
import { validateBrowserNavigationUrl, installBrowserNavigationPolicy } from '../browser/navigation-policy.js'

// ---------------------------------------------------------------------------
// vi.mock must be hoisted: mock node:dns/promises for ESM compatibility.
// We control mock behaviour via `mockLookupImpl` — tests set it before each run.
// ---------------------------------------------------------------------------

let mockLookupImpl: () => Promise<{ address: string; family: number }> = async () => ({
  address: '93.184.216.34',
  family: 4,
})

vi.mock('node:dns/promises', () => ({
  lookup: (_hostname: string) => mockLookupImpl(),
}))

// ---------------------------------------------------------------------------
// Minimal Playwright page mock for route interception tests
// ---------------------------------------------------------------------------

type RouteHandler = (route: MockRoute) => Promise<void>

interface MockRequest {
  url: () => string
}

interface MockRoute {
  request: () => MockRequest
  abort: (reason: string) => Promise<void>
  continue: () => Promise<void>
}

function makeMockPage() {
  let capturedHandler: RouteHandler | null = null

  const page = {
    route: vi.fn(async (_pattern: string, handler: RouteHandler) => {
      capturedHandler = handler
    }),
    // Helper to simulate a request through the installed route handler
    async simulateRequest(url: string): Promise<{ aborted: boolean; abortReason?: string }> {
      if (!capturedHandler) throw new Error('No route handler installed')
      let aborted = false
      let abortReason: string | undefined
      const route: MockRoute = {
        request: () => ({ url: () => url }),
        abort: vi.fn(async (reason: string) => {
          aborted = true
          abortReason = reason
        }),
        continue: vi.fn(async () => undefined),
      }
      await capturedHandler(route)
      return { aborted, abortReason }
    },
  }
  return page
}

// ---------------------------------------------------------------------------
// validateBrowserNavigationUrl
// ---------------------------------------------------------------------------

describe('validateBrowserNavigationUrl', () => {
  it.each([
    ['loopback', 'http://127.0.0.1/admin'],
    ['private IPv4', 'http://192.168.1.10/admin'],
    ['link-local', 'http://169.254.10.20/latest'],
    ['metadata hostname', 'http://metadata.google.internal/computeMetadata/v1'],
    ['localhost', 'http://localhost:3000'],
  ])('blocks %s navigation by default', (_label, url) => {
    expect(() => validateBrowserNavigationUrl(url)).toThrow(
      'private or local network host',
    )
  })

  it('blocks disallowed protocols by default', () => {
    expect(() => validateBrowserNavigationUrl('file:///etc/passwd')).toThrow(
      'disallowed protocol',
    )
  })

  it('allows private-network navigation only with explicit opt-in', () => {
    expect(() =>
      validateBrowserNavigationUrl('http://127.0.0.1/admin', {
        allowPrivateNetwork: true,
      }),
    ).not.toThrow()
  })

  it('allows public http and https URLs by default', () => {
    expect(validateBrowserNavigationUrl('https://example.com/path').href).toBe(
      'https://example.com/path',
    )
    expect(validateBrowserNavigationUrl('http://example.com/path').href).toBe(
      'http://example.com/path',
    )
  })
})

// ---------------------------------------------------------------------------
// installBrowserNavigationPolicy — subresource interception
// ---------------------------------------------------------------------------

describe('installBrowserNavigationPolicy — subresource interception', () => {
  beforeEach(() => {
    // Default: DNS resolves to a public IP (won't interfere with literal-IP tests)
    mockLookupImpl = async () => ({ address: '8.8.8.8', family: 4 })
  })

  it('blocks a fetch/XHR subresource request to a literal private IP', async () => {
    const page = makeMockPage()
    await installBrowserNavigationPolicy(page as never)
    const result = await page.simulateRequest('http://169.254.169.254/latest/meta-data')
    expect(result.aborted).toBe(true)
    expect(result.abortReason).toBe('blockedbyclient')
  })

  it('blocks a fetch subresource to loopback', async () => {
    const page = makeMockPage()
    await installBrowserNavigationPolicy(page as never)
    const result = await page.simulateRequest('http://127.0.0.1/internal')
    expect(result.aborted).toBe(true)
  })

  it('does not block a public subresource request', async () => {
    mockLookupImpl = async () => ({ address: '93.184.216.34', family: 4 })
    const page = makeMockPage()
    await installBrowserNavigationPolicy(page as never)
    const result = await page.simulateRequest('https://example.com/script.js')
    expect(result.aborted).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// installBrowserNavigationPolicy — DNS-resolved private IP check
// ---------------------------------------------------------------------------

describe('installBrowserNavigationPolicy — DNS resolution guard', () => {
  it('blocks a hostname that DNS resolves to a link-local address (169.254.x.x)', async () => {
    mockLookupImpl = async () => ({ address: '169.254.169.254', family: 4 })
    const page = makeMockPage()
    await installBrowserNavigationPolicy(page as never)
    const result = await page.simulateRequest('http://evil-host.example.com/metadata')
    expect(result.aborted).toBe(true)
    expect(result.abortReason).toBe('blockedbyclient')
  })

  it('blocks a hostname that DNS resolves to a private RFC-1918 address', async () => {
    mockLookupImpl = async () => ({ address: '10.0.0.1', family: 4 })
    const page = makeMockPage()
    await installBrowserNavigationPolicy(page as never)
    const result = await page.simulateRequest('http://internal.corp.example/api')
    expect(result.aborted).toBe(true)
  })

  it('allows a hostname that DNS resolves to a public IP', async () => {
    mockLookupImpl = async () => ({ address: '93.184.216.34', family: 4 })
    const page = makeMockPage()
    await installBrowserNavigationPolicy(page as never)
    const result = await page.simulateRequest('http://example.com/')
    expect(result.aborted).toBe(false)
  })

  it('allows through when DNS resolution fails (connection will fail naturally)', async () => {
    mockLookupImpl = async () => { throw new Error('ENOTFOUND') }
    const page = makeMockPage()
    await installBrowserNavigationPolicy(page as never)
    const result = await page.simulateRequest('http://nonexistent.example.com/')
    expect(result.aborted).toBe(false)
  })

  it('skips DNS check when allowPrivateNetwork is true', async () => {
    let dnsWasCalled = false
    mockLookupImpl = async () => { dnsWasCalled = true; return { address: '169.254.169.254', family: 4 } }
    const page = makeMockPage()
    await installBrowserNavigationPolicy(page as never, { allowPrivateNetwork: true })
    const result = await page.simulateRequest('http://some-host.example.com/')
    expect(result.aborted).toBe(false)
    expect(dnsWasCalled).toBe(false)
  })
})
