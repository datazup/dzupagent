/**
 * Types for at-rest encryption of memory records.
 */

/** Encrypted value envelope stored alongside plaintext search fields. */
export interface EncryptedEnvelope {
  /** Marker indicating this value is encrypted */
  _encrypted: true
  /** Encryption algorithm used */
  algorithm: 'aes-256-gcm'
  /** ID of the encryption key */
  keyId: string
  /** Base64-encoded ciphertext */
  ciphertext: string
  /** Base64-encoded initialization vector */
  iv: string
  /** Base64-encoded authentication tag */
  authTag: string
}

/** Descriptor for a single encryption key. */
export interface EncryptionKeyDescriptor {
  keyId: string
  /** 256-bit key as Buffer */
  key: Buffer
  status: 'active' | 'rotated' | 'revoked'
  createdAt: Date
}

/** Provider that resolves encryption keys by ID or returns the active key. */
export interface EncryptionKeyProvider {
  /** Get a specific key by ID */
  getKey(keyId: string): Promise<EncryptionKeyDescriptor | undefined>
  /** Get the current active key for encryption */
  getActiveKey(): Promise<EncryptionKeyDescriptor | undefined>
  /** List all available keys */
  listKeys(): Promise<EncryptionKeyDescriptor[]>
}
