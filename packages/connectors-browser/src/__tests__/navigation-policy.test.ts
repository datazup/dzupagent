import { describe, expect, it } from 'vitest'
import { validateBrowserNavigationUrl } from '../browser/navigation-policy.js'

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
