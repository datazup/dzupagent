/**
 * Multi-Modal Memory types — ECO-060.
 *
 * Defines attachment types and storage provider interface for
 * multi-modal memory (images, audio, video, documents).
 */

/** Supported attachment types. */
export type AttachmentType = 'image' | 'audio' | 'video' | 'document' | 'binary'

/** A memory attachment — references a stored binary asset. */
export interface MemoryAttachment {
  /** Unique attachment identifier. */
  id: string
  /** Type classification. */
  type: AttachmentType
  /** Storage URI (provider-specific, e.g., s3://..., file://..., mem://...). */
  uri: string
  /** MIME type of the attachment. */
  mimeType: string
  /** Human-readable description. */
  description?: string | undefined
  /** Size in bytes. */
  sizeBytes?: number | undefined
  /** When the attachment was created. */
  createdAt?: Date | undefined
}

/**
 * Provider interface for attachment binary storage.
 *
 * Implementations can target S3, GCS, local filesystem, or in-memory.
 */
export interface AttachmentStorageProvider {
  /**
   * Upload binary data and return a URI for later retrieval.
   */
  upload(
    data: Uint8Array,
    metadata: { mimeType: string; description?: string },
  ): Promise<string>

  /**
   * Get a download URL/URI for an attachment.
   * May return a signed URL for cloud storage.
   */
  getDownloadUrl(uri: string): Promise<string>

  /**
   * Delete an attachment by URI.
   */
  delete(uri: string): Promise<void>
}

/**
 * Infer attachment type from MIME type string.
 */
export function inferAttachmentType(mimeType: string): AttachmentType {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('audio/')) return 'audio'
  if (mimeType.startsWith('video/')) return 'video'
  if (
    mimeType.startsWith('application/pdf') ||
    mimeType.startsWith('application/msword') ||
    mimeType.startsWith('application/vnd.') ||
    mimeType.startsWith('text/')
  ) {
    return 'document'
  }
  return 'binary'
}
