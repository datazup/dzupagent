/**
 * Extended coverage for EncryptedMemoryService — focuses on edge cases,
 * private helper behavior (via observable side effects), error paths, and
 * the full set of public methods not exhaustively covered by encryption.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { randomBytes } from 'node:crypto'
import { EncryptedMemoryService } from '../encryption/encrypted-memory-service.js'
import type {
  EncryptionKeyDescriptor,
  EncryptionKeyProvider,
} from '../encryption/types.js'
import type { MemoryService } from '../memory-service.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeKey(
  keyId: string,
  status: 'active' | 'rotated' | 'revoked' = 'active',
): EncryptionKeyDescriptor {
  return {
    keyId,
    key: randomBytes(32),
    status,
    createdAt: new Date(),
  }
}

function createMockKeyProvider(
  keys: EncryptionKeyDescriptor[],
): EncryptionKeyProvider {
  const map = new Map(keys.map(k => [k.keyId, k]))
  const active = keys.find(k => k.status === 'active')
  return {
    getKey: async (id: string) => map.get(id),
    getActiveKey: async () => active,
    listKeys: async () => keys,
  }
}

function createMockMemoryService(): {
  svc: MemoryService
  putSpy: ReturnType<typeof vi.fn>
  getSpy: ReturnType<typeof vi.fn>
  searchSpy: ReturnType<typeof vi.fn>
  formatSpy: ReturnType<typeof vi.fn>
} {
  const putSpy = vi.fn().mockResolvedValue(undefined)
  const getSpy = vi.fn().mockResolvedValue([])
  const searchSpy = vi.fn().mockResolvedValue([])
  const formatSpy = vi.fn().mockReturnValue('formatted')

  const svc = {
    put: putSpy,
    get: getSpy,
    search: searchSpy,
    formatForPrompt: formatSpy,
  } as unknown as MemoryService

  return { svc, putSpy, getSpy, searchSpy, formatSpy }
}

const SCOPE = { tenantId: 't1', projectId: 'p1' }

// ===========================================================================
// Constructor / configuration
// ===========================================================================

describe('EncryptedMemoryService — configuration', () => {
  it('uses default plaintext fields when none provided', async () => {
    const mock = createMockMemoryService()
    const provider = createMockKeyProvider([makeKey('k1', 'active')])
    const service = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: provider,
    })

    await service.put('ns', SCOPE, 'k1', {
      text: 'searchable',
      _provenance: { createdBy: 'agent-1', source: 'direct' },
      secret: 'hidden',
    })

    const stored = mock.putSpy.mock.calls[0]![3] as Record<string, unknown>
    expect(stored['text']).toBe('searchable')
    const prov = stored['_provenance'] as Record<string, unknown>
    expect(prov['createdBy']).toBe('agent-1')
    expect(prov['source']).toBe('direct')
    expect(stored['secret']).toBeUndefined()
  })

  it('respects custom plaintext fields config (overrides defaults)', async () => {
    const mock = createMockMemoryService()
    const provider = createMockKeyProvider([makeKey('k1', 'active')])
    const service = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: provider,
      plaintextFields: ['title'], // explicitly excludes 'text' from defaults
    })

    await service.put('ns', SCOPE, 'k1', {
      title: 'visible',
      text: 'should now be encrypted',
    })

    const stored = mock.putSpy.mock.calls[0]![3] as Record<string, unknown>
    expect(stored['title']).toBe('visible')
    expect(stored['text']).toBeUndefined()
    expect(stored['_encrypted_value']).toBeDefined()
  })

  it('encryptedNamespaces undefined => encrypts all namespaces', async () => {
    const mock = createMockMemoryService()
    const provider = createMockKeyProvider([makeKey('k1', 'active')])
    const service = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: provider,
    })

    await service.put('alpha', SCOPE, 'k', { secret: 'a' })
    await service.put('beta', SCOPE, 'k', { secret: 'b' })

    expect(
      (mock.putSpy.mock.calls[0]![3] as Record<string, unknown>)[
        '_encrypted_value'
      ],
    ).toBeDefined()
    expect(
      (mock.putSpy.mock.calls[1]![3] as Record<string, unknown>)[
        '_encrypted_value'
      ],
    ).toBeDefined()
  })

  it('encryptedNamespaces empty array => encrypts nothing', async () => {
    const mock = createMockMemoryService()
    const provider = createMockKeyProvider([makeKey('k1', 'active')])
    const service = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: provider,
      encryptedNamespaces: [],
    })

    const value = { secret: 'plain' }
    await service.put('ns', SCOPE, 'k', value)

    expect(mock.putSpy).toHaveBeenCalledWith('ns', SCOPE, 'k', value)
    const stored = mock.putSpy.mock.calls[0]![3] as Record<string, unknown>
    expect(stored['_encrypted_value']).toBeUndefined()
  })
})

// ===========================================================================
// put() — round-trip integrity, edge values
// ===========================================================================

describe('EncryptedMemoryService — put() edge cases', () => {
  let mock: ReturnType<typeof createMockMemoryService>
  let provider: EncryptionKeyProvider
  let service: EncryptedMemoryService

  beforeEach(() => {
    mock = createMockMemoryService()
    provider = createMockKeyProvider([makeKey('k1', 'active')])
    service = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: provider,
    })
  })

  it('encrypts an empty object', async () => {
    await service.put('ns', SCOPE, 'k', {})
    const stored = mock.putSpy.mock.calls[0]![3] as Record<string, unknown>
    expect(stored['_encrypted_value']).toBeDefined()
    const env = stored['_encrypted_value'] as Record<string, unknown>
    expect(typeof env['ciphertext']).toBe('string')
  })

  it('encrypts numeric and boolean fields', async () => {
    await service.put('ns', SCOPE, 'k', {
      count: 42,
      active: true,
      ratio: 3.14,
    })
    const stored = mock.putSpy.mock.calls[0]![3] as Record<string, unknown>
    mock.getSpy.mockResolvedValueOnce([stored])
    const [decrypted] = await service.get('ns', SCOPE)
    expect(decrypted!['count']).toBe(42)
    expect(decrypted!['active']).toBe(true)
    expect(decrypted!['ratio']).toBe(3.14)
  })

  it('round-trips array values', async () => {
    await service.put('ns', SCOPE, 'k', { items: [1, 2, 'three'] })
    const stored = mock.putSpy.mock.calls[0]![3] as Record<string, unknown>
    mock.getSpy.mockResolvedValueOnce([stored])
    const [decrypted] = await service.get('ns', SCOPE)
    expect(decrypted!['items']).toEqual([1, 2, 'three'])
  })

  it('round-trips deeply nested structures', async () => {
    const value = {
      a: { b: { c: { d: { e: 'deep' } } } },
      list: [{ x: 1 }, { x: 2 }],
    }
    await service.put('ns', SCOPE, 'k', value)
    const stored = mock.putSpy.mock.calls[0]![3] as Record<string, unknown>
    mock.getSpy.mockResolvedValueOnce([stored])
    const [decrypted] = await service.get('ns', SCOPE)
    expect(decrypted!['a']).toEqual({ b: { c: { d: { e: 'deep' } } } })
    expect(decrypted!['list']).toEqual([{ x: 1 }, { x: 2 }])
  })

  it('round-trips unicode/emoji strings', async () => {
    const value = { text: 'hello', secret: '日本語 🚀 emoji' }
    await service.put('ns', SCOPE, 'k', value)
    const stored = mock.putSpy.mock.calls[0]![3] as Record<string, unknown>
    mock.getSpy.mockResolvedValueOnce([stored])
    const [decrypted] = await service.get('ns', SCOPE)
    expect(decrypted!['secret']).toBe('日本語 🚀 emoji')
  })

  it('plaintext field when undefined in source is omitted from stored', async () => {
    await service.put('ns', SCOPE, 'k', { secret: 'x' }) // no 'text' field
    const stored = mock.putSpy.mock.calls[0]![3] as Record<string, unknown>
    // text was a default plaintext field but absent; should remain absent
    expect(stored['text']).toBeUndefined()
    expect(stored['_encrypted_value']).toBeDefined()
  })

  it('handles plaintext field with falsy value (0)', async () => {
    const svc = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: provider,
      plaintextFields: ['count'],
    })
    await svc.put('ns', SCOPE, 'k', { count: 0, secret: 's' })
    const stored = mock.putSpy.mock.calls[0]![3] as Record<string, unknown>
    expect(stored['count']).toBe(0)
    expect(stored['_encrypted_value']).toBeDefined()
  })

  it('handles plaintext field with empty string', async () => {
    const svc = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: provider,
      plaintextFields: ['text'],
    })
    await svc.put('ns', SCOPE, 'k', { text: '', secret: 's' })
    const stored = mock.putSpy.mock.calls[0]![3] as Record<string, unknown>
    expect(stored['text']).toBe('')
  })

  it('handles plaintext nested path where intermediate is missing', async () => {
    const svc = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: provider,
      plaintextFields: ['a.b.c'],
    })
    await svc.put('ns', SCOPE, 'k', { secret: 'x' }) // a.b.c absent
    const stored = mock.putSpy.mock.calls[0]![3] as Record<string, unknown>
    // The nested plaintext field should be omitted
    expect(stored['a']).toBeUndefined()
    expect(stored['_encrypted_value']).toBeDefined()
  })

  it('preserves multiple nested plaintext fields with overlap', async () => {
    const svc = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: provider,
      plaintextFields: ['meta.id', 'meta.tag'],
    })
    await svc.put('ns', SCOPE, 'k', {
      meta: { id: 'm-1', tag: 'lesson', private: 'sensitive' },
      secret: 'x',
    })
    const stored = mock.putSpy.mock.calls[0]![3] as Record<string, unknown>
    const meta = stored['meta'] as Record<string, unknown>
    expect(meta['id']).toBe('m-1')
    expect(meta['tag']).toBe('lesson')
    expect(meta['private']).toBeUndefined()
  })
})

// ===========================================================================
// get() — multiple records, mixed encrypted/plain, decryption errors
// ===========================================================================

describe('EncryptedMemoryService — get()', () => {
  let mock: ReturnType<typeof createMockMemoryService>
  let provider: EncryptionKeyProvider
  let service: EncryptedMemoryService

  beforeEach(() => {
    mock = createMockMemoryService()
    provider = createMockKeyProvider([makeKey('k1', 'active')])
    service = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: provider,
    })
  })

  it('decrypts multiple records in a single get() call', async () => {
    await service.put('ns', SCOPE, 'a', { text: 'A', secret: 'aa' })
    await service.put('ns', SCOPE, 'b', { text: 'B', secret: 'bb' })
    const r1 = mock.putSpy.mock.calls[0]![3] as Record<string, unknown>
    const r2 = mock.putSpy.mock.calls[1]![3] as Record<string, unknown>
    mock.getSpy.mockResolvedValueOnce([r1, r2])

    const decrypted = await service.get('ns', SCOPE)
    expect(decrypted).toHaveLength(2)
    expect(decrypted[0]!['secret']).toBe('aa')
    expect(decrypted[1]!['secret']).toBe('bb')
  })

  it('returns empty array when underlying get returns nothing', async () => {
    mock.getSpy.mockResolvedValueOnce([])
    const result = await service.get('ns', SCOPE)
    expect(result).toEqual([])
  })

  it('mixed encrypted + plaintext records both come through', async () => {
    await service.put('ns', SCOPE, 'enc', { text: 'enc', secret: 'x' })
    const encStored = mock.putSpy.mock.calls[0]![3] as Record<string, unknown>
    const plain = { text: 'pl', plain: 'no-enc' }
    mock.getSpy.mockResolvedValueOnce([encStored, plain])

    const result = await service.get('ns', SCOPE)
    expect(result).toHaveLength(2)
    const encR = result.find(r => r['secret'] === 'x')
    expect(encR).toBeDefined()
    const plR = result.find(r => r['plain'] === 'no-enc')
    expect(plR).toBeDefined()
  })

  it('filters out records whose decryption returns undefined', async () => {
    // Bad envelope (cannot decrypt because wrong key)
    await service.put('ns', SCOPE, 'k', { secret: 'x' })
    const stored = mock.putSpy.mock.calls[0]![3] as Record<string, unknown>
    const env = stored['_encrypted_value'] as Record<string, unknown>
    env['keyId'] = 'unknown-key' // force missing key

    const goodPlain = { text: 'plain' }
    mock.getSpy.mockResolvedValueOnce([stored, goodPlain])
    const result = await service.get('ns', SCOPE)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(goodPlain)
  })

  it('passes namespace, scope, and key through to underlying service', async () => {
    mock.getSpy.mockResolvedValueOnce([])
    await service.get('my-ns', { tenantId: 't9' }, 'specific-key')
    expect(mock.getSpy).toHaveBeenCalledWith(
      'my-ns',
      { tenantId: 't9' },
      'specific-key',
    )
  })

  it('handles JSON parse failure (corrupted decrypted plaintext) gracefully', async () => {
    // Force decrypt() to succeed but produce invalid JSON.
    // We do this by hand-crafting an envelope that decrypts to "not json".
    // The simplest path: use a real key, encrypt non-JSON data via the cipher.
    const { createCipheriv, randomBytes: rb } = await import('node:crypto')
    const k = makeKey('mk', 'active')
    const localProvider = createMockKeyProvider([k])
    const localSvc = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: localProvider,
    })

    const iv = rb(12)
    const cipher = createCipheriv('aes-256-gcm', k.key, iv, {
      authTagLength: 16,
    })
    const ciphertext = Buffer.concat([
      cipher.update('not-json-{', 'utf8'),
      cipher.final(),
    ])
    const authTag = cipher.getAuthTag()
    const corrupted = {
      _encrypted_value: {
        _encrypted: true,
        algorithm: 'aes-256-gcm' as const,
        keyId: 'mk',
        ciphertext: ciphertext.toString('base64'),
        iv: iv.toString('base64'),
        authTag: authTag.toString('base64'),
      },
    }
    mock.getSpy.mockResolvedValueOnce([corrupted])
    const result = await localSvc.get('ns', SCOPE)
    expect(result).toHaveLength(0) // dropped due to JSON parse error
  })
})

// ===========================================================================
// search()
// ===========================================================================

describe('EncryptedMemoryService — search()', () => {
  let mock: ReturnType<typeof createMockMemoryService>
  let provider: EncryptionKeyProvider
  let service: EncryptedMemoryService

  beforeEach(() => {
    mock = createMockMemoryService()
    provider = createMockKeyProvider([makeKey('k1', 'active')])
    service = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: provider,
    })
  })

  it('forwards limit parameter to underlying service', async () => {
    mock.searchSpy.mockResolvedValueOnce([])
    await service.search('ns', SCOPE, 'q', 7)
    expect(mock.searchSpy).toHaveBeenCalledWith('ns', SCOPE, 'q', 7)
  })

  it('forwards search even when limit is undefined', async () => {
    mock.searchSpy.mockResolvedValueOnce([])
    await service.search('ns', SCOPE, 'q')
    expect(mock.searchSpy).toHaveBeenCalledWith('ns', SCOPE, 'q', undefined)
  })

  it('returns empty array when no matches found', async () => {
    mock.searchSpy.mockResolvedValueOnce([])
    const result = await service.search('ns', SCOPE, 'q')
    expect(result).toEqual([])
  })

  it('drops records that fail to decrypt during search', async () => {
    await service.put('ns', SCOPE, 'a', { text: 'a', secret: 'x' })
    const stored = mock.putSpy.mock.calls[0]![3] as Record<string, unknown>
    ;(stored['_encrypted_value'] as Record<string, unknown>)['keyId'] = 'gone'
    mock.searchSpy.mockResolvedValueOnce([stored])

    const result = await service.search('ns', SCOPE, 'a')
    expect(result).toHaveLength(0)
  })
})

// ===========================================================================
// shouldEncrypt() — namespace filter behavior
// ===========================================================================

describe('EncryptedMemoryService — namespace filter', () => {
  it('encrypts only listed namespaces when filter is set', async () => {
    const mock = createMockMemoryService()
    const provider = createMockKeyProvider([makeKey('k1', 'active')])
    const service = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: provider,
      encryptedNamespaces: ['secrets', 'pii'],
    })

    await service.put('public', SCOPE, 'k', { data: 'plain' })
    await service.put('secrets', SCOPE, 'k', { data: 'enc' })
    await service.put('pii', SCOPE, 'k', { data: 'enc' })
    await service.put('logs', SCOPE, 'k', { data: 'plain' })

    const calls = mock.putSpy.mock.calls
    expect(
      (calls[0]![3] as Record<string, unknown>)['_encrypted_value'],
    ).toBeUndefined()
    expect(
      (calls[1]![3] as Record<string, unknown>)['_encrypted_value'],
    ).toBeDefined()
    expect(
      (calls[2]![3] as Record<string, unknown>)['_encrypted_value'],
    ).toBeDefined()
    expect(
      (calls[3]![3] as Record<string, unknown>)['_encrypted_value'],
    ).toBeUndefined()
  })

  it('non-encrypted namespace get() does NOT process records as encrypted', async () => {
    const mock = createMockMemoryService()
    const provider = createMockKeyProvider([makeKey('k1', 'active')])
    const service = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: provider,
      encryptedNamespaces: ['secrets'],
    })

    // Even though we pass a "non-encrypted" namespace to get(), the wrapper
    // still calls decryptRecord, which is a no-op for plain records.
    const plain = { text: 'public data' }
    mock.getSpy.mockResolvedValueOnce([plain])
    const result = await service.get('public', SCOPE)
    expect(result).toEqual([plain])
  })
})

// ===========================================================================
// formatForPrompt — pure delegation
// ===========================================================================

describe('EncryptedMemoryService — formatForPrompt()', () => {
  it('delegates to underlying memoryService.formatForPrompt', () => {
    const mock = createMockMemoryService()
    const provider = createMockKeyProvider([makeKey('k1', 'active')])
    const service = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: provider,
    })

    const records = [{ text: 'a' }, { text: 'b' }]
    const opts = { maxItems: 2, header: '## Memories' }
    const result = service.formatForPrompt(records, opts)

    expect(mock.formatSpy).toHaveBeenCalledWith(records, opts)
    expect(result).toBe('formatted')
  })

  it('forwards calls without options', () => {
    const mock = createMockMemoryService()
    const provider = createMockKeyProvider([makeKey('k1', 'active')])
    const service = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: provider,
    })

    service.formatForPrompt([])
    expect(mock.formatSpy).toHaveBeenCalledWith([], undefined)
  })
})

// ===========================================================================
// rotateKey()
// ===========================================================================

describe('EncryptedMemoryService — rotateKey()', () => {
  it('rotates 0 records when namespace is empty', async () => {
    const mock = createMockMemoryService()
    const active = makeKey('a', 'active')
    const provider = createMockKeyProvider([active])
    const svc = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: provider,
    })
    mock.getSpy.mockResolvedValueOnce([])
    const r = await svc.rotateKey('ns', SCOPE)
    expect(r.rotated).toBe(0)
    expect(r.failed).toBe(0)
  })

  it('returns 0/0 when no active key is configured', async () => {
    const mock = createMockMemoryService()
    const provider = createMockKeyProvider([]) // no active key
    const svc = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: provider,
    })
    const r = await svc.rotateKey('ns', SCOPE)
    expect(r.rotated).toBe(0)
    expect(r.failed).toBe(0)
    // Should not call underlying get either when no active key
    expect(mock.getSpy).not.toHaveBeenCalled()
  })

  it('counts failed records when their key is missing', async () => {
    const mock = createMockMemoryService()
    const oldKey = makeKey('old', 'active')
    const oldProvider = createMockKeyProvider([oldKey])
    const writer = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: oldProvider,
    })
    await writer.put('ns', SCOPE, 'k', { secret: 'x' })
    const stored = mock.putSpy.mock.calls[0]![3] as Record<string, unknown>

    // Now rotate using a provider that does NOT have 'old' but has a new active key
    const newKey = makeKey('new', 'active')
    const rotateProvider = createMockKeyProvider([newKey]) // 'old' missing
    const rotator = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: rotateProvider,
    })

    mock.getSpy.mockResolvedValueOnce([stored])
    const r = await rotator.rotateKey('ns', SCOPE)
    expect(r.rotated).toBe(0)
    expect(r.failed).toBe(1)
  })

  it('uses content-hash style fallback key when _key is missing', async () => {
    const mock = createMockMemoryService()
    const oldKey = makeKey('old', 'active')
    const oldProvider = createMockKeyProvider([oldKey])
    const writer = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: oldProvider,
    })
    await writer.put('ns', SCOPE, 'k1', { secret: 'x' })
    const stored = mock.putSpy.mock.calls[0]![3] as Record<string, unknown>
    // Note: _key is NOT included in stored value by EncryptedMemoryService

    const newKey = makeKey('new', 'active')
    const rotateProvider = createMockKeyProvider([
      { ...oldKey, status: 'rotated' },
      newKey,
    ])
    const rotator = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: rotateProvider,
    })
    mock.getSpy.mockResolvedValueOnce([stored])
    const r = await rotator.rotateKey('ns', SCOPE)
    expect(r.rotated).toBe(1)

    // Re-put should have happened with synthetic key starting with "rotated_"
    const rePutCall = mock.putSpy.mock.calls[1]!
    expect((rePutCall[2] as string).startsWith('rotated_')).toBe(true)
  })

  it('uses _key from record when it is preserved as a plaintext field', async () => {
    const mock = createMockMemoryService()
    const oldKey = makeKey('old', 'active')
    const oldProvider = createMockKeyProvider([oldKey])
    // Configure '_key' as a plaintext field so it survives encryption to the outer record
    const writer = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: oldProvider,
      plaintextFields: ['text', '_key'],
    })
    await writer.put('ns', SCOPE, 'preserved-key', {
      _key: 'preserved-key',
      secret: 's',
    })
    const stored = mock.putSpy.mock.calls[0]![3] as Record<string, unknown>
    expect(stored['_key']).toBe('preserved-key') // confirms our setup

    const newKey = makeKey('new', 'active')
    const rotProv = createMockKeyProvider([
      { ...oldKey, status: 'rotated' },
      newKey,
    ])
    const rot = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: rotProv,
      plaintextFields: ['text', '_key'],
    })
    mock.getSpy.mockResolvedValueOnce([stored])
    await rot.rotateKey('ns', SCOPE)
    const rePut = mock.putSpy.mock.calls[1]!
    expect(rePut[2]).toBe('preserved-key')
  })

  it('handles a mix of rotatable and unrotatable records', async () => {
    const mock = createMockMemoryService()
    const oldKey = makeKey('old', 'active')
    const oldProvider = createMockKeyProvider([oldKey])
    const writer = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: oldProvider,
    })
    await writer.put('ns', SCOPE, 'a', { _key: 'a', secret: 'aa' })
    await writer.put('ns', SCOPE, 'b', { _key: 'b', secret: 'bb' })
    const recA = mock.putSpy.mock.calls[0]![3] as Record<string, unknown>
    const recB = mock.putSpy.mock.calls[1]![3] as Record<string, unknown>

    // Tamper recB so its decryption fails -> failed++
    const envB = recB['_encrypted_value'] as Record<string, unknown>
    const cb = Buffer.from(envB['ciphertext'] as string, 'base64')
    if (cb.length > 0) cb[0] = (cb[0]! ^ 0xff)
    envB['ciphertext'] = cb.toString('base64')

    const newKey = makeKey('new', 'active')
    const rotProv = createMockKeyProvider([
      { ...oldKey, status: 'rotated' },
      newKey,
    ])
    const rot = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: rotProv,
    })
    mock.getSpy.mockResolvedValueOnce([recA, recB])

    const r = await rot.rotateKey('ns', SCOPE)
    expect(r.rotated).toBe(1)
    expect(r.failed).toBe(1)
  })
})

// ===========================================================================
// isEncrypted() — comprehensive validation
// ===========================================================================

describe('EncryptedMemoryService.isEncrypted()', () => {
  it('returns false for primitives', () => {
    expect(EncryptedMemoryService.isEncrypted(0)).toBe(false)
    expect(EncryptedMemoryService.isEncrypted(true)).toBe(false)
    expect(EncryptedMemoryService.isEncrypted(false)).toBe(false)
    expect(EncryptedMemoryService.isEncrypted(123.45)).toBe(false)
    expect(EncryptedMemoryService.isEncrypted([])).toBe(false)
  })

  it('returns false when _encrypted is missing', () => {
    expect(
      EncryptedMemoryService.isEncrypted({
        algorithm: 'aes-256-gcm',
        keyId: 'k',
        ciphertext: 'a',
        iv: 'b',
        authTag: 'c',
      }),
    ).toBe(false)
  })

  it('returns false when _encrypted is not literally true', () => {
    expect(
      EncryptedMemoryService.isEncrypted({
        _encrypted: 'true', // string not bool
        algorithm: 'aes-256-gcm',
        keyId: 'k',
        ciphertext: 'a',
        iv: 'b',
        authTag: 'c',
      }),
    ).toBe(false)
  })

  it('returns false when keyId is not a string', () => {
    expect(
      EncryptedMemoryService.isEncrypted({
        _encrypted: true,
        algorithm: 'aes-256-gcm',
        keyId: 42,
        ciphertext: 'a',
        iv: 'b',
        authTag: 'c',
      }),
    ).toBe(false)
  })

  it('returns false when ciphertext is missing', () => {
    expect(
      EncryptedMemoryService.isEncrypted({
        _encrypted: true,
        algorithm: 'aes-256-gcm',
        keyId: 'k',
        iv: 'b',
        authTag: 'c',
      }),
    ).toBe(false)
  })

  it('returns false when iv is missing', () => {
    expect(
      EncryptedMemoryService.isEncrypted({
        _encrypted: true,
        algorithm: 'aes-256-gcm',
        keyId: 'k',
        ciphertext: 'a',
        authTag: 'c',
      }),
    ).toBe(false)
  })

  it('returns false when authTag is missing', () => {
    expect(
      EncryptedMemoryService.isEncrypted({
        _encrypted: true,
        algorithm: 'aes-256-gcm',
        keyId: 'k',
        ciphertext: 'a',
        iv: 'b',
      }),
    ).toBe(false)
  })

  it('returns true on a complete valid envelope', () => {
    expect(
      EncryptedMemoryService.isEncrypted({
        _encrypted: true,
        algorithm: 'aes-256-gcm',
        keyId: 'k',
        ciphertext: 'a',
        iv: 'b',
        authTag: 'c',
      }),
    ).toBe(true)
  })
})

// ===========================================================================
// Decryption error paths — tampered iv / authTag / unknown algorithm
// ===========================================================================

describe('EncryptedMemoryService — decryption errors', () => {
  let mock: ReturnType<typeof createMockMemoryService>
  let provider: EncryptionKeyProvider
  let service: EncryptedMemoryService

  beforeEach(() => {
    mock = createMockMemoryService()
    provider = createMockKeyProvider([makeKey('k1', 'active')])
    service = new EncryptedMemoryService({
      memoryService: mock.svc,
      keyProvider: provider,
    })
  })

  it('tampered IV produces no decrypted record', async () => {
    await service.put('ns', SCOPE, 'k', { secret: 'x' })
    const stored = mock.putSpy.mock.calls[0]![3] as Record<string, unknown>
    const env = stored['_encrypted_value'] as Record<string, unknown>
    // Replace IV with random garbage
    env['iv'] = randomBytes(12).toString('base64')

    mock.getSpy.mockResolvedValueOnce([stored])
    const result = await service.get('ns', SCOPE)
    expect(result).toHaveLength(0)
  })

  it('tampered authTag produces no decrypted record', async () => {
    await service.put('ns', SCOPE, 'k', { secret: 'x' })
    const stored = mock.putSpy.mock.calls[0]![3] as Record<string, unknown>
    const env = stored['_encrypted_value'] as Record<string, unknown>
    env['authTag'] = randomBytes(16).toString('base64')

    mock.getSpy.mockResolvedValueOnce([stored])
    const result = await service.get('ns', SCOPE)
    expect(result).toHaveLength(0)
  })

  it('record where _encrypted_value has wrong algorithm is treated as plain', async () => {
    const fake = {
      text: 'plain after all',
      _encrypted_value: {
        _encrypted: true,
        algorithm: 'des-cbc', // unsupported
        keyId: 'k1',
        ciphertext: 'aaa',
        iv: 'bbb',
        authTag: 'ccc',
      },
    }
    mock.getSpy.mockResolvedValueOnce([fake])
    const result = await service.get('ns', SCOPE)
    // Treated as non-envelope -> returned as-is
    expect(result).toHaveLength(1)
    expect(result[0]!['text']).toBe('plain after all')
  })
})
