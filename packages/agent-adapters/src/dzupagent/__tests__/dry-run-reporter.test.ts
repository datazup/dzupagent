import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { DryRunReporter } from '../dry-run-reporter.js'

describe('DryRunReporter', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    logSpy.mockRestore()
    stdoutSpy.mockRestore()
  })

  describe('constructor', () => {
    it('accepts object-form { format } option', () => {
      const r = new DryRunReporter({ format: 'console' })
      expect(r).toBeInstanceOf(DryRunReporter)
    })

    it('accepts string-form mode', () => {
      const r = new DryRunReporter('json')
      expect(r).toBeInstanceOf(DryRunReporter)
    })

    it('defaults to console format', () => {
      const r = new DryRunReporter()
      r.report([{ path: 'a.md', diff: '+line' }])
      expect(logSpy).toHaveBeenCalled()
      expect(stdoutSpy).not.toHaveBeenCalled()
    })
  })

  describe('report() — console format', () => {
    it('prints each diff with a header via console.log', () => {
      const r = new DryRunReporter({ format: 'console' })
      r.report([{ path: 'foo/bar.md', diff: '--- a\n+++ b\n+new' }])

      const calls = logSpy.mock.calls.map((c) => c.join(' '))
      expect(calls.some((c) => c.includes('Diff for foo/bar.md'))).toBe(true)
      expect(calls.some((c) => c.includes('+new'))).toBe(true)
      expect(stdoutSpy).not.toHaveBeenCalled()
    })

    it('prints multiple diffs for multi-file output', () => {
      const r = new DryRunReporter({ format: 'console' })
      r.report([
        { path: 'file-a.md', diff: '+a' },
        { path: 'file-b.md', diff: '+b' },
        { path: 'file-c.md', diff: '+c' },
      ])

      const calls = logSpy.mock.calls.map((c) => c.join(' '))
      expect(calls.some((c) => c.includes('Diff for file-a.md'))).toBe(true)
      expect(calls.some((c) => c.includes('Diff for file-b.md'))).toBe(true)
      expect(calls.some((c) => c.includes('Diff for file-c.md'))).toBe(true)
      // two log lines per diff (header + body) → 6 total
      expect(logSpy).toHaveBeenCalledTimes(6)
    })
  })

  describe('report() — json format', () => {
    it('writes a single JSON payload with files[] to stdout', () => {
      const r = new DryRunReporter({ format: 'json' })
      r.report([{ path: 'x.md', diff: '@@ -1 +1 @@\n-a\n+b' }])

      expect(stdoutSpy).toHaveBeenCalledTimes(1)
      const written = String(stdoutSpy.mock.calls[0]?.[0] ?? '')
      const parsed = JSON.parse(written.trim()) as {
        files: Array<{ path: string; diff: string }>
      }
      expect(parsed.files).toHaveLength(1)
      expect(parsed.files[0]).toEqual({ path: 'x.md', diff: '@@ -1 +1 @@\n-a\n+b' })
      expect(logSpy).not.toHaveBeenCalled()
    })

    it('serialises multi-file diffs into a single files[] blob', () => {
      const r = new DryRunReporter({ format: 'json' })
      r.report([
        { path: 'one.md', diff: '+1' },
        { path: 'two.md', diff: '+2' },
      ])

      expect(stdoutSpy).toHaveBeenCalledTimes(1)
      const written = String(stdoutSpy.mock.calls[0]?.[0] ?? '')
      const parsed = JSON.parse(written.trim()) as {
        files: Array<{ path: string; diff: string }>
      }
      expect(parsed.files).toEqual([
        { path: 'one.md', diff: '+1' },
        { path: 'two.md', diff: '+2' },
      ])
    })
  })

  describe('report() — empty input', () => {
    it('prints nothing in console mode when given an empty array', () => {
      const r = new DryRunReporter({ format: 'console' })
      r.report([])
      expect(logSpy).not.toHaveBeenCalled()
      expect(stdoutSpy).not.toHaveBeenCalled()
    })

    it('writes nothing in json mode when given an empty array', () => {
      const r = new DryRunReporter({ format: 'json' })
      r.report([])
      expect(stdoutSpy).not.toHaveBeenCalled()
      expect(logSpy).not.toHaveBeenCalled()
    })
  })

  describe('granular reporter API (preserved for syncer)', () => {
    it('reportDiff streams in console mode', () => {
      const r = new DryRunReporter({ format: 'console' })
      r.reportDiff('a.md', '+x')
      const calls = logSpy.mock.calls.map((c) => c.join(' '))
      expect(calls.some((c) => c.includes('Diff for a.md'))).toBe(true)
    })

    it('flush emits buffered entries as JSON in json mode', () => {
      const r = new DryRunReporter({ format: 'json' })
      r.reportWouldWrite('a.md')
      r.reportNewFile('b.md')
      r.flush()
      expect(logSpy).toHaveBeenCalledTimes(1)
      const arg = String(logSpy.mock.calls[0]?.[0] ?? '')
      const parsed = JSON.parse(arg) as Array<{ type: string; path: string }>
      expect(parsed).toEqual([
        { type: 'write', path: 'a.md' },
        { type: 'new', path: 'b.md' },
      ])
    })
  })
})
