import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EnvKeyProvider } from '../encryption/env-key-provider.js'
import { EncryptedMemoryService } from '../encryption/encrypted-memory-service.js'
import type { EncryptionKeyProvider, EncryptionKeyDescriptor } from '../encryption/types.js'
import type { MemoryService } from '../memory-service.js'
import { randomBytes } from 'node:crypto'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a valid 32-byte hex key string (64 hex chars). */
function makeHexKey(): string {
  return randomBytes(32).toString('hex')
}

function createMockMemoryService(): {
  svc: MemoryService
  putSpy: ReturnType<typeof vi.fn>
  getSpy: ReturnType<typeof vi.fn>
  searchSpy: ReturnType<typeof vi.fn>
} {
  const putSpy = vi.fn().mockResolvedValue(undefined)
  const getSpy = vi.fn().mockResolvedValue([])
  const searchSpy = vi.fn().mockResolvedValue([])

  const svc = {
    put: putSpy,
    get: getSpy,
    search: searchSpy,
    formatForPrompt: vi.fn().mockReturnValue(''),
  } as unknown as MemoryService

  return { svc, putSpy, getSpy, searchSpy }
}

function createMockKeyProvider(keys: EncryptionKeyDescriptor[]): EncryptionKeyProvider {
  const keyMap = new Map(keys.map(k => [k.keyId, k]))
  const activeKey = keys.find(k => k.status === 'active')
  return {
    getKey: async (keyId: string) => keyMap.get(keyId),
    getActiveKey: async () => activeKey,
    listKeys: async () => keys,
  }
}

function makeKey(keyId: string, status: 'active' | 'rotated' | 'revoked' = 'active'): EncryptionKeyDescriptor {
  return {
    keyId,
    key: randomBytes(32),
    status,
    createdAt: new Date(),
  }
}

const scope = { projectId: 'p1' }

// ===========================================================================
// EnvKeyProvider
// ===========================================================================

describe('EnvKeyProvider', () => {
  it('parses DZIP_MEMORY_KEY_* env vars', async () => {
    const hex1 = makeHexKey()
    const hex2 = makeHexKey()
    const provider = new EnvKeyProvider({
      DZIP_MEMORY_KEY_k1: hex1,
      DZIP_MEMORY_KEY_k2: hex2,
      DZIP_MEMORY_KEY_ACTIVE: 'k1',
    })

    const keys = await provider.listKeys()
    expect(keys).toHaveLength(2)
    expect(keys.map(k => k.keyId).sort()).toEqual(['k1', 'k2'])
  })

  it('getActiveKey() returns the key specified by DZIP_MEMORY_KEY_ACTIVE', async () => {
    const hex1 = makeHexKey()
    const provider = new EnvKeyProvider({
      DZIP_MEMORY_KEY_mykey: hex1,
      DZIP_MEMORY_KEY_ACTIVE: 'mykey',
    })

    const active = await provider.getActiveKey()
    expect(active).toBeDefined()
    expect(active!.keyId).toBe('mykey')
    expect(active!.status).toBe('active')
    expect(active!.key).toEqual(Buffer.from(hex1, 'hex'))
  })

  it('getKey() returns specific key by ID', async () => {
    const hex1 = makeHexKey()
    const hex2 = makeHexKey()
    const provider = new EnvKeyProvider({
      DZIP_MEMORY_KEY_alpha: hex1,
      DZIP_MEMORY_KEY_beta: hex2,
      DZIP_MEMORY_KEY_ACTIVE: 'alpha',
    })

    const key = await provider.getKey('beta')
    expect(key).toBeDefined()
    expect(key!.keyId).toBe('beta')
    expect(key!.key).toEqual(Buffer.from(hex2, 'hex'))
    expect(key!.status).toBe('rotated') // not the active key
  })

  it('missing key returns undefined', async () => {
    const provider = new EnvKeyProvider({
      DZIP_MEMORY_KEY_k1: makeHexKey(),
      DZIP_MEMORY_KEY_ACTIVE: 'k1',
    })

    const key = await provider.getKey('nonexistent')
    expect(key).toBeUndefined()
  })

  it('invalid hex (wrong length) is skipped', async () => {
    const provider = new EnvKeyProvider({
      DZIP_MEMORY_KEY_short: 'abcdef', // too short
      DZIP_MEMORY_KEY_toolong: makeHexKey() + 'ff', // too long (66 chars)
      DZIP_MEMORY_KEY_valid: makeHexKey(),
      DZIP_MEMORY_KEY_ACTIVE: 'valid',
    })

    const keys = await provider.listKeys()
    expect(keys).toHaveLength(1)
    expect(keys[0]!.keyId).toBe('valid')
  })

  it('invalid hex (non-hex chars) is skipped', async () => {
    const provider = new EnvKeyProvider({
      DZIP_MEMORY_KEY_bad: 'g'.repeat(64), // 'g' is not hex
      DZIP_MEMORY_KEY_good: makeHexKey(),
      DZIP_MEMORY_KEY_ACTIVE: 'good',
    })

    const keys = await provider.listKeys()
    expect(keys).toHaveLength(1)
    expect(keys[0]!.keyId).toBe('good')
  })

  it('getActiveKey() returns undefined when no ACTIVE var is set', async () => {
    const provider = new EnvKeyProvider({
      DZIP_MEMORY_KEY_k1: makeHexKey(),
    })

    const active = await provider.getActiveKey()
    expect(active).toBeUndefined()
  })

  it('non-DZIP_MEMORY_KEY_ env vars are ignored', async () => {
    const provider = new EnvKeyProvider({
      DZIP_MEMORY_KEY_k1: makeHexKey(),
      DZIP_MEMORY_KEY_ACTIVE: 'k1',
      HOME: '/home/user',
      PATH: '/usr/bin',
    })

    const keys = await provider.listKeys()
    expect(keys).toHaveLength(1)
  })
})

