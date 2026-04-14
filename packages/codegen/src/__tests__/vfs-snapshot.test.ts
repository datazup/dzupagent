import { describe, it, expect, vi, beforeEach } from 'vitest'
import { saveSnapshot, loadSnapshot, type SnapshotStore } from '../vfs/vfs-snapshot.js'

describe('VFS Snapshot', () => {
  let mockStore: SnapshotStore

  beforeEach(() => {
    mockStore = {
      save: vi.fn().mockResolvedValue(undefined),
      load: vi.fn().mockResolvedValue(null),
    }
  })

  describe('saveSnapshot', () => {
    it('returns success result', async () => {
      const data = { 'a.ts': 'const a = 1;' }
      const result = await saveSnapshot(mockStore, 'snap-1', 'gen_backend', data)

      expect(result.success).toBe(true)
      expect(result.id).toBe('snap-1')
      expect(result.phase).toBe('gen_backend')
      expect(result.error).toBeUndefined()
      expect(mockStore.save).toHaveBeenCalledWith('snap-1', 'gen_backend', data)
    })

    it('returns error result on failure', async () => {
      vi.mocked(mockStore.save).mockRejectedValue(new Error('connection refused'))

      const result = await saveSnapshot(mockStore, 'snap-2', 'phase', { 'b.ts': '' })

      expect(result.success).toBe(false)
      expect(result.error).toBe('connection refused')
      expect(result.id).toBeUndefined()
    })

    it('returns stringified error for non-Error throws', async () => {
      vi.mocked(mockStore.save).mockRejectedValue('raw string error')

      const result = await saveSnapshot(mockStore, 'id', 'phase', {})

      expect(result.success).toBe(false)
      expect(result.error).toBe('raw string error')
    })
  })

  describe('loadSnapshot', () => {
    it('returns success result with data', async () => {
      const stored = { 'main.ts': 'export default {}' }
      vi.mocked(mockStore.load).mockResolvedValue(stored)

      const result = await loadSnapshot(mockStore, 'snap-1', 'gen_backend')

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toEqual(stored)
      }
    })

    it('returns error for missing file (not_found)', async () => {
      vi.mocked(mockStore.load).mockResolvedValue(null)

      const result = await loadSnapshot(mockStore, 'missing', 'phase')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe('not_found')
      }
    })

    it('returns error result on store failure', async () => {
      vi.mocked(mockStore.load).mockRejectedValue(new Error('timeout'))

      const result = await loadSnapshot(mockStore, 'id', 'phase')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe('timeout')
      }
    })

    it('returns stringified error for non-Error throws', async () => {
      vi.mocked(mockStore.load).mockRejectedValue(42)

      const result = await loadSnapshot(mockStore, 'id', 'phase')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe('42')
      }
    })
  })
})
