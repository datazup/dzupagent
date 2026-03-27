/**
 * MultiModalMemoryService — ECO-060.
 *
 * Extends MemoryService with attachment support (images, audio, documents).
 * Attachments are stored via an AttachmentStorageProvider and referenced
 * in the memory record's metadata.
 *
 * When no storageProvider is supplied, an in-memory Map is used.
 *
 * @example
 * ```ts
 * const mmService = new MultiModalMemoryService({ memoryService })
 *
 * await mmService.putWithAttachment(
 *   'observations', 'screenshot-1',
 *   { text: 'User reported UI issue' },
 *   { data: pngBytes, mimeType: 'image/png', description: 'Screenshot' },
 * )
 *
 * const attachments = await mmService.getAttachments('observations', 'screenshot-1')
 * ```
 */

import { randomUUID } from 'node:crypto'
import type { MemoryService } from '../memory-service.js'
import type { AttachmentStorageProvider, MemoryAttachment } from './types.js'
import { inferAttachmentType } from './types.js'

// ------------------------------------------------------------------ In-Memory Provider

/**
 * In-memory attachment storage. Uses a Map<uri, Uint8Array> for
 * testing and development. Not suitable for production.
 */
export class InMemoryAttachmentStorage implements AttachmentStorageProvider {
  private readonly _store = new Map<string, { data: Uint8Array; mimeType: string; description?: string }>()

  async upload(
    data: Uint8Array,
    metadata: { mimeType: string; description?: string },
  ): Promise<string> {
    const uri = `mem://${randomUUID()}`
    this._store.set(uri, { data, mimeType: metadata.mimeType, description: metadata.description })
    return uri
  }

  async getDownloadUrl(uri: string): Promise<string> {
    if (!this._store.has(uri)) {
      throw new Error(`Attachment not found: ${uri}`)
    }
    return uri
  }

  async delete(uri: string): Promise<void> {
    this._store.delete(uri)
  }

  /** For testing: get raw data by URI. */
  getData(uri: string): Uint8Array | undefined {
    return this._store.get(uri)?.data
  }

  /** For testing: get count of stored attachments. */
  get size(): number {
    return this._store.size
  }
}

// ------------------------------------------------------------------ Config

export interface MultiModalMemoryServiceConfig {
  /** Underlying MemoryService for storing record metadata. */
  memoryService: MemoryService
  /** Storage provider for binary attachment data. Defaults to InMemoryAttachmentStorage. */
  storageProvider?: AttachmentStorageProvider
}

// ------------------------------------------------------------------ Service

export class MultiModalMemoryService {
  private readonly _memoryService: MemoryService
  private readonly _storageProvider: AttachmentStorageProvider

  /** Fallback storage for attachment metadata when MemoryService put fails. */
  private readonly _attachmentIndex = new Map<string, MemoryAttachment[]>()

  constructor(config: MultiModalMemoryServiceConfig) {
    this._memoryService = config.memoryService
    this._storageProvider = config.storageProvider ?? new InMemoryAttachmentStorage()
  }

  /**
   * Store a memory record with an attached binary (image, audio, etc.).
   *
   * The binary is uploaded to the storage provider, and the resulting
   * URI is stored as an attachment reference in the memory record.
   */
  async putWithAttachment(
    namespace: string,
    key: string,
    value: Record<string, unknown>,
    attachment: {
      data: Uint8Array
      mimeType: string
      description?: string
    },
  ): Promise<void> {
    // Upload binary
    const uri = await this._storageProvider.upload(attachment.data, {
      mimeType: attachment.mimeType,
      description: attachment.description,
    })

    // Build attachment metadata
    const att: MemoryAttachment = {
      id: randomUUID(),
      type: inferAttachmentType(attachment.mimeType),
      uri,
      mimeType: attachment.mimeType,
      description: attachment.description,
      sizeBytes: attachment.data.length,
      createdAt: new Date(),
    }

    // Get existing attachments
    const existing = await this._getAttachmentsInternal(namespace, key)
    const updated = [...existing, att]

    // Store attachment index
    const indexKey = `${namespace}:${key}`
    this._attachmentIndex.set(indexKey, updated)

    // Store the record value with attachment reference
    const enrichedValue = {
      ...value,
      _attachments: updated.map((a) => ({
        id: a.id,
        type: a.type,
        uri: a.uri,
        mimeType: a.mimeType,
        description: a.description,
        sizeBytes: a.sizeBytes,
      })),
    }

    try {
      await this._memoryService.put(namespace, {}, key, enrichedValue)
    } catch {
      // Non-fatal — attachment index is maintained in-memory
    }
  }

  /**
   * Get all attachments for a memory record.
   */
  async getAttachments(namespace: string, key: string): Promise<MemoryAttachment[]> {
    return this._getAttachmentsInternal(namespace, key)
  }

  /**
   * Remove a specific attachment by ID.
   */
  async removeAttachment(namespace: string, key: string, attachmentId: string): Promise<void> {
    const existing = await this._getAttachmentsInternal(namespace, key)
    const target = existing.find((a) => a.id === attachmentId)

    if (!target) return

    // Delete from storage provider
    try {
      await this._storageProvider.delete(target.uri)
    } catch {
      // Non-fatal
    }

    // Update index
    const updated = existing.filter((a) => a.id !== attachmentId)
    const indexKey = `${namespace}:${key}`
    this._attachmentIndex.set(indexKey, updated)
  }

  /**
   * Get a download URL for an attachment.
   */
  async getAttachmentUrl(uri: string): Promise<string> {
    return this._storageProvider.getDownloadUrl(uri)
  }

  // --- Private ---

  private async _getAttachmentsInternal(namespace: string, key: string): Promise<MemoryAttachment[]> {
    const indexKey = `${namespace}:${key}`
    const cached = this._attachmentIndex.get(indexKey)
    if (cached) return cached

    // Try to read from memory service
    try {
      const records = await this._memoryService.get(namespace, {})
      for (const record of records) {
        const val = record.value as Record<string, unknown>
        if (val['_attachments'] && Array.isArray(val['_attachments'])) {
          const attachments = val['_attachments'] as MemoryAttachment[]
          this._attachmentIndex.set(indexKey, attachments)
          return attachments
        }
      }
    } catch {
      // Non-fatal
    }

    return []
  }
}
