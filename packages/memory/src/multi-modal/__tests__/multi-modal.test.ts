import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MultiModalMemoryService, InMemoryAttachmentStorage } from '../multi-modal-memory-service.js'
import { inferAttachmentType } from '../types.js'
import type { MemoryService } from '../../memory-service.js'

// --- Mock MemoryService ---

function createMockMemoryService(): MemoryService {
  const store = new Map<string, Record<string, unknown>>()

  return {
    put: vi.fn(async (_ns: string, _scope: Record<string, string>, key: string, value: Record<string, unknown>) => {
      store.set(key, value)
    }),
    get: vi.fn(async () => {
      return [...store.values()].map((value) => ({
        value,
        key: 'test-key',
        namespace: ['test'],
        createdAt: new Date(),
        updatedAt: new Date(),
      }))
    }),
    search: vi.fn(async () => []),
    format: vi.fn(() => ''),
    formatAll: vi.fn(() => ''),
  } as unknown as MemoryService
}

// --- Tests ---

describe('inferAttachmentType', () => {
  it('detects image types', () => {
    expect(inferAttachmentType('image/png')).toBe('image')
    expect(inferAttachmentType('image/jpeg')).toBe('image')
  })

  it('detects audio types', () => {
    expect(inferAttachmentType('audio/mp3')).toBe('audio')
    expect(inferAttachmentType('audio/wav')).toBe('audio')
  })

  it('detects video types', () => {
    expect(inferAttachmentType('video/mp4')).toBe('video')
  })

  it('detects document types', () => {
    expect(inferAttachmentType('application/pdf')).toBe('document')
    expect(inferAttachmentType('text/plain')).toBe('document')
    expect(inferAttachmentType('application/msword')).toBe('document')
  })

  it('defaults to binary for unknown types', () => {
    expect(inferAttachmentType('application/octet-stream')).toBe('binary')
  })
})

describe('InMemoryAttachmentStorage', () => {
  it('uploads and retrieves data', async () => {
    const storage = new InMemoryAttachmentStorage()
    const data = new Uint8Array([1, 2, 3, 4])

    const uri = await storage.upload(data, { mimeType: 'image/png' })
    expect(uri).toMatch(/^mem:\/\//)

    const url = await storage.getDownloadUrl(uri)
    expect(url).toBe(uri)

    const retrieved = storage.getData(uri)
    expect(retrieved).toEqual(data)
  })

  it('deletes data', async () => {
    const storage = new InMemoryAttachmentStorage()
    const data = new Uint8Array([1, 2, 3])
    const uri = await storage.upload(data, { mimeType: 'image/png' })

    expect(storage.size).toBe(1)
    await storage.delete(uri)
    expect(storage.size).toBe(0)
  })

  it('throws on getDownloadUrl for non-existent URI', async () => {
    const storage = new InMemoryAttachmentStorage()
    await expect(storage.getDownloadUrl('mem://non-existent')).rejects.toThrow()
  })
})

describe('MultiModalMemoryService', () => {
  let memoryService: MemoryService
  let mmService: MultiModalMemoryService

  beforeEach(() => {
    memoryService = createMockMemoryService()
    mmService = new MultiModalMemoryService({ memoryService })
  })

  it('stores a record with attachment', async () => {
    const data = new Uint8Array([10, 20, 30])

    await mmService.putWithAttachment(
      'observations',
      'key-1',
      { text: 'Test observation' },
      { data, mimeType: 'image/png', description: 'Screenshot' },
    )

    // Verify put was called with enriched value
    expect(memoryService.put).toHaveBeenCalled()
    const callArgs = (memoryService.put as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[]
    const storedValue = callArgs[3] as Record<string, unknown>
    expect(storedValue['text']).toBe('Test observation')
    expect(storedValue['_attachments']).toBeDefined()
    const attachments = storedValue['_attachments'] as Array<Record<string, unknown>>
    expect(attachments.length).toBe(1)
    expect(attachments[0]!['type']).toBe('image')
    expect(attachments[0]!['mimeType']).toBe('image/png')
    expect(attachments[0]!['sizeBytes']).toBe(3)
  })

  it('retrieves attachments after storing', async () => {
    const data = new Uint8Array([1, 2, 3])

    await mmService.putWithAttachment(
      'observations',
      'key-1',
      { text: 'Test' },
      { data, mimeType: 'image/jpeg', description: 'Photo' },
    )

    const attachments = await mmService.getAttachments('observations', 'key-1')
    expect(attachments.length).toBe(1)
    expect(attachments[0]!.type).toBe('image')
    expect(attachments[0]!.mimeType).toBe('image/jpeg')
    expect(attachments[0]!.description).toBe('Photo')
  })

  it('removes an attachment', async () => {
    const data = new Uint8Array([1, 2, 3])

    await mmService.putWithAttachment(
      'observations',
      'key-1',
      { text: 'Test' },
      { data, mimeType: 'image/png' },
    )

    const before = await mmService.getAttachments('observations', 'key-1')
    expect(before.length).toBe(1)
    const attachmentId = before[0]!.id

    await mmService.removeAttachment('observations', 'key-1', attachmentId)

    const after = await mmService.getAttachments('observations', 'key-1')
    expect(after.length).toBe(0)
  })

  it('handles multiple attachments on the same key', async () => {
    await mmService.putWithAttachment(
      'observations', 'key-1',
      { text: 'Test' },
      { data: new Uint8Array([1]), mimeType: 'image/png' },
    )

    await mmService.putWithAttachment(
      'observations', 'key-1',
      { text: 'Test updated' },
      { data: new Uint8Array([2, 3]), mimeType: 'audio/mp3' },
    )

    const attachments = await mmService.getAttachments('observations', 'key-1')
    expect(attachments.length).toBe(2)
    expect(attachments[0]!.type).toBe('image')
    expect(attachments[1]!.type).toBe('audio')
  })

  it('removeAttachment is no-op for non-existent ID', async () => {
    // Should not throw
    await mmService.removeAttachment('observations', 'key-1', 'non-existent')
  })

  it('uses custom storage provider', async () => {
    const customStorage = new InMemoryAttachmentStorage()
    const customService = new MultiModalMemoryService({
      memoryService,
      storageProvider: customStorage,
    })

    await customService.putWithAttachment(
      'observations', 'key-1',
      { text: 'Test' },
      { data: new Uint8Array([1, 2]), mimeType: 'application/pdf' },
    )

    expect(customStorage.size).toBe(1)
  })

  it('getAttachmentUrl delegates to storage provider', async () => {
    await mmService.putWithAttachment(
      'observations', 'key-1',
      { text: 'Test' },
      { data: new Uint8Array([1]), mimeType: 'image/png' },
    )

    const attachments = await mmService.getAttachments('observations', 'key-1')
    const url = await mmService.getAttachmentUrl(attachments[0]!.uri)
    expect(url).toBe(attachments[0]!.uri)
  })
})
