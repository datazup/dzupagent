import { describe, it, expect, vi, beforeEach } from 'vitest'
import { VirtualFS } from '../vfs/virtual-fs.js'
import { saveSnapshot, loadSnapshot, type SnapshotStore } from '../vfs/vfs-snapshot.js'

// ---------------------------------------------------------------------------
// VirtualFS
// ---------------------------------------------------------------------------

describe('VirtualFS', () => {
  let vfs: VirtualFS

  beforeEach(() => {
    vfs = new VirtualFS()
  })

  describe('write and read', () => {
    it('should write and read a file', () => {
      vfs.write('src/index.ts', 'export const x = 1')
      expect(vfs.read('src/index.ts')).toBe('export const x = 1')
    })

    it('should return null for non-existent file', () => {
      expect(vfs.read('missing.ts')).toBeNull()
    })

    it('should overwrite existing file', () => {
      vfs.write('file.ts', 'v1')
      vfs.write('file.ts', 'v2')
      expect(vfs.read('file.ts')).toBe('v2')
    })

    it('should handle empty content', () => {
      vfs.write('empty.ts', '')
      expect(vfs.read('empty.ts')).toBe('')
    })

    it('should handle unicode content', () => {
      const content = 'const greeting = "Hej verden! \u{1F44B}"'
      vfs.write('unicode.ts', content)
      expect(vfs.read('unicode.ts')).toBe(content)
    })
  })

  describe('exists', () => {
    it('should return true for existing file', () => {
      vfs.write('a.ts', 'content')
      expect(vfs.exists('a.ts')).toBe(true)
    })

    it('should return false for missing file', () => {
      expect(vfs.exists('a.ts')).toBe(false)
    })
  })

  describe('delete', () => {
    it('should delete an existing file', () => {
      vfs.write('a.ts', 'content')
      const result = vfs.delete('a.ts')
      expect(result).toBe(true)
      expect(vfs.exists('a.ts')).toBe(false)
    })

    it('should return false when deleting non-existent file', () => {
      expect(vfs.delete('nope.ts')).toBe(false)
    })
  })

  describe('list', () => {
    it('should list all files sorted', () => {
      vfs.write('c.ts', '')
      vfs.write('a.ts', '')
      vfs.write('b.ts', '')
      expect(vfs.list()).toEqual(['a.ts', 'b.ts', 'c.ts'])
    })

    it('should filter by directory prefix', () => {
      vfs.write('src/a.ts', '')
      vfs.write('src/b.ts', '')
      vfs.write('test/c.ts', '')
      expect(vfs.list('src')).toEqual(['src/a.ts', 'src/b.ts'])
    })

    it('should handle trailing slash in directory prefix', () => {
      vfs.write('src/a.ts', '')
      vfs.write('src/b.ts', '')
      expect(vfs.list('src/')).toEqual(['src/a.ts', 'src/b.ts'])
    })

    it('should return empty array for empty VFS', () => {
      expect(vfs.list()).toEqual([])
    })

    it('should return empty array for non-matching directory', () => {
      vfs.write('src/a.ts', '')
      expect(vfs.list('lib')).toEqual([])
    })
  })

  describe('size', () => {
    it('should return 0 for empty VFS', () => {
      expect(vfs.size).toBe(0)
    })

    it('should track number of files', () => {
      vfs.write('a.ts', '')
      vfs.write('b.ts', '')
      expect(vfs.size).toBe(2)
    })

    it('should decrease after delete', () => {
      vfs.write('a.ts', '')
      vfs.write('b.ts', '')
      vfs.delete('a.ts')
      expect(vfs.size).toBe(1)
    })
  })

  describe('toSnapshot / fromSnapshot', () => {
    it('should export as plain Record', () => {
      vfs.write('a.ts', 'aaa')
      vfs.write('b.ts', 'bbb')
      const snap = vfs.toSnapshot()
      expect(snap).toEqual({ 'a.ts': 'aaa', 'b.ts': 'bbb' })
    })

    it('should restore from snapshot', () => {
      const snap = { 'x.ts': 'xxx', 'y.ts': 'yyy' }
      const restored = VirtualFS.fromSnapshot(snap)
      expect(restored.read('x.ts')).toBe('xxx')
      expect(restored.read('y.ts')).toBe('yyy')
      expect(restored.size).toBe(2)
    })

    it('should create independent copy', () => {
      vfs.write('a.ts', 'original')
      const snap = vfs.toSnapshot()
      snap['a.ts'] = 'mutated'
      expect(vfs.read('a.ts')).toBe('original')
    })
  })

  describe('constructor with initial data', () => {
    it('should accept initial files', () => {
      const vfs2 = new VirtualFS({ 'a.ts': 'aaa', 'b.ts': 'bbb' })
      expect(vfs2.read('a.ts')).toBe('aaa')
      expect(vfs2.size).toBe(2)
    })
  })

  describe('diff', () => {
    it('should detect added files', () => {
      const other = new VirtualFS({ 'new.ts': 'content' })
      const diffs = vfs.diff(other)

      expect(diffs).toHaveLength(1)
      expect(diffs[0]).toMatchObject({
        path: 'new.ts',
        type: 'added',
        newContent: 'content',
      })
    })

    it('should detect modified files', () => {
      vfs.write('file.ts', 'old')
      const other = new VirtualFS({ 'file.ts': 'new' })
      const diffs = vfs.diff(other)

      expect(diffs).toHaveLength(1)
      expect(diffs[0]).toMatchObject({
        path: 'file.ts',
        type: 'modified',
        oldContent: 'old',
        newContent: 'new',
      })
    })

    it('should detect deleted files', () => {
      vfs.write('gone.ts', 'was here')
      const other = new VirtualFS()
      const diffs = vfs.diff(other)

      expect(diffs).toHaveLength(1)
      expect(diffs[0]).toMatchObject({
        path: 'gone.ts',
        type: 'deleted',
        oldContent: 'was here',
      })
    })

    it('should not report unchanged files', () => {
      vfs.write('same.ts', 'unchanged')
      const other = new VirtualFS({ 'same.ts': 'unchanged' })
      const diffs = vfs.diff(other)
      expect(diffs).toHaveLength(0)
    })

    it('should handle complex diff with multiple change types', () => {
      vfs.write('kept.ts', 'same')
      vfs.write('modified.ts', 'v1')
      vfs.write('deleted.ts', 'removed')

      const other = new VirtualFS({
        'kept.ts': 'same',
        'modified.ts': 'v2',
        'added.ts': 'brand new',
      })

      const diffs = vfs.diff(other)
      const types = new Set(diffs.map(d => d.type))

      expect(types).toContain('added')
      expect(types).toContain('modified')
      expect(types).toContain('deleted')
      expect(diffs).toHaveLength(3)
    })

    it('should return empty diff for identical VFS instances', () => {
      vfs.write('a.ts', 'content')
      const other = new VirtualFS({ 'a.ts': 'content' })
      expect(vfs.diff(other)).toEqual([])
    })
  })

  describe('merge', () => {
    it('should merge files from another VFS (last-write-wins)', () => {
      vfs.write('a.ts', 'original')
      const other = new VirtualFS({ 'a.ts': 'overwritten', 'b.ts': 'new' })
      vfs.merge(other)

      expect(vfs.read('a.ts')).toBe('overwritten')
      expect(vfs.read('b.ts')).toBe('new')
    })

    it('should preserve existing files not in source', () => {
      vfs.write('existing.ts', 'kept')
      const other = new VirtualFS({ 'new.ts': 'added' })
      vfs.merge(other)

      expect(vfs.read('existing.ts')).toBe('kept')
      expect(vfs.read('new.ts')).toBe('added')
    })

    it('should handle merging empty VFS', () => {
      vfs.write('a.ts', 'content')
      const other = new VirtualFS()
      vfs.merge(other)
      expect(vfs.size).toBe(1)
    })
  })
})

