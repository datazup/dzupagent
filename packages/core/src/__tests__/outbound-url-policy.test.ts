import { describe, expect, it, vi } from 'vitest'
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

  it('classifies public and non-public IPs', () => {
    expect(isPublicIpAddress('93.184.216.34')).toBe(true)
    expect(isPublicIpAddress('127.0.0.1')).toBe(false)
    expect(isPublicIpAddress('169.254.169.254')).toBe(false)
    expect(isPublicIpAddress('::1')).toBe(false)
  })
})
