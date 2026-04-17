/**
 * Branch coverage deep-dive for VFS, CoW, pipeline, quality dimensions.
 *
 * Targets:
 * - VirtualFS: directory listing with/without trailing slash, diff deleted,
 *   merge overwrite, fromSnapshot, empty diff
 * - CopyOnWriteVFS: delete() on non-existent, nested fork merges,
 *   diff() with unchanged overlay (written same as parent),
 *   list(directory) prefix filter
 * - PipelineExecutor: retry with backoff, maxRetries exhaust, timeout path
 * - quality-dimensions: typeStrictness with no ts files, eslintClean debug patterns
 */
import { describe, it, expect } from 'vitest'
import { VirtualFS } from '../vfs/virtual-fs.js'
import { CopyOnWriteVFS } from '../vfs/cow-vfs.js'
import { PipelineExecutor, type PhaseConfig } from '../pipeline/pipeline-executor.js'
import { typeStrictness, eslintClean } from '../quality/quality-dimensions.js'

// ---------------------------------------------------------------------------
// VirtualFS branch coverage
// ---------------------------------------------------------------------------

describe('VirtualFS — branch coverage', () => {
  it('list() filters by directory with trailing slash', () => {
    const vfs = new VirtualFS({ 'src/a.ts': '', 'src/b.ts': '', 'docs/c.md': '' })
    const files = vfs.list('src/')
    expect(files).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('list() filters by directory without trailing slash', () => {
    const vfs = new VirtualFS({ 'src/a.ts': '', 'srcOther/b.ts': '', 'docs/c.md': '' })
    // prefix is 'src/' so srcOther should NOT be included
    const files = vfs.list('src')
    expect(files).toEqual(['src/a.ts'])
  })

  it('list() returns all paths when no directory is given', () => {
    const vfs = new VirtualFS({ 'z.ts': '', 'a.ts': '' })
    // Sorted alphabetically
    expect(vfs.list()).toEqual(['a.ts', 'z.ts'])
  })

  it('delete() returns false for non-existent file', () => {
    const vfs = new VirtualFS()
    expect(vfs.delete('missing.ts')).toBe(false)
  })

  it('delete() returns true for existing file', () => {
    const vfs = new VirtualFS({ 'a.ts': 'x' })
    expect(vfs.delete('a.ts')).toBe(true)
    expect(vfs.exists('a.ts')).toBe(false)
  })

  it('read() returns null for non-existent file', () => {
    const vfs = new VirtualFS()
    expect(vfs.read('ghost.ts')).toBeNull()
  })

  it('diff() reports added files when other has extra files', () => {
    const a = new VirtualFS({ 'a.ts': '1' })
    const b = new VirtualFS({ 'a.ts': '1', 'b.ts': '2' })
    const diffs = a.diff(b)
    expect(diffs).toEqual([{ path: 'b.ts', type: 'added', newContent: '2' }])
  })

  it('diff() reports modified files when contents differ', () => {
    const a = new VirtualFS({ 'a.ts': '1' })
    const b = new VirtualFS({ 'a.ts': '2' })
    const diffs = a.diff(b)
    expect(diffs[0]).toEqual({ path: 'a.ts', type: 'modified', oldContent: '1', newContent: '2' })
  })

  it('diff() reports deleted files when this has extra files', () => {
    const a = new VirtualFS({ 'a.ts': '1', 'b.ts': '2' })
    const b = new VirtualFS({ 'a.ts': '1' })
    const diffs = a.diff(b)
    expect(diffs).toEqual([{ path: 'b.ts', type: 'deleted', oldContent: '2' }])
  })

  it('diff() returns empty when VFSs are identical', () => {
    const a = new VirtualFS({ 'a.ts': '1' })
    const b = new VirtualFS({ 'a.ts': '1' })
    expect(a.diff(b)).toEqual([])
  })

  it('merge() applies last-write-wins', () => {
    const a = new VirtualFS({ 'shared.ts': 'original', 'kept.ts': 'A' })
    const b = new VirtualFS({ 'shared.ts': 'new', 'added.ts': 'B' })
    a.merge(b)
    expect(a.read('shared.ts')).toBe('new')
    expect(a.read('added.ts')).toBe('B')
    expect(a.read('kept.ts')).toBe('A')
  })

  it('fromSnapshot() creates an equivalent VFS', () => {
    const vfs = VirtualFS.fromSnapshot({ 'x.ts': '1', 'y.ts': '2' })
    expect(vfs.size).toBe(2)
    expect(vfs.read('x.ts')).toBe('1')
  })

  it('toSnapshot() returns a plain object', () => {
    const vfs = new VirtualFS({ 'a.ts': '1' })
    const snap = vfs.toSnapshot()
    expect(snap).toEqual({ 'a.ts': '1' })
  })

  it('constructor handles undefined initial', () => {
    const vfs = new VirtualFS()
    expect(vfs.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// CopyOnWriteVFS branch coverage
// ---------------------------------------------------------------------------

describe('CopyOnWriteVFS — branch coverage', () => {
  it('delete() returns false when path does not exist in fork or parent', () => {
    const parent = new VirtualFS()
    const fork = new CopyOnWriteVFS(parent)
    expect(fork.delete('ghost.ts')).toBe(false)
  })

  it('write() clears a prior delete on same path', () => {
    const parent = new VirtualFS({ 'a.ts': 'orig' })
    const fork = new CopyOnWriteVFS(parent)
    fork.delete('a.ts')
    expect(fork.read('a.ts')).toBeNull()
    fork.write('a.ts', 'new')
    expect(fork.read('a.ts')).toBe('new')
  })

  it('exists() returns false for deleted path', () => {
    const parent = new VirtualFS({ 'a.ts': 'x' })
    const fork = new CopyOnWriteVFS(parent)
    fork.delete('a.ts')
    expect(fork.exists('a.ts')).toBe(false)
  })

  it('list(directory) filters by prefix in fork', () => {
    const parent = new VirtualFS({ 'src/a.ts': '', 'docs/b.md': '' })
    const fork = new CopyOnWriteVFS(parent)
    fork.write('src/c.ts', 'new')
    const files = fork.list('src/')
    expect(files).toContain('src/a.ts')
    expect(files).toContain('src/c.ts')
    expect(files).not.toContain('docs/b.md')
  })

  it('diff() does not report unchanged overlay writes', () => {
    const parent = new VirtualFS({ 'a.ts': 'same' })
    const fork = new CopyOnWriteVFS(parent)
    fork.write('a.ts', 'same') // same as parent content
    const { added, modified, deleted } = fork.diff()
    expect(added).toHaveLength(0)
    expect(modified).toHaveLength(0)
    expect(deleted).toHaveLength(0)
  })

  it('diff() reports added when overlay has new file not in parent', () => {
    const parent = new VirtualFS({ 'a.ts': 'x' })
    const fork = new CopyOnWriteVFS(parent)
    fork.write('b.ts', 'new file')
    const { added } = fork.diff()
    expect(added.map(d => d.path)).toEqual(['b.ts'])
  })

  it('depth tracks nesting correctly', () => {
    const parent = new VirtualFS()
    const fork1 = new CopyOnWriteVFS(parent)
    const fork2 = fork1.fork('child')
    expect(fork1.depth).toBe(1)
    expect(fork2.depth).toBe(2)
  })

  it('throws when exceeding MAX_FORK_DEPTH', () => {
    const parent = new VirtualFS()
    const f1 = new CopyOnWriteVFS(parent)
    const f2 = f1.fork()
    const f3 = f2.fork()
    expect(() => f3.fork()).toThrow(/Fork depth .* exceeds maximum/)
  })

  it('forkDelta returns flat list of changes', () => {
    const parent = new VirtualFS({ 'a.ts': 'orig' })
    const fork = new CopyOnWriteVFS(parent)
    fork.write('a.ts', 'changed')
    fork.write('b.ts', 'new')
    fork.delete('a.ts') // delete after write
    const delta = fork.forkDelta()
    expect(delta.length).toBeGreaterThan(0)
  })

  it('conflicts() detects modify/modify conflicts', () => {
    const parent = new VirtualFS({ 'a.ts': 'base' })
    const forkA = new CopyOnWriteVFS(parent, 'A')
    const forkB = new CopyOnWriteVFS(parent, 'B')
    forkA.write('a.ts', 'from-A')
    forkB.write('a.ts', 'from-B')
    const conflicts = forkA.conflicts(forkB)
    expect(conflicts.length).toBe(1)
    expect(conflicts[0]!.path).toBe('a.ts')
  })

  it('conflicts() detects delete/modify conflict', () => {
    const parent = new VirtualFS({ 'a.ts': 'base' })
    const forkA = new CopyOnWriteVFS(parent)
    const forkB = new CopyOnWriteVFS(parent)
    forkA.delete('a.ts')
    forkB.write('a.ts', 'other')
    const conflicts = forkA.conflicts(forkB)
    expect(conflicts.some(c => c.path === 'a.ts')).toBe(true)
  })

  it('conflicts() empty for identical changes', () => {
    const parent = new VirtualFS({ 'a.ts': 'base' })
    const forkA = new CopyOnWriteVFS(parent)
    const forkB = new CopyOnWriteVFS(parent)
    forkA.write('a.ts', 'same')
    forkB.write('a.ts', 'same')
    expect(forkA.conflicts(forkB)).toHaveLength(0)
  })

  it('merge() with theirs strategy applies fork content to parent', () => {
    const parent = new VirtualFS({ 'a.ts': 'orig' })
    const fork = new CopyOnWriteVFS(parent)
    fork.write('a.ts', 'new')
    const result = fork.merge('theirs')
    expect(result.clean).toBe(true)
    expect(parent.read('a.ts')).toBe('new')
  })

  it('merge() with ours strategy keeps parent content when conflict', () => {
    const parent = new VirtualFS({ 'a.ts': 'orig' })
    const fork = new CopyOnWriteVFS(parent)
    fork.write('a.ts', 'fork-change')
    // Simulate parent change between fork and merge
    parent.write('a.ts', 'parent-change')
    const result = fork.merge('ours')
    expect(result.clean).toBe(true)
    expect(parent.read('a.ts')).toBe('parent-change')
  })

  it('merge() with manual strategy reports conflicts without applying', () => {
    const parent = new VirtualFS({ 'a.ts': 'orig' })
    const fork = new CopyOnWriteVFS(parent)
    fork.write('a.ts', 'fork-change')
    parent.write('a.ts', 'parent-change')
    const result = fork.merge('manual')
    expect(result.clean).toBe(false)
    expect(result.conflicts.length).toBe(1)
    // Parent unchanged (manual did not apply)
    expect(parent.read('a.ts')).toBe('parent-change')
  })

  it('merge() applies deletions to parent', () => {
    const parent = new VirtualFS({ 'a.ts': 'orig' })
    const fork = new CopyOnWriteVFS(parent)
    fork.delete('a.ts')
    fork.merge('theirs')
    expect(parent.exists('a.ts')).toBe(false)
  })

  it('toSnapshot() materializes inherited files', () => {
    const parent = new VirtualFS({ 'a.ts': 'keep', 'b.ts': 'remove' })
    const fork = new CopyOnWriteVFS(parent)
    fork.delete('b.ts')
    fork.write('c.ts', 'new')
    const snap = fork.toSnapshot()
    expect(snap).toEqual({ 'a.ts': 'keep', 'c.ts': 'new' })
  })

  it('detach() returns standalone VFS with all inherited files', () => {
    const parent = new VirtualFS({ 'a.ts': 'orig' })
    const fork = new CopyOnWriteVFS(parent)
    fork.write('b.ts', 'new')
    const standalone = fork.detach()
    expect(standalone.read('a.ts')).toBe('orig')
    expect(standalone.read('b.ts')).toBe('new')
    expect(standalone).toBeInstanceOf(VirtualFS)
  })

  it('getModifiedFiles() returns overlay keys', () => {
    const parent = new VirtualFS()
    const fork = new CopyOnWriteVFS(parent)
    fork.write('a.ts', 'x')
    fork.write('b.ts', 'y')
    expect(fork.getModifiedFiles().sort()).toEqual(['a.ts', 'b.ts'])
  })

  it('getDeletedFiles() returns delete set', () => {
    const parent = new VirtualFS({ 'a.ts': 'x' })
    const fork = new CopyOnWriteVFS(parent)
    fork.delete('a.ts')
    expect(fork.getDeletedFiles()).toEqual(['a.ts'])
  })

  it('default label is generated from timestamp', () => {
    const parent = new VirtualFS()
    const fork = new CopyOnWriteVFS(parent)
    expect(fork.label).toMatch(/^fork-/)
  })
})

// ---------------------------------------------------------------------------
// PipelineExecutor branch coverage
// ---------------------------------------------------------------------------

describe('PipelineExecutor — branch coverage', () => {
  it('retries a failing phase and succeeds on retry', async () => {
    let attempts = 0
    const phases: PhaseConfig[] = [
      {
        id: 'flaky',
        name: 'flaky',
        maxRetries: 2,
        execute: async () => {
          attempts++
          if (attempts < 2) throw new Error('transient')
          return { ok: true }
        },
      },
    ]
    const ex = new PipelineExecutor()
    const result = await ex.execute(phases, {})
    expect(result.status).toBe('completed')
    expect(result.phases[0]!.retries).toBe(1)
  })

  it('exhausts retries and reports failure', async () => {
    const phases: PhaseConfig[] = [
      {
        id: 'bad',
        name: 'bad',
        maxRetries: 2,
        execute: async () => {
          throw new Error('always fails')
        },
      },
    ]
    const ex = new PipelineExecutor()
    const result = await ex.execute(phases, {})
    expect(result.status).toBe('failed')
    expect(result.phases[0]!.status).toBe('failed')
    expect(result.phases[0]!.retries).toBe(2)
  })

  it('applies onProgress callback', async () => {
    const progressEvents: Array<[string, number]> = []
    const ex = new PipelineExecutor({
      onProgress: (id, pct) => progressEvents.push([id, pct]),
    })
    const phases: PhaseConfig[] = [
      { id: 'a', name: 'a', execute: async () => ({ a: 1 }) },
    ]
    await ex.execute(phases, {})
    const aEvents = progressEvents.filter(([id]) => id === 'a')
    // At least the final 1.0 progress event should be emitted
    expect(aEvents.some(([, pct]) => pct === 1)).toBe(true)
  })

  it('invokes onCheckpoint after each successful phase', async () => {
    const seen: string[] = []
    const ex = new PipelineExecutor({
      onCheckpoint: async (id) => {
        seen.push(id)
      },
    })
    const phases: PhaseConfig[] = [
      { id: 'a', name: 'a', execute: async () => ({ a: 1 }) },
      { id: 'b', name: 'b', execute: async () => ({ b: 2 }) },
    ]
    await ex.execute(phases, {})
    expect(seen).toEqual(['a', 'b'])
  })

  it('throws when phase dependency is unknown', async () => {
    const ex = new PipelineExecutor()
    const phases: PhaseConfig[] = [
      { id: 'a', name: 'a', dependsOn: ['missing'], execute: async () => ({}) },
    ]
    await expect(ex.execute(phases, {})).rejects.toThrow(/Unknown dependency/)
  })

  it('throws on cyclic dependencies', async () => {
    const ex = new PipelineExecutor()
    const phases: PhaseConfig[] = [
      { id: 'a', name: 'a', dependsOn: ['b'], execute: async () => ({}) },
      { id: 'b', name: 'b', dependsOn: ['a'], execute: async () => ({}) },
    ]
    await expect(ex.execute(phases, {})).rejects.toThrow(/Cycle detected/)
  })

  it('handles single empty phase execution', async () => {
    const ex = new PipelineExecutor()
    const phases: PhaseConfig[] = [
      { id: 'solo', name: 'solo', execute: async () => ({}) },
    ]
    const result = await ex.execute(phases, {})
    expect(result.status).toBe('completed')
  })
})

// ---------------------------------------------------------------------------
// quality-dimensions branch coverage
// ---------------------------------------------------------------------------

describe('quality-dimensions — branch coverage', () => {
  it('typeStrictness awards full marks when there are no TS files', async () => {
    const result = await typeStrictness.evaluate({ 'README.md': 'hello', 'config.json': '{}' })
    expect(result.score).toBe(typeStrictness.maxPoints)
    expect(result.passed).toBe(true)
  })

  it('typeStrictness penalises any usage', async () => {
    const result = await typeStrictness.evaluate({
      'a.ts': 'export const x: any = 1\nexport const y = 2 as any\n',
    })
    expect(result.score).toBeLessThan(typeStrictness.maxPoints)
    expect(result.passed).toBe(false)
  })

  it('typeStrictness penalises ts-ignore and ts-nocheck', async () => {
    const result = await typeStrictness.evaluate({
      'a.ts': '// @ts-ignore\nconst x = broken()\n// @ts-nocheck\n',
    })
    expect(result.passed).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('typeStrictness ignores .d.ts files', async () => {
    const result = await typeStrictness.evaluate({
      'types/api.d.ts': 'export const x: any = 1',
    })
    // .d.ts is excluded from isTypeScriptFile, so no TS files counted → score == max
    expect(result.score).toBe(typeStrictness.maxPoints)
  })

  it('eslintClean passes with clean code', async () => {
    const result = await eslintClean.evaluate({ 'a.ts': 'export const x = 1' })
    expect(result.passed).toBe(true)
  })

  it('eslintClean flags console.log usage', async () => {
    const result = await eslintClean.evaluate({
      'a.ts': 'export function f() { console.log("hi") }',
    })
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('eslintClean flags debugger statements', async () => {
    const result = await eslintClean.evaluate({
      'a.ts': 'export function f() { debugger; return 1 }',
    })
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('eslintClean ignores test files (no warnings for console.log in tests)', async () => {
    const result = await eslintClean.evaluate({
      'a.test.ts': 'it("works", () => { console.log("debug"); })',
    })
    expect(result.warnings).toHaveLength(0)
  })

  it('eslintClean ignores non-TS/JS files', async () => {
    const result = await eslintClean.evaluate({
      'README.md': 'console.log("code sample")',
    })
    expect(result.passed).toBe(true)
  })
})
