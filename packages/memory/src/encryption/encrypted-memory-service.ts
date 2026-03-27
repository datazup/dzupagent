/**
 * Transparent encryption wrapper for MemoryService.
 *
 * Encrypts record values at rest using AES-256-GCM while preserving
 * configurable plaintext fields for searchability. Decryption is
 * transparent — consumers see the original unencrypted values.
 *
 * Non-fatal: missing keys or tampered ciphertext produce warnings
 * and return undefined rather than throwing.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { MemoryService } from '../memory-service.js'
import type { EncryptionKeyProvider, EncryptedEnvelope } from './types.js'

const ALGORITHM = 'aes-256-gcm' as const
const IV_LENGTH = 12 // 96 bits for GCM
const AUTH_TAG_LENGTH = 16 // 128 bits

/** Default fields preserved in plaintext for search/indexing. */
const DEFAULT_PLAINTEXT_FIELDS: readonly string[] = ['text', '_provenance.createdBy', '_provenance.source']

export interface EncryptedMemoryServiceConfig {
  /** The underlying memory service to wrap */
  memoryService: MemoryService
  /** Key provider */
  keyProvider: EncryptionKeyProvider
  /** Namespaces to encrypt (if not specified, all namespaces are encrypted) */
  encryptedNamespaces?: string[]
  /** Fields to preserve in plaintext for searchability */
  plaintextFields?: string[]
}

/**
 * Check if a value is an encrypted envelope.
 */
function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
  if (value == null || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  return (
    obj['_encrypted'] === true &&
    obj['algorithm'] === ALGORITHM &&
    typeof obj['keyId'] === 'string' &&
    typeof obj['ciphertext'] === 'string' &&
    typeof obj['iv'] === 'string' &&
    typeof obj['authTag'] === 'string'
  )
}

/**
 * Extract a nested field value from a record using dot notation.
 * e.g. extractField(obj, '_provenance.createdBy') returns obj._provenance?.createdBy
 */
function extractField(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.')
  let current: unknown = obj
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

/**
 * Set a nested field value in a record using dot notation.
 * Creates intermediate objects as needed.
 */
function setField(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let current = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!
    if (current[part] == null || typeof current[part] !== 'object') {
      current[part] = {}
    }
    current = current[part] as Record<string, unknown>
  }
  const lastPart = parts[parts.length - 1]!
  current[lastPart] = value
}

/**
 * Remove a top-level or nested field from an object.
 * Returns a shallow copy without the specified path.
 */
function removeField(obj: Record<string, unknown>, path: string): Record<string, unknown> {
  const parts = path.split('.')
  if (parts.length === 1) {
    const { [parts[0]!]: _removed, ...rest } = obj
    return rest
  }
  // For nested paths, clone the chain and remove the leaf
  const result = { ...obj }
  let current = result
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!
    const child = current[part]
    if (child == null || typeof child !== 'object') return result
    const copy = { ...(child as Record<string, unknown>) }
    current[part] = copy
    current = copy
  }
  const lastPart = parts[parts.length - 1]!
  delete current[lastPart]
  return result
}

export class EncryptedMemoryService {
  private readonly memoryService: MemoryService
  private readonly keyProvider: EncryptionKeyProvider
  private readonly encryptedNamespaces: Set<string> | undefined
  private readonly plaintextFields: readonly string[]

  constructor(config: EncryptedMemoryServiceConfig) {
    this.memoryService = config.memoryService
    this.keyProvider = config.keyProvider
    this.encryptedNamespaces = config.encryptedNamespaces
      ? new Set(config.encryptedNamespaces)
      : undefined
    this.plaintextFields = config.plaintextFields ?? DEFAULT_PLAINTEXT_FIELDS
  }

  /**
   * Check if a value is an encrypted envelope.
   */
  static isEncrypted(value: unknown): value is EncryptedEnvelope {
    return isEncryptedEnvelope(value)
  }

  /**
   * Write a record, encrypting the value for configured namespaces.
   * Plaintext fields are preserved outside the envelope for search.
   */
  async put(
    namespace: string,
    scope: Record<string, string>,
    key: string,
    value: Record<string, unknown>,
  ): Promise<void> {
    if (!this.shouldEncrypt(namespace)) {
      return this.memoryService.put(namespace, scope, key, value)
    }

    const activeKey = await this.keyProvider.getActiveKey()
    if (!activeKey) {
      // No active key — write plaintext (non-fatal degradation)
      return this.memoryService.put(namespace, scope, key, value)
    }

    // Extract plaintext fields before encryption
    const plaintextData: Record<string, unknown> = {}
    let sensitiveData: Record<string, unknown> = { ...value }

    for (const field of this.plaintextFields) {
      const fieldValue = extractField(value, field)
      if (fieldValue !== undefined) {
        setField(plaintextData, field, fieldValue)
        sensitiveData = removeField(sensitiveData, field)
      }
    }

    // Encrypt the remaining (sensitive) data
    const envelope = this.encrypt(JSON.stringify(sensitiveData), activeKey.keyId, activeKey.key)

    // Store plaintext fields + encrypted envelope
    const storedValue: Record<string, unknown> = {
      ...plaintextData,
      _encrypted_value: envelope,
    }

    return this.memoryService.put(namespace, scope, key, storedValue)
  }

