/**
 * Memory encryption — at-rest encryption for memory records using AES-256-GCM.
 */
export type {
  EncryptedEnvelope,
  EncryptionKeyDescriptor,
  EncryptionKeyProvider,
} from './types.js'

export { EnvKeyProvider } from './env-key-provider.js'

export { EncryptedMemoryService } from './encrypted-memory-service.js'
export type { EncryptedMemoryServiceConfig } from './encrypted-memory-service.js'
