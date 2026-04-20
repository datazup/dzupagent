import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { DryRunReporter } from '../dzupagent/dry-run-reporter.js'

// ---------------------------------------------------------------------------
// DryRunReporter — console mode
// ---------------------------------------------------------------------------

describe('DryRunReporter (console mode)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
  })

  it('constructor accepts plain string mode', () => {
    expect(() => new DryRunReporter('console')).not.toThrow()
  })

  it('constructor accepts options object with format field', () => {
    expect(() => new DryRunReporter({ format: 'console' })).not.toThrow()
  })

  it('reportDiff logs header and diff content', () => {
    const reporter = new DryRunReporter('console')
    reporter.reportDiff('/some/file.ts', '- old\n+ new')

    expect(logSpy).toHaveBeenCalledTimes(2)
    expect(logSpy).toHaveBeenNthCalledWith(1, '\nDiff for /some/file.ts:')
    expect(logSpy).toHaveBeenNthCalledWith(2, '- old\n+ new')
  })

  it('reportNewFile logs would-create message', () => {
    const reporter = new DryRunReporter('console')
    reporter.reportNewFile('/new/file.ts')

    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(logSpy).toHaveBeenCalledWith('\n[dry-run] Would create new file: /new/file.ts')
  })

  it('reportWouldWrite logs would-write message', () => {
    const reporter = new DryRunReporter('console')
    reporter.reportWouldWrite('/existing/file.ts')

    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(logSpy).toHaveBeenCalledWith('[dry-run] Would write: /existing/file.ts')
  })

  it('reportWouldOverwrite logs would-overwrite message', () => {
    const reporter = new DryRunReporter('console')
    reporter.reportWouldOverwrite('/diverged/file.ts')

    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(logSpy).toHaveBeenCalledWith('[dry-run] Would overwrite diverged file: /diverged/file.ts')
  })

  it('report() logs one header + diff per entry', () => {
    const reporter = new DryRunReporter('console')
    reporter.report([
      { path: '/a.ts', diff: '- a\n+ b' },
      { path: '/b.ts', diff: '- x\n+ y' },
    ])

    // 2 files × 2 console.log calls each
    expect(logSpy).toHaveBeenCalledTimes(4)
    expect(logSpy).toHaveBeenNthCalledWith(1, '\nDiff for /a.ts:')
    expect(logSpy).toHaveBeenNthCalledWith(2, '- a\n+ b')
    expect(logSpy).toHaveBeenNthCalledWith(3, '\nDiff for /b.ts:')
    expect(logSpy).toHaveBeenNthCalledWith(4, '- x\n+ y')
  })

  it('report() with empty array emits nothing', () => {
    const reporter = new DryRunReporter('console')
    reporter.report([])

    expect(logSpy).not.toHaveBeenCalled()
  })

  it('flush() is a no-op in console mode', () => {
    const reporter = new DryRunReporter('console')
    reporter.reportWouldWrite('/some/file.ts')
    logSpy.mockClear()

    reporter.flush()

    expect(logSpy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// DryRunReporter — json mode
// ---------------------------------------------------------------------------

describe('DryRunReporter (json mode)', () => {
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

  it('constructor accepts options object with format: json', () => {
    expect(() => new DryRunReporter({ format: 'json' })).not.toThrow()
  })

  it('reportDiff buffers entry without calling console.log', () => {
    const reporter = new DryRunReporter('json')
    reporter.reportDiff('/a.ts', '- old\n+ new')

    expect(logSpy).not.toHaveBeenCalled()
  })

  it('reportNewFile buffers entry without calling console.log', () => {
    const reporter = new DryRunReporter('json')
    reporter.reportNewFile('/new.ts')

    expect(logSpy).not.toHaveBeenCalled()
  })

  it('reportWouldWrite buffers entry without calling console.log', () => {
    const reporter = new DryRunReporter('json')
    reporter.reportWouldWrite('/write.ts')

    expect(logSpy).not.toHaveBeenCalled()
  })

  it('reportWouldOverwrite buffers entry without calling console.log', () => {
    const reporter = new DryRunReporter('json')
    reporter.reportWouldOverwrite('/overwrite.ts')

    expect(logSpy).not.toHaveBeenCalled()
  })

  it('flush() writes a single JSON blob to stdout via console.log', () => {
    const reporter = new DryRunReporter('json')
    reporter.reportDiff('/a.ts', '- old\n+ new')
    reporter.reportNewFile('/b.ts')

    reporter.flush()

    expect(logSpy).toHaveBeenCalledTimes(1)

    const raw = logSpy.mock.calls[0]![0] as string
    const parsed = JSON.parse(raw) as unknown[]
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(2)
  })

  it('flush() emits entries with correct types and paths', () => {
    const reporter = new DryRunReporter('json')
    reporter.reportDiff('/a.ts', 'the diff')
    reporter.reportNewFile('/b.ts')
    reporter.reportWouldWrite('/c.ts')
    reporter.reportWouldOverwrite('/d.ts')

    reporter.flush()

    const raw = logSpy.mock.calls[0]![0] as string
    const entries = JSON.parse(raw) as Array<{ type: string; path: string; diff?: string }>

    expect(entries[0]).toMatchObject({ type: 'diff', path: '/a.ts', diff: 'the diff' })
    expect(entries[1]).toMatchObject({ type: 'new', path: '/b.ts' })
    expect(entries[2]).toMatchObject({ type: 'write', path: '/c.ts' })
    expect(entries[3]).toMatchObject({ type: 'overwrite', path: '/d.ts' })
  })

  it('flush() with no buffered entries outputs empty array', () => {
    const reporter = new DryRunReporter('json')
    reporter.flush()

    expect(logSpy).toHaveBeenCalledTimes(1)
    const raw = logSpy.mock.calls[0]![0] as string
    const parsed = JSON.parse(raw) as unknown[]
    expect(parsed).toEqual([])
  })

  it('report() writes a single {files:[...]} JSON blob to process.stdout without buffering', () => {
    const reporter = new DryRunReporter('json')
    reporter.report([
      { path: '/a.ts', diff: '- a\n+ b' },
      { path: '/b.ts', diff: '- x\n+ y' },
    ])

    expect(stdoutSpy).toHaveBeenCalledTimes(1)
    expect(logSpy).not.toHaveBeenCalled()

    const written = stdoutSpy.mock.calls[0]![0] as string
    const parsed = JSON.parse(written.trimEnd()) as { files: Array<{ path: string; diff: string }> }
    expect(parsed.files).toHaveLength(2)
    expect(parsed.files[0]).toMatchObject({ path: '/a.ts', diff: '- a\n+ b' })
    expect(parsed.files[1]).toMatchObject({ path: '/b.ts', diff: '- x\n+ y' })
  })

  it('report() does not add entries to the flush buffer', () => {
    const reporter = new DryRunReporter('json')
    reporter.report([{ path: '/a.ts', diff: '- a\n+ b' }])
    stdoutSpy.mockClear()
    logSpy.mockClear()

    // flush should still produce an empty array since report() bypasses the buffer
    reporter.flush()

    const raw = logSpy.mock.calls[0]![0] as string
    const entries = JSON.parse(raw) as unknown[]
    expect(entries).toEqual([])
  })

  it('report() with empty array emits nothing', () => {
    const reporter = new DryRunReporter('json')
    reporter.report([])

    expect(stdoutSpy).not.toHaveBeenCalled()
    expect(logSpy).not.toHaveBeenCalled()
  })

  it('all four report methods buffer independently then flush emits all together', () => {
    const reporter = new DryRunReporter('json')
    reporter.reportDiff('/diff.ts', '- x\n+ y')
    reporter.reportNewFile('/new.ts')
    reporter.reportWouldWrite('/write.ts')
    reporter.reportWouldOverwrite('/over.ts')

    // No output yet
    expect(logSpy).not.toHaveBeenCalled()

    reporter.flush()

    expect(logSpy).toHaveBeenCalledTimes(1)
    const raw = logSpy.mock.calls[0]![0] as string
    const entries = JSON.parse(raw) as Array<{ type: string; path: string }>
    expect(entries).toHaveLength(4)
    expect(entries.map((e) => e.type)).toEqual(['diff', 'new', 'write', 'overwrite'])
  })
})
