import { describe, it, expect, beforeEach } from 'vitest'
import { VirtualFS } from '../../vfs/virtual-fs.js'
import { CopyOnWriteVFS } from '../../vfs/cow-vfs.js'
import { sample, selectBest, commitBest, sampleAndCommitBest } from '../../vfs/parallel-sampling.js'

describe('CopyOnWriteVFS', () => {
  let root: VirtualFS

  beforeEach(() => {
    root = new VirtualFS({
      'src/index.ts': 'export const version = "1.0.0"',
      'src/utils.ts': 'export function add(a: number, b: number) { return a + b }',
      'src/config.ts': 'export const config = { debug: false }',
      'README.md': '# My Project',
    })
  })

  describe('fork creation', () => {
    it('creates a fork with depth 1 from a VirtualFS', () => {
      const fork = new CopyOnWriteVFS(root, 'test-fork')
      expect(fork.depth).toBe(1)
      expect(fork.label).toBe('test-fork')
      expect(fork.parent).toBe(root)
    })

    it('creates nested forks with incrementing depth', () => {
      const fork1 = new CopyOnWriteVFS(root)
      const fork2 = fork1.fork('level-2')
      const fork3 = fork2.fork('level-3')

      expect(fork1.depth).toBe(1)
      expect(fork2.depth).toBe(2)
      expect(fork3.depth).toBe(3)
    })

    it('throws when exceeding max fork depth of 3', () => {
      const fork1 = new CopyOnWriteVFS(root)
      const fork2 = fork1.fork()
      const fork3 = fork2.fork()

      expect(() => fork3.fork()).toThrow(/Fork depth 4 exceeds maximum of 3/)
    })

    it('assigns a default label when none provided', () => {
      const fork = new CopyOnWriteVFS(root)
      expect(fork.label).toMatch(/^fork-\d+$/)
    })
  })

  describe('read fall-through', () => {
    it('reads files from parent when not in overlay', () => {
      const fork = new CopyOnWriteVFS(root)
      expect(fork.read('src/index.ts')).toBe('export const version = "1.0.0"')
      expect(fork.read('src/utils.ts')).toBe('export function add(a: number, b: number) { return a + b }')
    })

    it('reads from overlay when file has been written in fork', () => {
      const fork = new CopyOnWriteVFS(root)
      fork.write('src/index.ts', 'export const version = "2.0.0"')
      expect(fork.read('src/index.ts')).toBe('export const version = "2.0.0"')
    })

    it('returns null for non-existent files', () => {
      const fork = new CopyOnWriteVFS(root)
      expect(fork.read('non-existent.ts')).toBeNull()
    })

    it('falls through multiple levels of forks', () => {
      const fork1 = new CopyOnWriteVFS(root)
      fork1.write('src/utils.ts', 'modified in fork1')
      const fork2 = fork1.fork()

      // fork2 reads from fork1 overlay
      expect(fork2.read('src/utils.ts')).toBe('modified in fork1')
      // fork2 falls through fork1 to root
      expect(fork2.read('src/index.ts')).toBe('export const version = "1.0.0"')
    })
  })

  describe('write isolation', () => {
    it('writes do not affect the parent', () => {
      const fork = new CopyOnWriteVFS(root)
      fork.write('src/index.ts', 'modified')
      fork.write('src/new-file.ts', 'new content')

      // Parent unchanged
      expect(root.read('src/index.ts')).toBe('export const version = "1.0.0"')
      expect(root.read('src/new-file.ts')).toBeNull()

      // Fork has changes
      expect(fork.read('src/index.ts')).toBe('modified')
      expect(fork.read('src/new-file.ts')).toBe('new content')
    })

    it('sibling forks are isolated from each other', () => {
      const fork1 = new CopyOnWriteVFS(root)
      const fork2 = new CopyOnWriteVFS(root)

      fork1.write('src/index.ts', 'fork1 version')
      fork2.write('src/index.ts', 'fork2 version')

      expect(fork1.read('src/index.ts')).toBe('fork1 version')
      expect(fork2.read('src/index.ts')).toBe('fork2 version')
      expect(root.read('src/index.ts')).toBe('export const version = "1.0.0"')
    })
  })

  describe('delete tracking', () => {
    it('masks parent reads for deleted files', () => {
      const fork = new CopyOnWriteVFS(root)
      fork.delete('src/config.ts')

      expect(fork.read('src/config.ts')).toBeNull()
      expect(fork.exists('src/config.ts')).toBe(false)

      // Parent still has it
      expect(root.read('src/config.ts')).toBe('export const config = { debug: false }')
    })

    it('returns true when deleting an existing file', () => {
      const fork = new CopyOnWriteVFS(root)
      expect(fork.delete('src/config.ts')).toBe(true)
    })

    it('returns false when deleting a non-existent file', () => {
      const fork = new CopyOnWriteVFS(root)
      expect(fork.delete('non-existent.ts')).toBe(false)
    })

    it('write after delete undeletes the file', () => {
      const fork = new CopyOnWriteVFS(root)
      fork.delete('src/config.ts')
      expect(fork.read('src/config.ts')).toBeNull()

      fork.write('src/config.ts', 'new config')
      expect(fork.read('src/config.ts')).toBe('new config')
    })

    it('deleted files are excluded from list()', () => {
      const fork = new CopyOnWriteVFS(root)
      fork.delete('src/config.ts')

      const files = fork.list()
      expect(files).not.toContain('src/config.ts')
      expect(files).toContain('src/index.ts')
    })
  })

  describe('list()', () => {
    it('includes parent files and overlay files', () => {
      const fork = new CopyOnWriteVFS(root)
      fork.write('src/new.ts', 'new file')

      const files = fork.list()
      expect(files).toContain('src/index.ts')
      expect(files).toContain('src/new.ts')
      expect(files).toContain('README.md')
    })

    it('filters by directory prefix', () => {
      const fork = new CopyOnWriteVFS(root)
      fork.write('lib/helper.ts', 'helper')

      const srcFiles = fork.list('src')
      expect(srcFiles).toContain('src/index.ts')
      expect(srcFiles).not.toContain('README.md')
      expect(srcFiles).not.toContain('lib/helper.ts')
    })

    it('returns sorted paths', () => {
      const fork = new CopyOnWriteVFS(root)
      fork.write('aaa.ts', 'a')
      fork.write('zzz.ts', 'z')

      const files = fork.list()
      const sorted = [...files].sort()
      expect(files).toEqual(sorted)
    })
  })

  describe('size', () => {
    it('reflects parent + overlay - deleted files', () => {
      const fork = new CopyOnWriteVFS(root)
      expect(fork.size).toBe(4) // same as parent

      fork.write('src/new.ts', 'new')
      expect(fork.size).toBe(5) // added one

      fork.delete('README.md')
      expect(fork.size).toBe(4) // removed one
    })
  })

  describe('exists()', () => {
    it('returns true for parent files', () => {
      const fork = new CopyOnWriteVFS(root)
      expect(fork.exists('src/index.ts')).toBe(true)
    })

    it('returns true for overlay files', () => {
      const fork = new CopyOnWriteVFS(root)
      fork.write('new.ts', 'content')
      expect(fork.exists('new.ts')).toBe(true)
    })

    it('returns false for deleted files', () => {
      const fork = new CopyOnWriteVFS(root)
      fork.delete('src/index.ts')
      expect(fork.exists('src/index.ts')).toBe(false)
    })

    it('returns false for non-existent files', () => {
      const fork = new CopyOnWriteVFS(root)
      expect(fork.exists('nope.ts')).toBe(false)
    })
  })

  describe('getModifiedFiles() / getDeletedFiles()', () => {
    it('tracks modified files', () => {
      const fork = new CopyOnWriteVFS(root)
      fork.write('src/index.ts', 'updated')
      fork.write('src/new.ts', 'new file')

      expect(fork.getModifiedFiles()).toContain('src/index.ts')
      expect(fork.getModifiedFiles()).toContain('src/new.ts')
    })

    it('tracks deleted files', () => {
      const fork = new CopyOnWriteVFS(root)
      fork.delete('src/config.ts')
      fork.delete('README.md')

      expect(fork.getDeletedFiles()).toContain('src/config.ts')
      expect(fork.getDeletedFiles()).toContain('README.md')
    })
  })

  describe('diff()', () => {
    it('detects added files', () => {
      const fork = new CopyOnWriteVFS(root)
      fork.write('src/new.ts', 'new content')

      const d = fork.diff()
      expect(d.added).toHaveLength(1)
      expect(d.added[0]!.path).toBe('src/new.ts')
      expect(d.added[0]!.newContent).toBe('new content')
    })

    it('detects modified files', () => {
      const fork = new CopyOnWriteVFS(root)
      fork.write('src/index.ts', 'updated')

      const d = fork.diff()
      expect(d.modified).toHaveLength(1)
      expect(d.modified[0]!.path).toBe('src/index.ts')
      expect(d.modified[0]!.oldContent).toBe('export const version = "1.0.0"')
      expect(d.modified[0]!.newContent).toBe('updated')
    })

    it('detects deleted files', () => {
      const fork = new CopyOnWriteVFS(root)
      fork.delete('src/config.ts')

      const d = fork.diff()
      expect(d.deleted).toHaveLength(1)
      expect(d.deleted[0]!.path).toBe('src/config.ts')
      expect(d.deleted[0]!.oldContent).toBe('export const config = { debug: false }')
    })

    it('returns empty diff when fork has no changes', () => {
      const fork = new CopyOnWriteVFS(root)
      const d = fork.diff()
      expect(d.added).toHaveLength(0)
      expect(d.modified).toHaveLength(0)
      expect(d.deleted).toHaveLength(0)
    })

    it('does not include writes identical to parent', () => {
      const fork = new CopyOnWriteVFS(root)
      // Write same content as parent
      fork.write('src/index.ts', 'export const version = "1.0.0"')

      const d = fork.diff()
      expect(d.modified).toHaveLength(0)
      expect(d.added).toHaveLength(0)
    })
  })

  describe('forkDelta()', () => {
    it('returns flat list of all changes', () => {
      const fork = new CopyOnWriteVFS(root)
      fork.write('src/new.ts', 'new')
      fork.write('src/index.ts', 'updated')
      fork.delete('README.md')

      const delta = fork.forkDelta()
      expect(delta).toHaveLength(3)

      const paths = delta.map(d => d.path)
      expect(paths).toContain('src/new.ts')
      expect(paths).toContain('src/index.ts')
      expect(paths).toContain('README.md')
    })
  })

  describe('conflicts()', () => {
    it('detects files modified differently in two forks', () => {
      const fork1 = new CopyOnWriteVFS(root)
      const fork2 = new CopyOnWriteVFS(root)

      fork1.write('src/index.ts', 'fork1 version')
      fork2.write('src/index.ts', 'fork2 version')

      const c = fork1.conflicts(fork2)
      expect(c).toHaveLength(1)
      expect(c[0]!.path).toBe('src/index.ts')
      expect(c[0]!.parentContent).toBe('fork1 version')
      expect(c[0]!.childContent).toBe('fork2 version')
    })

    it('returns empty when forks modify different files', () => {
      const fork1 = new CopyOnWriteVFS(root)
      const fork2 = new CopyOnWriteVFS(root)

      fork1.write('src/index.ts', 'modified')
      fork2.write('src/utils.ts', 'modified')

      expect(fork1.conflicts(fork2)).toHaveLength(0)
    })

    it('returns empty when forks make identical changes', () => {
      const fork1 = new CopyOnWriteVFS(root)
      const fork2 = new CopyOnWriteVFS(root)

      fork1.write('src/index.ts', 'same content')
      fork2.write('src/index.ts', 'same content')

      expect(fork1.conflicts(fork2)).toHaveLength(0)
    })

    it('detects delete vs modify conflicts', () => {
      const fork1 = new CopyOnWriteVFS(root)
      const fork2 = new CopyOnWriteVFS(root)

      fork1.delete('src/index.ts')
      fork2.write('src/index.ts', 'modified')

      const c = fork1.conflicts(fork2)
      expect(c).toHaveLength(1)
      expect(c[0]!.path).toBe('src/index.ts')
    })
  })

  describe('merge()', () => {
    it('merges fork changes into parent with theirs strategy (default)', () => {
      const fork = new CopyOnWriteVFS(root)
      fork.write('src/index.ts', 'updated version')
      fork.write('src/new.ts', 'brand new file')
      fork.delete('README.md')

      const result = fork.merge()
      expect(result.clean).toBe(true)
      expect(result.merged).toContain('src/index.ts')
      expect(result.merged).toContain('src/new.ts')
      expect(result.merged).toContain('README.md')

      // Parent should now have the fork's changes
      expect(root.read('src/index.ts')).toBe('updated version')
      expect(root.read('src/new.ts')).toBe('brand new file')
      expect(root.read('README.md')).toBeNull()
    })

    it('handles conflicts with ours strategy (parent wins)', () => {
      const fork = new CopyOnWriteVFS(root)
      fork.write('src/index.ts', 'fork version')

      // Simulate parent modification after fork
      root.write('src/index.ts', 'parent updated after fork')

      const result = fork.merge('ours')
      expect(result.clean).toBe(true)

      // Parent content should remain (ours = parent wins)
      expect(root.read('src/index.ts')).toBe('parent updated after fork')
    })

    it('handles conflicts with theirs strategy (fork wins)', () => {
      const fork = new CopyOnWriteVFS(root)
      fork.write('src/index.ts', 'fork version')

      // Simulate parent modification after fork
      root.write('src/index.ts', 'parent updated after fork')

      const result = fork.merge('theirs')
      expect(result.clean).toBe(true)

      // Fork content should win
      expect(root.read('src/index.ts')).toBe('fork version')
    })

    it('reports conflicts with manual strategy', () => {
      const fork = new CopyOnWriteVFS(root)
      fork.write('src/index.ts', 'fork version')

      // Simulate parent modification after fork
      root.write('src/index.ts', 'parent updated after fork')

      const result = fork.merge('manual')
      expect(result.clean).toBe(false)
      expect(result.conflicts).toHaveLength(1)
      expect(result.conflicts[0]!.path).toBe('src/index.ts')
      expect(result.conflicts[0]!.childContent).toBe('fork version')
      expect(result.conflicts[0]!.parentContent).toBe('parent updated after fork')

      // Parent should be unchanged for conflicting files
      expect(root.read('src/index.ts')).toBe('parent updated after fork')
    })

    it('merges non-conflicting changes even with manual strategy', () => {
      const fork = new CopyOnWriteVFS(root)
      fork.write('src/index.ts', 'fork version')
      fork.write('src/new.ts', 'new file')

      root.write('src/index.ts', 'parent updated after fork')

      const result = fork.merge('manual')
      // The non-conflicting new file should be merged
      expect(result.merged).toContain('src/new.ts')
      expect(root.read('src/new.ts')).toBe('new file')
    })
  })

  describe('toSnapshot()', () => {
    it('materializes all visible files', () => {
      const fork = new CopyOnWriteVFS(root)
      fork.write('src/new.ts', 'new file')
      fork.delete('README.md')

      const snapshot = fork.toSnapshot()
      expect(snapshot['src/index.ts']).toBe('export const version = "1.0.0"')
      expect(snapshot['src/new.ts']).toBe('new file')
      expect(snapshot['README.md']).toBeUndefined()
    })
  })

  describe('detach()', () => {
    it('returns a standalone VirtualFS with all materialized files', () => {
      const fork = new CopyOnWriteVFS(root)
      fork.write('src/index.ts', 'updated')
      fork.write('src/new.ts', 'new')
      fork.delete('README.md')

      const detached = fork.detach()
      expect(detached).toBeInstanceOf(VirtualFS)
      expect(detached.read('src/index.ts')).toBe('updated')
      expect(detached.read('src/new.ts')).toBe('new')
      expect(detached.read('src/utils.ts')).toBe('export function add(a: number, b: number) { return a + b }')
      expect(detached.read('README.md')).toBeNull()
    })

    it('detached VFS is independent of original parent', () => {
      const fork = new CopyOnWriteVFS(root)
      fork.write('src/index.ts', 'forked')

      const detached = fork.detach()
      root.write('src/index.ts', 'parent changed later')

      // Detached should be unaffected
      expect(detached.read('src/index.ts')).toBe('forked')
    })
  })
})

