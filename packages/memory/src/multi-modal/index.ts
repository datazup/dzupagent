/**
 * Multi-Modal Memory — barrel exports.
 */
export type {
  AttachmentType,
  MemoryAttachment,
  AttachmentStorageProvider,
} from './types.js'
export { inferAttachmentType } from './types.js'

export { MultiModalMemoryService, InMemoryAttachmentStorage } from './multi-modal-memory-service.js'
export type { MultiModalMemoryServiceConfig } from './multi-modal-memory-service.js'
