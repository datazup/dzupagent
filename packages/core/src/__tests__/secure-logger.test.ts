import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSecureLogger, logger as defaultLogger } from '../logging/secure-logger.js'

describe('SecureLogger', () => {
  describe('redaction', () => {
    it('redacts a raw GitHub API token in a string message', () => {
      const logger = createSecureLogger({ capture: true })
      const fakeToken = 'ghp_' + 'A'.repeat(40)
      logger.error(`auth failed with token=${fakeToken}`)
      expect(logger.captured).toHaveLength(1)
      const entry = logger.captured[0]!
      expect(entry.message).not.toContain(fakeToken)
      expect(entry.message).toContain('[REDACTED:github-token]')
      expect(entry.level).toBe('error')
    })

    it('redacts a postgres connection string', () => {
      const logger = createSecureLogger({ capture: true })
      logger.warn('db error: postgresql://admin:supersecret@db.example.com:5432/prod')
      expect(logger.captured[0]!.message).toContain('[REDACTED:connection-string]')
      expect(logger.captured[0]!.message).not.toContain('supersecret')
    })

    it('applies prefix and still redacts', () => {
      const logger = createSecureLogger({ capture: true, prefix: '[mcp]' })
      const fakeToken = 'ghp_' + 'B'.repeat(40)
      logger.error(`error using ${fakeToken}`)
      const msg = logger.captured[0]!.message
      expect(msg.startsWith('[mcp]')).toBe(true)
      expect(msg).not.toContain(fakeToken)
      expect(msg).toContain('[REDACTED:github-token]')
    })
  })

  describe('capture mode', () => {
    it('stores entries without printing to console', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
      try {
        const logger = createSecureLogger({ capture: true })
        logger.error('boom')
        logger.warn('careful')
        logger.info('hello')
        expect(logger.captured).toHaveLength(3)
        expect(logger.captured.map((e) => e.level)).toEqual(['error', 'warn', 'info'])
        expect(errorSpy).not.toHaveBeenCalled()
        expect(warnSpy).not.toHaveBeenCalled()
        expect(infoSpy).not.toHaveBeenCalled()
      } finally {
        errorSpy.mockRestore()
        warnSpy.mockRestore()
        infoSpy.mockRestore()
      }
    })

    it('records a numeric timestamp on each entry', () => {
      const logger = createSecureLogger({ capture: true })
      const before = Date.now()
      logger.info('tick')
      const after = Date.now()
      const ts = logger.captured[0]!.timestamp
      expect(ts).toBeGreaterThanOrEqual(before)
      expect(ts).toBeLessThanOrEqual(after)
    })
  })

  describe('structured logging', () => {
    it('serialises an object payload to JSON before printing', () => {
      const logger = createSecureLogger({ capture: true })
      logger.error({ event: 'mcp_error', code: 'EADDRINUSE', detail: 'port busy' })
      const msg = logger.captured[0]!.message
      expect(msg).toContain('"event":"mcp_error"')
      expect(msg).toContain('"code":"EADDRINUSE"')
      expect(msg).toContain('"detail":"port busy"')
    })

    it('serialises Error instances with name, message, and stack', () => {
      const logger = createSecureLogger({ capture: true })
      const err = new Error('something blew up')
      logger.error({ event: 'err', err })
      const msg = logger.captured[0]!.message
      expect(msg).toContain('"name":"Error"')
      expect(msg).toContain('"message":"something blew up"')
    })

    it('redacts secrets inside structured payloads', () => {
      const logger = createSecureLogger({ capture: true })
      const fakeToken = 'ghp_' + 'C'.repeat(40)
      logger.error({ event: 'auth_fail', token: fakeToken })
      const msg = logger.captured[0]!.message
      expect(msg).not.toContain(fakeToken)
      expect(msg).toContain('[REDACTED:github-token]')
    })

    it('does not throw on circular references', () => {
      const logger = createSecureLogger({ capture: true })
      const obj: Record<string, unknown> = { name: 'cycle' }
      obj['self'] = obj
      expect(() => logger.error(obj)).not.toThrow()
      expect(logger.captured).toHaveLength(1)
    })
  })

  describe('clearCaptured', () => {
    it('resets the captured array', () => {
      const logger = createSecureLogger({ capture: true })
      logger.info('one')
      logger.info('two')
      expect(logger.captured).toHaveLength(2)
      logger.clearCaptured()
      expect(logger.captured).toHaveLength(0)
      logger.info('three')
      expect(logger.captured).toHaveLength(1)
      expect(logger.captured[0]!.message).toBe('three')
    })

    it('is a no-op on a non-capturing logger', () => {
      const logger = createSecureLogger()
      expect(() => logger.clearCaptured()).not.toThrow()
      expect(logger.captured).toEqual([])
    })
  })

  describe('default singleton', () => {
    let errorSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(() => {
      errorSpy.mockRestore()
    })

    it('exposes a non-capturing logger that writes to console.error', () => {
      defaultLogger.error('plain message')
      expect(errorSpy).toHaveBeenCalledTimes(1)
      const arg = errorSpy.mock.calls[0]![0]
      expect(arg).toBe('plain message')
      expect(defaultLogger.captured).toEqual([])
    })

    it('redacts secrets when called via the singleton', () => {
      const fakeToken = 'ghp_' + 'D'.repeat(40)
      defaultLogger.error(`leak: ${fakeToken}`)
      const arg = errorSpy.mock.calls[0]![0]
      expect(typeof arg).toBe('string')
      expect(arg).not.toContain(fakeToken)
      expect(arg).toContain('[REDACTED:github-token]')
    })
  })
})