// ===========================================================================
// EncryptedMemoryService
// ===========================================================================

describe('EncryptedMemoryService', () => {
  let mockMs: ReturnType<typeof createMockMemoryService>
  let activeKey: EncryptionKeyDescriptor
  let keyProvider: EncryptionKeyProvider

  beforeEach(() => {
    mockMs = createMockMemoryService()
    activeKey = makeKey('key1', 'active')
    keyProvider = createMockKeyProvider([activeKey])
  })

  describe('put()/get() round-trip', () => {
    it('encrypted value decrypts correctly', async () => {
      const service = new EncryptedMemoryService({
        memoryService: mockMs.svc,
        keyProvider,
      })

      const originalValue = {
        text: 'searchable text',
        secret: 'my-secret-data',
        nested: { deep: 42 },
      }

      await service.put('decisions', scope, 'item1', originalValue)

      // Verify put was called with encrypted data
      expect(mockMs.putSpy).toHaveBeenCalledTimes(1)
      const storedValue = mockMs.putSpy.mock.calls[0]![3] as Record<string, unknown>

      // 'text' should be in plaintext (default plaintextFields)
      expect(storedValue['text']).toBe('searchable text')
      // _encrypted_value should exist
      expect(storedValue['_encrypted_value']).toBeDefined()
      const envelope = storedValue['_encrypted_value'] as Record<string, unknown>
      expect(envelope['_encrypted']).toBe(true)
      expect(envelope['algorithm']).toBe('aes-256-gcm')
      // 'secret' should NOT be in plaintext
      expect(storedValue['secret']).toBeUndefined()

      // Now simulate get() returning the stored value
      mockMs.getSpy.mockResolvedValueOnce([storedValue])

      const results = await service.get('decisions', scope, 'item1')
      expect(results).toHaveLength(1)
      expect(results[0]!['secret']).toBe('my-secret-data')
      expect(results[0]!['nested']).toEqual({ deep: 42 })
      expect(results[0]!['text']).toBe('searchable text')
    })
  })

  describe('namespace filtering', () => {
    it('non-encrypted namespace passes through unchanged', async () => {
      const service = new EncryptedMemoryService({
        memoryService: mockMs.svc,
        keyProvider,
        encryptedNamespaces: ['secrets'], // only encrypt 'secrets'
      })

      const value = { text: 'hello', data: 'world' }
      await service.put('decisions', scope, 'item1', value)

      // Should pass through to underlying service as-is
      expect(mockMs.putSpy).toHaveBeenCalledWith('decisions', scope, 'item1', value)
    })

    it('encrypted namespace gets encrypted', async () => {
      const service = new EncryptedMemoryService({
        memoryService: mockMs.svc,
        keyProvider,
        encryptedNamespaces: ['secrets'],
      })

      const value = { text: 'hello', data: 'world' }
      await service.put('secrets', scope, 'item1', value)

      const storedValue = mockMs.putSpy.mock.calls[0]![3] as Record<string, unknown>
      expect(storedValue['_encrypted_value']).toBeDefined()
    })
  })

  describe('plaintext fields', () => {
    it('preserves configured plaintext fields outside encryption', async () => {
      const service = new EncryptedMemoryService({
        memoryService: mockMs.svc,
        keyProvider,
        plaintextFields: ['text', 'category'],
      })

      const value = { text: 'query text', category: 'lesson', secret: 'classified' }
      await service.put('ns', scope, 'k1', value)

      const storedValue = mockMs.putSpy.mock.calls[0]![3] as Record<string, unknown>
      expect(storedValue['text']).toBe('query text')
      expect(storedValue['category']).toBe('lesson')
      expect(storedValue['secret']).toBeUndefined()
      expect(storedValue['_encrypted_value']).toBeDefined()
    })

    it('preserves nested plaintext fields (dot notation)', async () => {
      const service = new EncryptedMemoryService({
        memoryService: mockMs.svc,
        keyProvider,
        plaintextFields: ['text', '_provenance.createdBy'],
      })

      const value = {
        text: 'some text',
        _provenance: { createdBy: 'agent-1', sessionId: 'sess-1' },
        secret: 'hidden',
      }
      await service.put('ns', scope, 'k1', value)

      const storedValue = mockMs.putSpy.mock.calls[0]![3] as Record<string, unknown>
      expect(storedValue['text']).toBe('some text')
      const prov = storedValue['_provenance'] as Record<string, unknown>
      expect(prov['createdBy']).toBe('agent-1')
      expect(storedValue['secret']).toBeUndefined()
    })
  })

  describe('search', () => {
    it('works on plaintext fields and decrypts results', async () => {
      const service = new EncryptedMemoryService({
        memoryService: mockMs.svc,
        keyProvider,
      })

      // First put a record to get a valid stored form
      const value = { text: 'learn about testing', secret: 'api-key-123' }
      await service.put('lessons', scope, 'l1', value)
      const storedValue = mockMs.putSpy.mock.calls[0]![3] as Record<string, unknown>

      // Mock search returning the stored value
      mockMs.searchSpy.mockResolvedValueOnce([storedValue])

      const results = await service.search('lessons', scope, 'testing', 5)
      expect(results).toHaveLength(1)
      expect(results[0]!['text']).toBe('learn about testing')
      expect(results[0]!['secret']).toBe('api-key-123')
    })
  })

  describe('missing key during decrypt', () => {
    it('returns undefined (non-fatal)', async () => {
      const service = new EncryptedMemoryService({
        memoryService: mockMs.svc,
        keyProvider,
      })

      // Put with active key
      await service.put('ns', scope, 'k1', { text: 'data', secret: 'x' })
      const storedValue = mockMs.putSpy.mock.calls[0]![3] as Record<string, unknown>

      // Create a new provider that does NOT have the key
      const emptyProvider = createMockKeyProvider([])
      const service2 = new EncryptedMemoryService({
        memoryService: mockMs.svc,
        keyProvider: emptyProvider,
      })

      mockMs.getSpy.mockResolvedValueOnce([storedValue])
      const results = await service2.get('ns', scope, 'k1')
      expect(results).toHaveLength(0)
    })
  })

  describe('tampered ciphertext detection', () => {
    it('auth tag fails on modified ciphertext', async () => {
      const service = new EncryptedMemoryService({
        memoryService: mockMs.svc,
        keyProvider,
      })

      await service.put('ns', scope, 'k1', { text: 'data', secret: 'x' })
      const storedValue = mockMs.putSpy.mock.calls[0]![3] as Record<string, unknown>

      // Tamper with the ciphertext
      const envelope = storedValue['_encrypted_value'] as Record<string, unknown>
      const original = envelope['ciphertext'] as string
      const tampered = Buffer.from(original, 'base64')
      if (tampered.length > 0) {
        tampered[0] = (tampered[0]! ^ 0xff) // flip bits
      }
      envelope['ciphertext'] = tampered.toString('base64')

      mockMs.getSpy.mockResolvedValueOnce([storedValue])
      const results = await service.get('ns', scope, 'k1')
      expect(results).toHaveLength(0) // tampered record filtered out
    })
  })

  describe('rotateKey()', () => {
    it('re-encrypts all records with new active key', async () => {
      const oldKey = makeKey('old', 'rotated')
      const newKey = makeKey('new', 'active')
      const provider1 = createMockKeyProvider([oldKey, newKey])

      // Use old key as "active" for initial put
      const oldActiveProvider = createMockKeyProvider([
        { ...oldKey, status: 'active' as const },
      ])

      const service1 = new EncryptedMemoryService({
        memoryService: mockMs.svc,
        keyProvider: oldActiveProvider,
      })

      // Put a record with old key
      await service1.put('ns', scope, 'k1', { text: 'data', secret: 'classified' })
      const storedValue = mockMs.putSpy.mock.calls[0]![3] as Record<string, unknown>
      const oldEnvelope = storedValue['_encrypted_value'] as Record<string, unknown>
      expect(oldEnvelope['keyId']).toBe('old')

      // Now create a service with new active key and both keys available
      const service2 = new EncryptedMemoryService({
        memoryService: mockMs.svc,
        keyProvider: provider1,
      })

      // Mock get() returning the old-key-encrypted record
      mockMs.getSpy.mockResolvedValueOnce([storedValue])

      const result = await service2.rotateKey('ns', scope)
      expect(result.rotated).toBe(1)
      expect(result.failed).toBe(0)

      // Verify re-encrypted with new key
      const reEncryptedCall = mockMs.putSpy.mock.calls[1]
      const reEncryptedValue = reEncryptedCall![3] as Record<string, unknown>
      const newEnvelope = reEncryptedValue['_encrypted_value'] as Record<string, unknown>
      expect(newEnvelope['keyId']).toBe('new')
    })
  })

  describe('isEncrypted()', () => {
    it('correctly identifies envelopes', () => {
      expect(EncryptedMemoryService.isEncrypted({
        _encrypted: true,
        algorithm: 'aes-256-gcm',
        keyId: 'k1',
        ciphertext: 'abc',
        iv: 'def',
        authTag: 'ghi',
      })).toBe(true)

      expect(EncryptedMemoryService.isEncrypted({ text: 'plain' })).toBe(false)
      expect(EncryptedMemoryService.isEncrypted(null)).toBe(false)
      expect(EncryptedMemoryService.isEncrypted(undefined)).toBe(false)
      expect(EncryptedMemoryService.isEncrypted('string')).toBe(false)
      expect(EncryptedMemoryService.isEncrypted({
        _encrypted: true,
        algorithm: 'aes-128-cbc', // wrong algorithm
        keyId: 'k1',
        ciphertext: 'abc',
        iv: 'def',
        authTag: 'ghi',
      })).toBe(false)
    })
  })

  describe('IV randomness', () => {
    it('different put() calls produce different IVs', async () => {
      const service = new EncryptedMemoryService({
        memoryService: mockMs.svc,
        keyProvider,
      })

      await service.put('ns', scope, 'k1', { text: 'data', secret: 'a' })
      await service.put('ns', scope, 'k2', { text: 'data', secret: 'a' })

      const stored1 = mockMs.putSpy.mock.calls[0]![3] as Record<string, unknown>
      const stored2 = mockMs.putSpy.mock.calls[1]![3] as Record<string, unknown>

      const env1 = stored1['_encrypted_value'] as Record<string, unknown>
      const env2 = stored2['_encrypted_value'] as Record<string, unknown>

      // IVs should be different (random)
      expect(env1['iv']).not.toBe(env2['iv'])
      // Ciphertexts should also differ due to different IVs
      expect(env1['ciphertext']).not.toBe(env2['ciphertext'])
    })
  })

  describe('no active key', () => {
    it('falls back to plaintext write when no active key exists', async () => {
      const emptyProvider = createMockKeyProvider([])
      const service = new EncryptedMemoryService({
        memoryService: mockMs.svc,
        keyProvider: emptyProvider,
      })

      const value = { text: 'data', secret: 'plain' }
      await service.put('ns', scope, 'k1', value)

      // Should pass through as plaintext
      expect(mockMs.putSpy).toHaveBeenCalledWith('ns', scope, 'k1', value)
    })
  })

  describe('non-encrypted records in get()', () => {
    it('returns plaintext records as-is', async () => {
      const service = new EncryptedMemoryService({
        memoryService: mockMs.svc,
        keyProvider,
      })

      const plainRecord = { text: 'plain data', extra: 'field' }
      mockMs.getSpy.mockResolvedValueOnce([plainRecord])

      const results = await service.get('ns', scope)
      expect(results).toHaveLength(1)
      expect(results[0]).toEqual(plainRecord)
    })
  })
})