describe('Parallel Sampling', () => {
  let root: VirtualFS

  beforeEach(() => {
    root = new VirtualFS({
      'src/index.ts': 'export const version = "1.0.0"',
      'src/utils.ts': 'export function add(a: number, b: number) { return a + b }',
    })
  })

  describe('sample()', () => {
    it('runs N parallel functions on separate forks', async () => {
      const results = await sample(root, 3, async (fork, index) => {
        fork.write('src/index.ts', `version ${index}`)
        return index
      })

      expect(results).toHaveLength(3)
      expect(results.map(r => r.result)).toEqual([0, 1, 2])

      // Parent should be unchanged
      expect(root.read('src/index.ts')).toBe('export const version = "1.0.0"')
    })

    it('captures errors without crashing', async () => {
      const results = await sample(root, 3, async (_fork, index) => {
        if (index === 1) throw new Error('intentional failure')
        return index
      })

      expect(results).toHaveLength(3)
      expect(results[0]!.error).toBeUndefined()
      expect(results[1]!.error).toBe('intentional failure')
      expect(results[2]!.error).toBeUndefined()
    })

    it('tracks duration for each sample', async () => {
      const results = await sample(root, 2, async (_fork, _index) => {
        return 'done'
      })

      for (const r of results) {
        expect(r.durationMs).toBeGreaterThanOrEqual(0)
      }
    })

    it('throws for invalid count', async () => {
      await expect(sample(root, 0, async () => 'x')).rejects.toThrow(/between 1 and 10/)
      await expect(sample(root, 11, async () => 'x')).rejects.toThrow(/between 1 and 10/)
    })
  })

  describe('selectBest()', () => {
    it('selects the sample with the highest score', () => {
      const results = [
        { forkIndex: 0, result: { score: 5 }, index: 0, durationMs: 10 },
        { forkIndex: 1, result: { score: 9 }, index: 1, durationMs: 20 },
        { forkIndex: 2, result: { score: 7 }, index: 2, durationMs: 15 },
      ]

      const best = selectBest(results, r => r.score)
      expect(best).not.toBeNull()
      expect(best!.index).toBe(1)
      expect(best!.result.score).toBe(9)
    })

    it('skips errored samples', () => {
      const results = [
        { forkIndex: 0, result: { score: 5 }, index: 0, durationMs: 10, error: 'failed' },
        { forkIndex: 1, result: { score: 3 }, index: 1, durationMs: 20 },
      ]

      const best = selectBest(results, r => r.score)
      expect(best!.index).toBe(1) // only non-errored option
    })

    it('returns null when all samples errored', () => {
      const results = [
        { forkIndex: 0, result: { score: 5 }, index: 0, durationMs: 10, error: 'fail1' },
        { forkIndex: 1, result: { score: 9 }, index: 1, durationMs: 20, error: 'fail2' },
      ]

      const best = selectBest(results, r => r.score)
      expect(best).toBeNull()
    })
  })

  describe('sampleAndCommitBest()', () => {
    it('runs samples and merges the best into the source VFS', async () => {
      const outcome = await sampleAndCommitBest(
        root,
        3,
        async (fork, index) => {
          const quality = (index + 1) * 10
          fork.write('src/index.ts', `// quality: ${quality}`)
          return { quality }
        },
        result => result.quality,
      )

      expect(outcome).not.toBeNull()
      expect(outcome!.winner.result.quality).toBe(30) // index 2 -> quality 30
      expect(outcome!.allResults).toHaveLength(3)

      // Root should have the winning fork's changes
      expect(root.read('src/index.ts')).toBe('// quality: 30')
    })

    it('returns null when all samples fail', async () => {
      const outcome = await sampleAndCommitBest(
        root,
        2,
        async () => {
          throw new Error('all fail')
        },
        () => 0,
      )

      expect(outcome).toBeNull()
      // Root unchanged
      expect(root.read('src/index.ts')).toBe('export const version = "1.0.0"')
    })

    it('only merges the best fork, not others', async () => {
      await sampleAndCommitBest(
        root,
        3,
        async (fork, index) => {
          fork.write(`src/sample-${index}.ts`, `sample ${index}`)
          if (index === 1) {
            fork.write('src/index.ts', 'best version')
          }
          return { quality: index === 1 ? 100 : 0 }
        },
        r => r.quality,
      )

      // Only the winning fork's files should be in root
      expect(root.read('src/index.ts')).toBe('best version')
      expect(root.read('src/sample-1.ts')).toBe('sample 1')
      // Other forks' unique files should NOT be in root
      expect(root.read('src/sample-0.ts')).toBeNull()
      expect(root.read('src/sample-2.ts')).toBeNull()
    })
  })
})
