import { describe, it, expect } from 'vitest'
import { ForgeError } from '@dzupagent/core'

import { validateWebhookUrl } from '../utils/url-validator.js'

describe('validateWebhookUrl', () => {
  // -----------------------------------------------------------------------
  // Valid URLs
  // -----------------------------------------------------------------------

  it('allows valid HTTPS URLs', () => {
    expect(() => validateWebhookUrl('https://hooks.slack.com/services/T00/B00/xxx')).not.toThrow()
    expect(() => validateWebhookUrl('https://example.com/webhook')).not.toThrow()
  })

  it('allows HTTP when allowHttp is true', () => {
    expect(() =>
      validateWebhookUrl('http://hooks.example.com/webhook', { allowHttp: true }),
    ).not.toThrow()
  })

  // -----------------------------------------------------------------------
  // Protocol blocking
  // -----------------------------------------------------------------------

  it('blocks HTTP by default', () => {
    expect(() => validateWebhookUrl('http://hooks.example.com/webhook')).toThrow(ForgeError)
  })

  it('blocks non-HTTP(S) protocols', () => {
    expect(() => validateWebhookUrl('ftp://example.com/file')).toThrow(ForgeError)
    expect(() => validateWebhookUrl('file:///etc/passwd')).toThrow(ForgeError)
  })

  // -----------------------------------------------------------------------
  // Loopback / localhost
  // -----------------------------------------------------------------------

  it('blocks localhost', () => {
    expect(() => validateWebhookUrl('https://localhost/hook')).toThrow(ForgeError)
    expect(() => validateWebhookUrl('https://localhost.localdomain/hook')).toThrow(ForgeError)
  })

  it('blocks 127.0.0.1 and other 127.x.x.x addresses', () => {
    expect(() => validateWebhookUrl('https://127.0.0.1/hook')).toThrow(ForgeError)
    expect(() => validateWebhookUrl('https://127.0.0.2/hook')).toThrow(ForgeError)
    expect(() => validateWebhookUrl('https://127.255.255.255/hook')).toThrow(ForgeError)
  })

  // -----------------------------------------------------------------------
  // Private IP ranges
  // -----------------------------------------------------------------------

  it('blocks 10.x.x.x (class A private)', () => {
    expect(() => validateWebhookUrl('https://10.0.0.1/hook')).toThrow(ForgeError)
    expect(() => validateWebhookUrl('https://10.255.255.255/hook')).toThrow(ForgeError)
  })

  it('blocks 172.16-31.x.x (class B private)', () => {
    expect(() => validateWebhookUrl('https://172.16.0.1/hook')).toThrow(ForgeError)
    expect(() => validateWebhookUrl('https://172.31.255.255/hook')).toThrow(ForgeError)
    // 172.15.x.x and 172.32.x.x should NOT be blocked
    expect(() => validateWebhookUrl('https://172.15.0.1/hook')).not.toThrow()
    expect(() => validateWebhookUrl('https://172.32.0.1/hook')).not.toThrow()
  })

  it('blocks 192.168.x.x (class C private)', () => {
    expect(() => validateWebhookUrl('https://192.168.0.1/hook')).toThrow(ForgeError)
    expect(() => validateWebhookUrl('https://192.168.255.255/hook')).toThrow(ForgeError)
  })

  // -----------------------------------------------------------------------
  // Cloud metadata
  // -----------------------------------------------------------------------

  it('blocks 169.254.169.254 (cloud metadata endpoint)', () => {
    expect(() => validateWebhookUrl('https://169.254.169.254/latest/meta-data/')).toThrow(
      ForgeError,
    )
  })

  // -----------------------------------------------------------------------
  // Zero address
  // -----------------------------------------------------------------------

  it('blocks 0.0.0.0', () => {
    expect(() => validateWebhookUrl('https://0.0.0.0/hook')).toThrow(ForgeError)
  })

  // -----------------------------------------------------------------------
  // IPv6
  // -----------------------------------------------------------------------

  it('blocks ::1 (IPv6 loopback)', () => {
    expect(() => validateWebhookUrl('https://[::1]/hook')).toThrow(ForgeError)
  })

  it('blocks fd00::1 (IPv6 unique local)', () => {
    expect(() => validateWebhookUrl('https://[fd00::1]/hook')).toThrow(ForgeError)
  })

  // -----------------------------------------------------------------------
  // Malformed URLs
  // -----------------------------------------------------------------------

  it('throws on malformed URLs', () => {
    expect(() => validateWebhookUrl('not-a-url')).toThrow(ForgeError)
    expect(() => validateWebhookUrl('')).toThrow(ForgeError)
  })

  // -----------------------------------------------------------------------
  // Custom allowed/blocked hosts
  // -----------------------------------------------------------------------

  it('allows URLs in allowedHosts even if they would normally be blocked', () => {
    expect(() =>
      validateWebhookUrl('https://localhost/hook', { allowedHosts: ['localhost'] }),
    ).not.toThrow()

    expect(() =>
      validateWebhookUrl('https://127.0.0.1/hook', { allowedHosts: ['127.0.0.1'] }),
    ).not.toThrow()
  })

  it('blocks custom blockedHosts', () => {
    expect(() =>
      validateWebhookUrl('https://evil.internal.corp/hook', {
        blockedHosts: ['evil.internal.corp'],
      }),
    ).toThrow(ForgeError)
  })

  // -----------------------------------------------------------------------
  // Error shape
  // -----------------------------------------------------------------------

  it('throws ForgeError with VALIDATION_FAILED code', () => {
    try {
      validateWebhookUrl('https://127.0.0.1/hook')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(ForgeError.is(err)).toBe(true)
      expect((err as InstanceType<typeof ForgeError>).code).toBe('VALIDATION_FAILED')
    }
  })
})