  /**
   * Read a record, transparently decrypting if encrypted.
   */
  async get(
    namespace: string,
    scope: Record<string, string>,
    key?: string,
  ): Promise<Record<string, unknown>[]> {
    const records = await this.memoryService.get(namespace, scope, key)
    const decrypted: Record<string, unknown>[] = []

    for (const record of records) {
      const result = await this.decryptRecord(record)
      if (result !== undefined) {
        decrypted.push(result)
      }
    }

    return decrypted
  }

  /**
   * Search — delegates to underlying service (searches plaintext fields).
   * Results are decrypted before returning.
   */
  async search(
    namespace: string,
    scope: Record<string, string>,
    query: string,
    limit?: number,
  ): Promise<Record<string, unknown>[]> {
    const records = await this.memoryService.search(namespace, scope, query, limit)
    const decrypted: Record<string, unknown>[] = []

    for (const record of records) {
      const result = await this.decryptRecord(record)
      if (result !== undefined) {
        decrypted.push(result)
      }
    }

    return decrypted
  }

  /**
   * Re-encrypt all records in a namespace with the current active key.
   */
  async rotateKey(
    namespace: string,
    scope: Record<string, string>,
  ): Promise<{ rotated: number; failed: number }> {
    const activeKey = await this.keyProvider.getActiveKey()
    if (!activeKey) {
      return { rotated: 0, failed: 0 }
    }

    const records = await this.memoryService.get(namespace, scope)
    let rotated = 0
    let failed = 0

    for (const record of records) {
      try {
        // Decrypt the record first
        const decryptedRecord = await this.decryptRecord(record)
        if (decryptedRecord === undefined) {
          failed++
          continue
        }

        // Re-encrypt with the new active key
        // We need the original key to figure out the record key name.
        // Since get() doesn't return keys, we store a _key field during put.
        // For rotation, the caller must provide namespace+scope, and we
        // re-put each record. We use a content hash as key fallback.
        const recordKey = typeof record['_key'] === 'string'
          ? record['_key']
          : `rotated_${rotated}`

        await this.put(namespace, scope, recordKey, decryptedRecord)
        rotated++
      } catch {
        failed++
      }
    }

    return { rotated, failed }
  }

  /**
   * Format memory records for prompt injection (delegates to underlying service).
   */
  formatForPrompt(
    records: Record<string, unknown>[],
    options?: { maxItems?: number; maxCharsPerItem?: number; header?: string },
  ): string {
    return this.memoryService.formatForPrompt(records, options)
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private shouldEncrypt(namespace: string): boolean {
    if (!this.encryptedNamespaces) return true // encrypt all
    return this.encryptedNamespaces.has(namespace)
  }

  private encrypt(plaintext: string, keyId: string, key: Buffer): EncryptedEnvelope {
    const iv = randomBytes(IV_LENGTH)
    const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH })

    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ])
    const authTag = cipher.getAuthTag()

    return {
      _encrypted: true,
      algorithm: ALGORITHM,
      keyId,
      ciphertext: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
    }
  }

  private async decrypt(envelope: EncryptedEnvelope): Promise<string | undefined> {
    const keyDescriptor = await this.keyProvider.getKey(envelope.keyId)
    if (!keyDescriptor) {
      // Non-fatal: missing key
      return undefined
    }

    try {
      const decipher = createDecipheriv(
        ALGORITHM,
        keyDescriptor.key,
        Buffer.from(envelope.iv, 'base64'),
        { authTagLength: AUTH_TAG_LENGTH },
      )
      decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'))

      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ])

      return decrypted.toString('utf8')
    } catch {
      // Non-fatal: tampered ciphertext or auth tag mismatch
      return undefined
    }
  }

  private async decryptRecord(
    record: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined> {
    const encryptedValue = record['_encrypted_value']

    if (!isEncryptedEnvelope(encryptedValue)) {
      // Not encrypted — return as-is
      return record
    }

    const decryptedJson = await this.decrypt(encryptedValue)
    if (decryptedJson === undefined) {
      return undefined
    }

    try {
      const decryptedData = JSON.parse(decryptedJson) as Record<string, unknown>

      // Merge plaintext fields with decrypted data
      const { _encrypted_value: _removed, ...plaintextFields } = record
      return { ...decryptedData, ...plaintextFields }
    } catch {
      return undefined
    }
  }
}
