import { describe, it, expect, vi } from 'vitest'
import { fetchWithOutboundUrlPolicy } from '../security/outbound-url-policy.js'

describe('redirect isolation', () => {
  it.each([301, 302, 303, 307, 308])('strips credentials on cross-origin %i redirects and cancels their bodies', async status => {
    const cancel = vi.fn()
    const redirect = new Response(new ReadableStream({ cancel }), { status, headers: { location: 'https://example.net/next' } })
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(redirect).mockResolvedValueOnce(new Response('ok'))
    await fetchWithOutboundUrlPolicy('https://example.com/start', {
      method: 'POST', body: 'body', headers: { authorization: 'synthetic', cookie: 'synthetic', 'x-private-key': 'synthetic', 'content-type': 'text/plain' },
    }, { fetchImpl })
    const next = fetchImpl.mock.calls[1]?.[1]
    const headers = new Headers(next?.headers)
    expect(headers.has('authorization')).toBe(false)
    expect(headers.has('cookie')).toBe(false)
    expect(headers.has('x-private-key')).toBe(false)
    expect(cancel).toHaveBeenCalledOnce()
    if ([301, 302, 303].includes(status)) {
      expect(next?.method).toBe('GET')
      expect(next?.body).toBeUndefined()
      expect(headers.has('content-type')).toBe(false)
    } else expect(next?.body).toBe('body')
  })
  it('preserves same-origin credentials without changing caller headers', async () => {
    const headers = new Headers({ authorization: 'synthetic' })
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: '/next' } })).mockResolvedValueOnce(new Response('ok'))
    await fetchWithOutboundUrlPolicy('https://example.com/start', { headers }, { fetchImpl })
    expect(new Headers(fetchImpl.mock.calls[1]?.[1]?.headers).get('authorization')).toBe('synthetic')
    expect(headers.get('authorization')).toBe('synthetic')
  })
})
