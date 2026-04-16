import { describe, it, expect, beforeEach } from 'vitest'
import { MockSandboxV2 } from '../sandbox/mock-sandbox-v2.js'
import type { ExecEvent } from '../sandbox/sandbox-protocol-v2.js'

describe('MockSandboxV2', () => {
  let sandbox: MockSandboxV2

  beforeEach(() => {
    sandbox = new MockSandboxV2()
  })

  // -------------------------------------------------------------------------
  // startSession
  // -------------------------------------------------------------------------

  describe('startSession', () => {
    it('returns sequential session IDs starting at 1', async () => {
      const first = await sandbox.startSession()
      const second = await sandbox.startSession()
      const third = await sandbox.startSession()

      expect(first.sessionId).toBe('session-1')
      expect(second.sessionId).toBe('session-2')
      expect(third.sessionId).toBe('session-3')
    })

    it('records each call with options', async () => {
      await sandbox.startSession({ envVars: { NODE_ENV: 'test' }, timeoutMs: 5000 })
      await sandbox.startSession()

      expect(sandbox.sessionCalls).toHaveLength(2)
      expect(sandbox.sessionCalls[0]!.options).toEqual({
        envVars: { NODE_ENV: 'test' },
        timeoutMs: 5000,
      })
      expect(sandbox.sessionCalls[1]!.options).toBeUndefined()
    })

    it('records calls with no options', async () => {
      await sandbox.startSession()
      expect(sandbox.sessionCalls).toHaveLength(1)
      expect(sandbox.sessionCalls[0]!.options).toBeUndefined()
    })

    it('tracks session as active', async () => {
      const { sessionId } = await sandbox.startSession()
      expect(sandbox.getActiveSessions()).toContain(sessionId)
    })
  })

  // -------------------------------------------------------------------------
  // failNextSession
  // -------------------------------------------------------------------------

  describe('failNextSession', () => {
    it('causes next startSession to throw', async () => {
      sandbox.failNextSession(new Error('Docker unavailable'))

      await expect(sandbox.startSession()).rejects.toThrow('Docker unavailable')
    })

    it('only affects the next call — subsequent calls succeed', async () => {
      sandbox.failNextSession(new Error('boom'))

      await expect(sandbox.startSession()).rejects.toThrow('boom')

      const result = await sandbox.startSession()
      expect(result.sessionId).toBe('session-1')
    })

    it('still records the failed call', async () => {
      sandbox.failNextSession(new Error('fail'))

      try {
        await sandbox.startSession({ timeoutMs: 1000 })
      } catch {
        // expected
      }

      expect(sandbox.sessionCalls).toHaveLength(1)
      expect(sandbox.sessionCalls[0]!.options).toEqual({ timeoutMs: 1000 })
    })
  })

  // -------------------------------------------------------------------------
  // executeStream
  // -------------------------------------------------------------------------

  describe('executeStream', () => {
    it('yields configured events for matching string command', async () => {
      const events: ExecEvent[] = [
        { type: 'stdout', data: 'hello\n' },
        { type: 'exit', exitCode: 0, timedOut: false },
      ]
      sandbox.configureStream('npm test', events)

      const { sessionId } = await sandbox.startSession()
      const collected: ExecEvent[] = []
      for await (const event of sandbox.executeStream(sessionId, 'npm test')) {
        collected.push(event)
      }

      expect(collected).toEqual(events)
    })

    it('yields configured events for regex command pattern', async () => {
      const events: ExecEvent[] = [
        { type: 'stderr', data: 'warning\n' },
        { type: 'exit', exitCode: 1, timedOut: false },
      ]
      sandbox.configureStream(/^npm\s+/, events)

      const { sessionId } = await sandbox.startSession()
      const collected: ExecEvent[] = []
      for await (const event of sandbox.executeStream(sessionId, 'npm run build')) {
        collected.push(event)
      }

      expect(collected).toEqual(events)
    })

    it('returns default exit event when no pattern matches', async () => {
      const { sessionId } = await sandbox.startSession()
      const collected: ExecEvent[] = []
      for await (const event of sandbox.executeStream(sessionId, 'unknown-cmd')) {
        collected.push(event)
      }

      expect(collected).toEqual([{ type: 'exit', exitCode: 0, timedOut: false }])
    })

    it('uses first matching pattern when multiple match', async () => {
      sandbox.configureStream('npm', [
        { type: 'stdout', data: 'first' },
        { type: 'exit', exitCode: 0, timedOut: false },
      ])
      sandbox.configureStream(/npm/, [
        { type: 'stdout', data: 'second' },
        { type: 'exit', exitCode: 0, timedOut: false },
      ])

      const { sessionId } = await sandbox.startSession()
      const collected: ExecEvent[] = []
      for await (const event of sandbox.executeStream(sessionId, 'npm test')) {
        collected.push(event)
      }

      expect(collected[0]).toEqual({ type: 'stdout', data: 'first' })
    })

    it('records each call', async () => {
      const { sessionId } = await sandbox.startSession()
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _event of sandbox.executeStream(sessionId, 'ls')) {
        // consume
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _event of sandbox.executeStream(sessionId, 'pwd')) {
        // consume
      }

      expect(sandbox.executeStreamCalls).toHaveLength(2)
      expect(sandbox.executeStreamCalls[0]!.command).toBe('ls')
      expect(sandbox.executeStreamCalls[1]!.command).toBe('pwd')
    })

    it('throws when session does not exist', async () => {
      await expect(async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _event of sandbox.executeStream('nonexistent', 'ls')) {
          // consume
        }
      }).rejects.toThrow('Session not found: nonexistent')
    })

    it('matches substring for string patterns', async () => {
      sandbox.configureStream('test', [
        { type: 'stdout', data: 'matched' },
        { type: 'exit', exitCode: 0, timedOut: false },
      ])

      const { sessionId } = await sandbox.startSession()
      const collected: ExecEvent[] = []
      for await (const event of sandbox.executeStream(sessionId, 'npm test -- --watch')) {
        collected.push(event)
      }

      expect(collected[0]).toEqual({ type: 'stdout', data: 'matched' })
    })
  })

  // -------------------------------------------------------------------------
  // exposePort
  // -------------------------------------------------------------------------

  describe('exposePort', () => {
    it('records call and returns localhost URL', async () => {
      const { sessionId } = await sandbox.startSession()
      const result = await sandbox.exposePort(sessionId, 3000)

      expect(result.url).toBe('http://localhost:3000')
      expect(sandbox.exposePortCalls).toHaveLength(1)
      expect(sandbox.exposePortCalls[0]).toEqual({ sessionId, port: 3000 })
    })

    it('supports multiple ports', async () => {
      const { sessionId } = await sandbox.startSession()

      const r1 = await sandbox.exposePort(sessionId, 3000)
      const r2 = await sandbox.exposePort(sessionId, 8080)

      expect(r1.url).toBe('http://localhost:3000')
      expect(r2.url).toBe('http://localhost:8080')
      expect(sandbox.exposePortCalls).toHaveLength(2)
    })

    it('throws when session does not exist', async () => {
      await expect(sandbox.exposePort('nonexistent', 3000)).rejects.toThrow(
        'Session not found: nonexistent',
      )
    })
  })

  // -------------------------------------------------------------------------
  // stopSession
  // -------------------------------------------------------------------------

  describe('stopSession', () => {
    it('records call and removes session', async () => {
      const { sessionId } = await sandbox.startSession()
      expect(sandbox.getActiveSessions()).toContain(sessionId)

      await sandbox.stopSession(sessionId)

      expect(sandbox.stopSessionCalls).toHaveLength(1)
      expect(sandbox.stopSessionCalls[0]).toEqual({ sessionId })
      expect(sandbox.getActiveSessions()).not.toContain(sessionId)
    })

    it('allows stopping the same session twice without error', async () => {
      const { sessionId } = await sandbox.startSession()
      await sandbox.stopSession(sessionId)
      await sandbox.stopSession(sessionId)

      expect(sandbox.stopSessionCalls).toHaveLength(2)
    })

    it('makes subsequent executeStream throw for that session', async () => {
      const { sessionId } = await sandbox.startSession()
      await sandbox.stopSession(sessionId)

      await expect(async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _event of sandbox.executeStream(sessionId, 'ls')) {
          // consume
        }
      }).rejects.toThrow(`Session not found: ${sessionId}`)
    })
  })

  // -------------------------------------------------------------------------
  // V1 base methods
  // -------------------------------------------------------------------------

  describe('V1 SandboxProtocol methods', () => {
    it('isAvailable defaults to true', async () => {
      expect(await sandbox.isAvailable()).toBe(true)
    })

    it('setAvailable changes isAvailable result', async () => {
      sandbox.setAvailable(false)
      expect(await sandbox.isAvailable()).toBe(false)
    })

    it('execute returns default success', async () => {
      const result = await sandbox.execute('echo hello')
      expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '', timedOut: false })
    })

    it('uploadFiles and downloadFiles work', async () => {
      await sandbox.uploadFiles({ 'a.ts': 'content-a', 'b.ts': 'content-b' })
      const result = await sandbox.downloadFiles(['a.ts', 'missing.ts'])

      expect(result).toEqual({ 'a.ts': 'content-a' })
    })

    it('cleanup resets all state', async () => {
      await sandbox.startSession()
      await sandbox.uploadFiles({ 'x.ts': 'data' })

      await sandbox.cleanup()

      expect(sandbox.getActiveSessions()).toHaveLength(0)
      const downloaded = await sandbox.downloadFiles(['x.ts'])
      expect(downloaded).toEqual({})

      // Session counter resets
      const { sessionId } = await sandbox.startSession()
      expect(sessionId).toBe('session-1')
    })
  })

  // -------------------------------------------------------------------------
  // Method chaining
  // -------------------------------------------------------------------------

  describe('method chaining', () => {
    it('configureStream returns this', () => {
      const result = sandbox.configureStream('cmd', [])
      expect(result).toBe(sandbox)
    })

    it('failNextSession returns this', () => {
      const result = sandbox.failNextSession(new Error('x'))
      expect(result).toBe(sandbox)
    })

    it('setAvailable returns this', () => {
      const result = sandbox.setAvailable(false)
      expect(result).toBe(sandbox)
    })

    it('supports fluent chaining', () => {
      const result = sandbox
        .setAvailable(true)
        .configureStream('npm test', [{ type: 'exit', exitCode: 0, timedOut: false }])
        .configureStream(/build/, [{ type: 'exit', exitCode: 0, timedOut: false }])

      expect(result).toBe(sandbox)
    })
  })
})