// ---------------------------------------------------------------------------
// VFS Snapshot (saveSnapshot / loadSnapshot)
// ---------------------------------------------------------------------------

describe('VFS Snapshot', () => {
  let mockStore: SnapshotStore

  beforeEach(() => {
    mockStore = {
      save: vi.fn().mockResolvedValue(undefined),
      load: vi.fn().mockResolvedValue(null),
    }
  })

  describe('saveSnapshot', () => {
    it('should call store.save with correct arguments', async () => {
      const data = { 'a.ts': 'content' }
      const result = await saveSnapshot(mockStore, 'gen-123', 'gen_backend', data)

      expect(mockStore.save).toHaveBeenCalledWith('gen-123', 'gen_backend', data)
      expect(result.success).toBe(true)
    })

    it('should return error result on failure (non-fatal)', async () => {
      vi.mocked(mockStore.save).mockRejectedValue(new Error('DB down'))

      const result = await saveSnapshot(mockStore, 'id', 'phase', {})
      expect(result.success).toBe(false)
      expect(result.error).toBe('DB down')
    })
  })

  describe('loadSnapshot', () => {
    it('should return stored data', async () => {
      const stored = { 'a.ts': 'content' }
      vi.mocked(mockStore.load).mockResolvedValue(stored)

      const result = await loadSnapshot(mockStore, 'gen-123', 'gen_backend')
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toEqual(stored)
      }
    })

    it('should return not_found when not found', async () => {
      vi.mocked(mockStore.load).mockResolvedValue(null)
      const result = await loadSnapshot(mockStore, 'id', 'phase')
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe('not_found')
      }
    })

    it('should return error on failure (non-fatal)', async () => {
      vi.mocked(mockStore.load).mockRejectedValue(new Error('DB down'))
      const result = await loadSnapshot(mockStore, 'id', 'phase')
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe('DB down')
      }
    })
  })
})
