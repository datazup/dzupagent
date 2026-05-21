import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  fetchWithOutboundUrlPolicy,
  isPublicIpAddress,
  validateOutboundUrl,
} from '../security/outbound-url-policy.js'

describe('outbound URL security policy', () => {
  it('allows public HTTPS destinations', async () => {
    const result = await validateOutboundUrl('https://example.com/path', {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    })

    expect(result.ok).toBe(true)
  })

  it('rejects non-HTTPS destinations by default', async () => {
    const result = await validateOutboundUrl('http://example.com/path', {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    })

    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.reason).toContain('https')
  })

  it('rejects localhost, private, link-local, metadata, and non-public literal IPs', async () => {
    const urls = [
      'https://localhost/hook',
      'https://127.0.0.1/hook',
      'https://10.0.0.1/hook',
      'https://172.16.0.1/hook',
      'https://192.168.1.10/hook',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/hook',
      'https://[fd00::1]/hook',
      'https://[fe80::1]/hook',
    ]

    for (const url of urls) {
      const result = await validateOutboundUrl(url)
      expect(result.ok, url).toBe(false)
    }
  })

  it('rejects hostnames that resolve to non-public addresses', async () => {
    const result = await validateOutboundUrl('https://internal.example.test/hook', {
      lookup: async () => [{ address: '10.1.2.3', family: 4 }],
    })

    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.reason).toContain('resolved to non-public IP')
  })

  it('allows explicit host and IP allowlist overrides for trusted deployments', async () => {
    await expect(validateOutboundUrl('http://localhost:8080/hook', {
      allowedHosts: ['localhost:8080'],
    })).resolves.toMatchObject({ ok: true })

    await expect(validateOutboundUrl('https://internal.example.test/hook', {
      allowedIpAddresses: ['10.1.2.3'],
      lookup: async () => [{ address: '10.1.2.3', family: 4 }],
    })).resolves.toMatchObject({ ok: true })
  })

  it('revalidates redirects before following them', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url) === 'https://example.com/start') {
        return new Response('', {
          status: 302,
          headers: { location: 'https://127.0.0.1/private' },
        })
      }
      return new Response('should-not-fetch', { status: 200 })
    })

    await expect(fetchWithOutboundUrlPolicy('https://example.com/start', {}, {
      fetchImpl: fetchMock as typeof fetch,
      policy: {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      },
    })).rejects.toThrow('Outbound URL rejected')

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('short-circuits before DNS lookup or fetch when the request is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const lookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }])
    const fetchMock = vi.fn(async () => new Response('should-not-fetch', { status: 200 }))

    await expect(fetchWithOutboundUrlPolicy('https://example.com/start', {
      signal: controller.signal,
    }, {
      fetchImpl: fetchMock as typeof fetch,
      policy: { lookup },
    })).rejects.toMatchObject({ name: 'AbortError' })

    expect(lookup).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('short-circuits before fetch when the request is aborted during URL validation', async () => {
    const controller = new AbortController()
    const lookup = vi.fn(async () => {
      controller.abort()
      return [{ address: '93.184.216.34', family: 4 }]
    })
    const fetchMock = vi.fn(async () => new Response('should-not-fetch', { status: 200 }))

    await expect(fetchWithOutboundUrlPolicy('https://public.example.test/start', {
      signal: controller.signal,
    }, {
      fetchImpl: fetchMock as typeof fetch,
      policy: { lookup },
    })).rejects.toMatchObject({ name: 'AbortError' })

    expect(lookup).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('classifies public and non-public IPs', () => {
    expect(isPublicIpAddress('93.184.216.34')).toBe(true)
    expect(isPublicIpAddress('127.0.0.1')).toBe(false)
    expect(isPublicIpAddress('169.254.169.254')).toBe(false)
    expect(isPublicIpAddress('::1')).toBe(false)
  })

  describe('DNS rebinding TOCTOU defense', () => {
    let server: Server
    let port: number
    let receivedHostHeaders: string[] = []

    beforeAll(async () => {
      server = createServer((req, res) => {
        receivedHostHeaders.push(req.headers.host ?? '')
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('ok')
      })
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve())
      })
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('Failed to bind test HTTP server')
      }
      port = address.port
    })

    afterAll(async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
    })

    it('pins the TCP connection to the validated IP and does not re-resolve DNS at connect', async () => {
      // Simulate a DNS-rebinding attacker: first lookup returns 127.0.0.1
      // (our trusted local server, allowlisted below). Any subsequent lookup
      // (which would happen without the pinned dispatcher) returns 8.8.8.8.
      // If the connection re-resolved DNS, we would never reach the local
      // server (or we would reach a different IP entirely).
      let lookupCount = 0
      const lookup = vi.fn(async () => {
        lookupCount += 1
        if (lookupCount === 1) {
          return [{ address: '127.0.0.1', family: 4 }]
        }
        return [{ address: '8.8.8.8', family: 4 }]
      })

      receivedHostHeaders = []

      const response = await fetchWithOutboundUrlPolicy(
        `http://trusted.example.test:${port}/probe`,
        {},
        {
          // Local test server is plaintext, so allow HTTP and allowlist the
          // validated IP. The hostname is still resolved via the mock lookup,
          // and the pinned dispatcher forwards the TCP connect to 127.0.0.1.
          policy: {
            lookup,
            allowHttp: true,
            allowedIpAddresses: ['127.0.0.1'],
          },
        },
      )

      expect(response).toBeDefined()
      // validateOutboundUrl must have been called exactly once — the dispatcher
      // does not trigger a fresh DNS resolution.
      expect(lookup).toHaveBeenCalledTimes(1)
      // The local server received the request, proving the TCP connection went
      // to the validated 127.0.0.1 (not 8.8.8.8 from the racing DNS swap).
      expect(receivedHostHeaders.length).toBeGreaterThan(0)
      expect(receivedHostHeaders[0]).toContain(`trusted.example.test:${port}`)
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('ok')
    })

    it('does not attach a pinned dispatcher when caller provides a custom fetchImpl', async () => {
      const seenInits: RequestInit[] = []
      const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
        seenInits.push(init ?? {})
        return new Response('mocked', { status: 200 })
      })

      const response = await fetchWithOutboundUrlPolicy(
        'https://example.com/path',
        {},
        {
          fetchImpl: fetchMock as typeof fetch,
          policy: {
            lookup: async () => [{ address: '93.184.216.34', family: 4 }],
          },
        },
      )

      expect(response.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      // The init passed to the caller-supplied fetch must NOT contain a
      // dispatcher field — the caller owns their own security posture.
      const init = seenInits[0] as Record<string, unknown>
      expect(init.dispatcher).toBeUndefined()
    })
  })
})
