import { describe, it, expect, beforeEach } from 'vitest'
import { VirtualFS } from '../../vfs/virtual-fs.js'
import { CopyOnWriteVFS } from '../../vfs/cow-vfs.js'

describe('CopyOnWriteVFS — extended coverage', () => {
  let root: VirtualFS

  beforeEach(() => {
    root = new VirtualFS({
      'src/index.ts': 'export const version = "1.0.0"',
      'src/utils.ts': 'export function add(a: number, b: number) { return a + b }',
      'src/config.ts': 'export const config = { debug: false }',
      'lib/helper.ts': 'export function help() {}',
      'README.md': '# My Project',
    })
  })

  // -----------------------------------------------------------------------
  // Multi-level fork chains
  // -----------------------------------------------------------------------

  describe('multi-level fork chains', () => {
    it('grandchild fork reads through two levels to root', () => {
      const child = new CopyOnWriteVFS(root, 'child')
      const grandchild = child.fork('grandchild')

      expect(grandchild.read('src/index.ts')).toBe('export const version = "1.0.0"')
      expect(grandchild.read('README.md')).toBe('# My Project')
    })

    it('grandchild overlay shadows child overlay which shadows root', () => {
      const child = new CopyOnWriteVFS(root, 'child')
      child.write('src/index.ts', 'child version')
      const grandchild = child.fork('grandchild')
      grandchild.write('src/index.ts', 'grandchild version')

      expect(grandchild.read('src/index.ts')).toBe('grandchild version')
      expect(child.read('src/index.ts')).toBe('child version')
      expect(root.read('src/index.ts')).toBe('export const version = "1.0.0"')
    })

    it('delete in child masks root; grandchild inherits the mask', () => {
      const child = new CopyOnWriteVFS(root, 'child')
      child.delete('README.md')
      const grandchild = child.fork('grandchild')

      expect(grandchild.read('README.md')).toBeNull()
      expect(grandchild.exists('README.md')).toBe(false)
    })

    it('grandchild can re-add file deleted in child', () => {
      const child = new CopyOnWriteVFS(root, 'child')
      child.delete('README.md')
      const grandchild = child.fork('grandchild')
      grandchild.write('README.md', 'Restored!')

      expect(grandchild.read('README.md')).toBe('Restored!')
      // child still has it deleted
      expect(child.read('README.md')).toBeNull()
    })

    it('file added in child is visible in grandchild', () => {
      const child = new CopyOnWriteVFS(root, 'child')
      child.write('src/new-module.ts', 'export const x = 1')
      const grandchild = child.fork('grandchild')

      expect(grandchild.read('src/new-module.ts')).toBe('export const x = 1')
      expect(grandchild.exists('src/new-module.ts')).toBe(true)
    })

    it('grandchild list includes files from all levels', () => {
      const child = new CopyOnWriteVFS(root, 'child')
      child.write('src/child-file.ts', 'child')
      child.delete('lib/helper.ts')

      const grandchild = child.fork('grandchild')
      grandchild.write('src/grand-file.ts', 'grand')

      const files = grandchild.list()
      expect(files).toContain('src/index.ts')       // from root
      expect(files).toContain('src/child-file.ts')   // from child
      expect(files).toContain('src/grand-file.ts')   // from grandchild
      expect(files).not.toContain('lib/helper.ts')   // deleted in child
    })
  })

  // -----------------------------------------------------------------------
  // Fork depth enforcement
  // -----------------------------------------------------------------------

  describe('fork depth enforcement', () => {
    it('depth 1 from VirtualFS parent', () => {
      const cow = new CopyOnWriteVFS(root)
      expect(cow.depth).toBe(1)
    })

    it('depth increments through the chain', () => {
      const d1 = new CopyOnWriteVFS(root)
      const d2 = d1.fork()
      const d3 = d2.fork()
      expect(d1.depth).toBe(1)
      expect(d2.depth).toBe(2)
      expect(d3.depth).toBe(3)
    })

    it('throws at depth 4', () => {
      const d1 = new CopyOnWriteVFS(root)
      const d2 = d1.fork()
      const d3 = d2.fork()
      expect(() => d3.fork()).toThrow(/Fork depth 4 exceeds maximum of 3/)
    })

    it('sibling forks at same depth do not affect each other depth', () => {
      const sibling1 = new CopyOnWriteVFS(root, 'sibling1')
      const sibling2 = new CopyOnWriteVFS(root, 'sibling2')
      expect(sibling1.depth).toBe(1)
      expect(sibling2.depth).toBe(1)
      // Both can still fork
      expect(sibling1.fork().depth).toBe(2)
      expect(sibling2.fork().depth).toBe(2)
    })
  })

  // -----------------------------------------------------------------------
  // Merge — advanced scenarios
  // -----------------------------------------------------------------------

  describe('merge — advanced scenarios', () => {
    it('merge with no changes is clean and merges nothing', () => {
      const fork = new CopyOnWriteVFS(root)
      const result = fork.merge()
      expect(result.clean).toBe(true)
      expect(result.merged).toHaveLength(0)
      expect(result.conflicts).toHaveLength(0)
    })

    it('merge applies new files to parent', () => {
      const fork = new CopyOnWriteVFS(root)
      fork.write('src/brand-new.ts', 'brand new')
      const result = fork.merge()

      expect(result.clean).toBe(true)
      expect(result.merged).toContain('src/brand-new.ts')
      expect(root.read('src/brand-new.ts')).toBe('brand new')
    })

    it('merge deletes files from parent', () => {
      const fork = new CopyOnWriteVFS(root)
      fork.delete('lib/helper.ts')
      const result = fork.merge()

      expect(result.clean).toBe(true)
      expect(result.merged).toContain('lib/helper.ts')
      expect(root.read('lib/helper.ts')).toBeNull()
    })

    it('merge with ours strategy keeps parent content on conflict', () => {
      const fork = new CopyOnWriteVFS(root)
      fork.write('src/config.ts', 'fork config')
      root.write('src/config.ts', 'parent updated config')

      const result = fork.merge('ours')
      expect(result.clean).toBe(true)
      expect(root.read('src/config.ts')).toBe('parent updated config')
    })

    it('merge with theirs strategy overwrites parent on conflict', () => {
      const fork = new CopyOnWriteVFS(root)
      fork.write('src/config.ts', 'fork config')
      root.write('src/config.ts', 'parent updated config')

      const result = fork.merge('theirs')
      expect(result.clean).toBe(true)
      expect(root.read('src/config.ts')).toBe('fork config')
    })

    it('merge with manual leaves conflicting files unresolved', () => {
      const fork = new CopyOnWriteVFS(root)
      fork.write('src/config.ts', 'fork config')
      fork.write('src/index.ts', 'fork index')
      root.write('src/config.ts', 'parent updated config')
      root.write('src/index.ts', 'parent updated index')

      const result = fork.merge('manual')
      expect(result.clean).toBe(false)
      expect(result.conflicts).toHaveLength(2)
      const conflictPaths = result.conflicts.map(c => c.path).sort()
      expect(conflictPaths).toEqual(['src/config.ts', 'src/index.ts'])
    })

    it('merge non-conflicting files even when some conflict in manual mode', () => {
      const fork = new CopyOnWriteVFS(root)
      fork.write('src/config.ts', 'fork config')
      fork.write('src/brand-new.ts', 'new file')
      root.write('src/config.ts', 'parent changed')

      const result = fork.merge('manual')
      expect(result.clean).toBe(false)
      // brand-new.ts should still be merged
      expect(result.merged).toContain('src/brand-new.ts')
      expect(root.read('src/brand-new.ts')).toBe('new file')
    })

    it('delete of non-existent-in-parent file during merge is a no-op', () => {
      const fork = new CopyOnWriteVFS(root)
      fork.write('tmp.ts', 'temp')
      fork.delete('tmp.ts')
      // tmp.ts was never in the parent, so delete should not add to merged
      const result = fork.merge()
      expect(result.merged).not.toContain('tmp.ts')
    })
  })

  // -----------------------------------------------------------------------
  // Conflict detection between sibling forks
  // -----------------------------------------------------------------------

  describe('conflict detection — extended', () => {
    it('no conflict when both forks modify different files', () => {
      const f1 = new CopyOnWriteVFS(root)
      const f2 = new CopyOnWriteVFS(root)
      f1.write('src/index.ts', 'f1')
      f2.write('src/utils.ts', 'f2')
      expect(f1.conflicts(f2)).toHaveLength(0)
    })

    it('conflict when one fork modifies and other deletes same file', () => {
      const f1 = new CopyOnWriteVFS(root)
      const f2 = new CopyOnWriteVFS(root)
      f1.write('src/index.ts', 'modified')
      f2.delete('src/index.ts')

      const conflicts = f1.conflicts(f2)
      expect(conflicts.length).toBeGreaterThanOrEqual(1)
      const pathConflict = conflicts.find(c => c.path === 'src/index.ts')
      expect(pathConflict).toBeDefined()
      expect(pathConflict!.childContent).toBe('') // deleted in f2
    })

    it('conflict when one fork deletes and other modifies same file (reverse)', () => {
      const f1 = new CopyOnWriteVFS(root)
      const f2 = new CopyOnWriteVFS(root)
      f1.delete('src/index.ts')
      f2.write('src/index.ts', 'f2 modified')

      const conflicts = f1.conflicts(f2)
      expect(conflicts.length).toBeGreaterThanOrEqual(1)
      const pathConflict = conflicts.find(c => c.path === 'src/index.ts')
      expect(pathConflict).toBeDefined()
      expect(pathConflict!.parentContent).toBe('') // deleted in f1
    })

    it('multiple conflicts across multiple files', () => {
      const f1 = new CopyOnWriteVFS(root)
      const f2 = new CopyOnWriteVFS(root)
      f1.write('src/index.ts', 'f1-idx')
      f1.write('src/config.ts', 'f1-cfg')
      f2.write('src/index.ts', 'f2-idx')
      f2.write('src/config.ts', 'f2-cfg')

      const conflicts = f1.conflicts(f2)
      expect(conflicts).toHaveLength(2)
    })

    it('no conflicts when both forks make identical changes', () => {
      const f1 = new CopyOnWriteVFS(root)
      const f2 = new CopyOnWriteVFS(root)
      f1.write('src/index.ts', 'same change')
      f2.write('src/index.ts', 'same change')

      expect(f1.conflicts(f2)).toHaveLength(0)
    })
  })

  // -----------------------------------------------------------------------
  // diff — edge cases
  // -----------------------------------------------------------------------

  describe('diff — edge cases', () => {
    it('writing empty string is still a modification', () => {
      const fork = new CopyOnWriteVFS(root)
      fork.write('src/index.ts', '')
      const d = fork.diff()
      expect(d.modified).toHaveLength(1)
      expect(d.modified[0]!.newContent).toBe('')
    })

    it('delete of a non-existent file does not appear in diff', () => {
      const fork = new CopyOnWriteVFS(root)
      fork.delete('non-existent.ts')
      const d = fork.diff()
      expect(d.deleted).toHaveLength(0)
    })

    it('diff after write-then-delete shows only the delete', () => {
      const fork = new CopyOnWriteVFS(root)
      fork.write('src/index.ts', 'changed')
      fork.delete('src/index.ts')
      const d = fork.diff()
      // File is deleted (was in parent), should be in deleted
      expect(d.deleted).toHaveLength(1)
      expect(d.deleted[0]!.path).toBe('src/index.ts')
      expect(d.modified).toHaveLength(0)
    })

    it('diff after delete-then-write shows a modification if content differs', () => {
      const fork = new CopyOnWriteVFS(root)
      fork.delete('src/index.ts')
      fork.write('src/index.ts', 'resurrected')
      const d = fork.diff()
      expect(d.deleted).toHaveLength(0)
      expect(d.modified).toHaveLength(1)
      expect(d.modified[0]!.newContent).toBe('resurrected')
    })
  })

  // -----------------------------------------------------------------------
  // Snapshot and detach — extended
  // -----------------------------------------------------------------------

  describe('toSnapshot — multi-level', () => {
    it('snapshot from grandchild includes all visible files', () => {
      const child = new CopyOnWriteVFS(root)
      child.write('src/child.ts', 'child')
      child.delete('README.md')
      const grandchild = child.fork()
      grandchild.write('src/grand.ts', 'grand')

      const snap = grandchild.toSnapshot()
      expect(snap['src/index.ts']).toBe('export const version = "1.0.0"')
      expect(snap['src/child.ts']).toBe('child')
      expect(snap['src/grand.ts']).toBe('grand')
      expect(snap['README.md']).toBeUndefined()
    })
  })

  describe('detach — independence', () => {
    it('detached VFS is fully independent from parent chain', () => {
      const child = new CopyOnWriteVFS(root)
      child.write('src/a.ts', 'a')
      const detached = child.detach()

      // Modify parent after detach
      root.write('src/index.ts', 'root changed')
      child.write('src/a.ts', 'child changed')

      expect(detached.read('src/index.ts')).toBe('export const version = "1.0.0"')
      expect(detached.read('src/a.ts')).toBe('a')
    })

    it('detached VFS has correct file count', () => {
      const fork = new CopyOnWriteVFS(root)
      fork.write('extra.ts', 'extra')
      fork.delete('README.md')

      const detached = fork.detach()
      expect(detached.size).toBe(5) // 5 original - 1 deleted + 1 added = 5
    })
  })

  // -----------------------------------------------------------------------
  // list with directory filtering
  // -----------------------------------------------------------------------

  describe('list — directory filtering edge cases', () => {
    it('filters with trailing slash', () => {
      const fork = new CopyOnWriteVFS(root)
      const srcFiles = fork.list('src/')
      expect(srcFiles).toContain('src/index.ts')
      expect(srcFiles).not.toContain('README.md')
    })

    it('returns empty array for non-matching directory', () => {
      const fork = new CopyOnWriteVFS(root)
      expect(fork.list('nonexistent')).toEqual([])
    })

    it('does not match partial directory names', () => {
      const fork = new CopyOnWriteVFS(root)
      fork.write('srcExtra/file.ts', 'content')
      const files = fork.list('src')
      expect(files).not.toContain('srcExtra/file.ts')
    })
  })

  // -----------------------------------------------------------------------
  // Size computation edge cases
  // -----------------------------------------------------------------------

  describe('size edge cases', () => {
    it('size with file overwrite in overlay does not double-count', () => {
      const fork = new CopyOnWriteVFS(root)
      fork.write('src/index.ts', 'overwritten')
      // Same file overwritten, size should remain the same as parent
      expect(fork.size).toBe(root.size)
    })

    it('size is zero on empty root with empty fork', () => {
      const emptyRoot = new VirtualFS()
      const fork = new CopyOnWriteVFS(emptyRoot)
      expect(fork.size).toBe(0)
    })
  })
})
