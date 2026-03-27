/**
 * Reads encryption keys from environment variables.
 *
 * Format: DZIP_MEMORY_KEY_{ID}=hex-encoded-256-bit-key  (64 hex chars = 32 bytes)
 * Active key: DZIP_MEMORY_KEY_ACTIVE={ID}
 *
 * Example:
 *   DZIP_MEMORY_KEY_k1=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
 *   DZIP_MEMORY_KEY_ACTIVE=k1
 */
import type { EncryptionKeyProvider, EncryptionKeyDescriptor } from './types.js'

const KEY_PREFIX = 'DZIP_MEMORY_KEY_'
const ACTIVE_SUFFIX = 'ACTIVE'
const EXPECTED_HEX_LENGTH = 64 // 32 bytes = 64 hex chars
const HEX_PATTERN = /^[0-9a-fA-F]+$/

export class EnvKeyProvider implements EncryptionKeyProvider {
  private readonly keys: Map<string, EncryptionKeyDescriptor>
  private readonly activeKeyId: string | undefined

  constructor(env?: Record<string, string | undefined>) {
    const source = env ?? process.env
    this.keys = new Map()

    const activeVar = source[`${KEY_PREFIX}${ACTIVE_SUFFIX}`]
    this.activeKeyId = activeVar?.trim() || undefined

    for (const [envKey, envValue] of Object.entries(source)) {
      if (!envKey.startsWith(KEY_PREFIX)) continue

      const suffix = envKey.slice(KEY_PREFIX.length)
      if (suffix === ACTIVE_SUFFIX) continue
      if (!envValue) continue

      const hexValue = envValue.trim()

      // Validate: must be exactly 64 hex characters
      if (hexValue.length !== EXPECTED_HEX_LENGTH) continue
      if (!HEX_PATTERN.test(hexValue)) continue

      const keyId = suffix
      const keyBuffer = Buffer.from(hexValue, 'hex')

      this.keys.set(keyId, {
        keyId,
        key: keyBuffer,
        status: keyId === this.activeKeyId ? 'active' : 'rotated',
        createdAt: new Date(),
      })
    }
  }

  async getKey(keyId: string): Promise<EncryptionKeyDescriptor | undefined> {
    return this.keys.get(keyId)
  }

  async getActiveKey(): Promise<EncryptionKeyDescriptor | undefined> {
    if (!this.activeKeyId) return undefined
    return this.keys.get(this.activeKeyId)
  }

  async listKeys(): Promise<EncryptionKeyDescriptor[]> {
    return [...this.keys.values()]
  }
}
