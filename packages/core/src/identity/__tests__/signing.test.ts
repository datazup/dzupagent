import { describe, it, expect } from 'vitest'
import { createKeyManager, InMemoryKeyStore } from '../key-manager.js'
import type { SigningKeyPair } from '../signing-types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore(): InMemoryKeyStore {
  return new InMemoryKeyStore()
}

function makeManager(store?: InMemoryKeyStore) {
  return createKeyManager({ store: store ?? makeStore() })
}

// ---------------------------------------------------------------------------
// InMemoryKeyStore
// ---------------------------------------------------------------------------

describe('InMemoryKeyStore', () => {
  it('save and get round-trip', async () => {
    const store = makeStore()
    const kp: SigningKeyPair = {
      keyId: 'k1',
      publicKey: new Uint8Array([1, 2, 3]),
      privateKey: new Uint8Array([4, 5, 6]),
      algorithm: 'Ed25519',
      createdAt: new Date(),
      status: 'active',
    }
    await store.save(kp)
    const retrieved = await store.get('k1')
    expect(retrieved).toBeDefined()
    expect(retrieved!.keyId).toBe('k1')
    expect(retrieved!.status).toBe('active')
  })

  it('get returns undefined for unknown key', async () => {
    const store = makeStore()
    const result = await store.get('nonexistent')
    expect(result).toBeUndefined()
  })

  it('getActive returns the active key', async () => {
    const store = makeStore()
    const kp1: SigningKeyPair = {
      keyId: 'k1',
      publicKey: new Uint8Array([1]),
      privateKey: new Uint8Array([2]),
      algorithm: 'Ed25519',
      createdAt: new Date(),
      status: 'expiring',
    }
    const kp2: SigningKeyPair = {
      keyId: 'k2',
      publicKey: new Uint8Array([3]),
      privateKey: new Uint8Array([4]),
      algorithm: 'Ed25519',
      createdAt: new Date(),
      status: 'active',
    }
    await store.save(kp1)
    await store.save(kp2)
    const active = await store.getActive()
    expect(active).toBeDefined()
    expect(active!.keyId).toBe('k2')
  })

  it('getActive returns undefined when no active keys', async () => {
    const store = makeStore()
    const kp: SigningKeyPair = {
      keyId: 'k1',
      publicKey: new Uint8Array([1]),
      privateKey: new Uint8Array([2]),
      algorithm: 'Ed25519',
      createdAt: new Date(),
      status: 'revoked',
    }
    await store.save(kp)
    const active = await store.getActive()
    expect(active).toBeUndefined()
  })

  it('list returns all keys', async () => {
    const store = makeStore()
    await store.save({
      keyId: 'k1', publicKey: new Uint8Array([1]), privateKey: new Uint8Array([2]),
      algorithm: 'Ed25519', createdAt: new Date(), status: 'active',
    })
    await store.save({
      keyId: 'k2', publicKey: new Uint8Array([3]), privateKey: new Uint8Array([4]),
      algorithm: 'Ed25519', createdAt: new Date(), status: 'expiring',
    })
    const all = await store.list()
    expect(all).toHaveLength(2)
  })

  it('updateStatus changes key status', async () => {
    const store = makeStore()
    await store.save({
      keyId: 'k1', publicKey: new Uint8Array([1]), privateKey: new Uint8Array([2]),
      algorithm: 'Ed25519', createdAt: new Date(), status: 'active',
    })
    await store.updateStatus('k1', 'revoked')
    const kp = await store.get('k1')
    expect(kp!.status).toBe('revoked')
  })

  it('updateStatus is a no-op for unknown key', async () => {
    const store = makeStore()
    // Should not throw
    await store.updateStatus('nonexistent', 'revoked')
  })
})

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

describe('KeyManager.generate', () => {
  it('produces a valid Ed25519 key pair', async () => {
    const manager = makeManager()
    const kp = await manager.generate()

    expect(kp.keyId).toBeTruthy()
    expect(kp.algorithm).toBe('Ed25519')
    expect(kp.status).toBe('active')
    expect(kp.publicKey).toBeInstanceOf(Uint8Array)
    expect(kp.privateKey).toBeInstanceOf(Uint8Array)
    expect(kp.publicKey.length).toBe(32)
    expect(kp.privateKey.length).toBe(32)
    expect(kp.createdAt).toBeInstanceOf(Date)
  })

  it('persists the key in the store', async () => {
    const store = makeStore()
    const manager = makeManager(store)
    const kp = await manager.generate()

    const retrieved = await store.get(kp.keyId)
    expect(retrieved).toBeDefined()
    expect(retrieved!.keyId).toBe(kp.keyId)
  })
})

// ---------------------------------------------------------------------------
// Sign / Verify round-trip
// ---------------------------------------------------------------------------

describe('KeyManager.sign and verify', () => {
  it('sign/verify round-trip succeeds', async () => {
    const manager = makeManager()
    const kp = await manager.generate()

    const data = { message: 'hello', count: 42 }
    const signature = await manager.sign(data)
    const valid = await manager.verify(data, signature, kp.publicKey)
    expect(valid).toBe(true)
  })

  it('verify fails with wrong data', async () => {
    const manager = makeManager()
    const kp = await manager.generate()

    const signature = await manager.sign({ original: true })
    const valid = await manager.verify({ tampered: true }, signature, kp.publicKey)
    expect(valid).toBe(false)
  })

  it('verify fails with wrong key', async () => {
    const manager1 = makeManager()
    const manager2 = makeManager()
    await manager1.generate()
    const kp2 = await manager2.generate()

    const data = { test: 'data' }
    const signature = await manager1.sign(data)
    const valid = await manager1.verify(data, signature, kp2.publicKey)
    expect(valid).toBe(false)
  })

  it('sign throws when no active key', async () => {
    const manager = makeManager()
    await expect(manager.sign({ data: 'test' })).rejects.toThrow('No active signing key')
  })

  it('sign with specific keyId', async () => {
    const manager = makeManager()
    const kp = await manager.generate()

    const signature = await manager.sign({ data: 'test' }, kp.keyId)
    const valid = await manager.verify({ data: 'test' }, signature, kp.publicKey)
    expect(valid).toBe(true)
  })

  it('sign throws for unknown keyId', async () => {
    const manager = makeManager()
    await manager.generate()
    await expect(manager.sign({ data: 'test' }, 'nonexistent')).rejects.toThrow('Signing key not found')
  })

  it('verify returns false for garbage signature', async () => {
    const manager = makeManager()
    const kp = await manager.generate()
    const valid = await manager.verify({ data: 'test' }, 'not-a-valid-signature!!', kp.publicKey)
    expect(valid).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// signDocument / verifyDocument
// ---------------------------------------------------------------------------

describe('KeyManager.signDocument and verifyDocument', () => {
  it('signDocument/verifyDocument round-trip', async () => {
    const manager = makeManager()
    const kp = await manager.generate()

    const doc = { name: 'test-agent', version: '1.0.0' }
    const signed = await manager.signDocument(doc)

    expect(signed.document).toEqual(doc)
    expect(signed.signature).toBeTruthy()
    expect(signed.keyId).toBe(kp.keyId)
    expect(signed.algorithm).toBe('Ed25519')
    expect(signed.signedAt).toBeTruthy()

    const valid = await manager.verifyDocument(signed, kp.publicKey)
    expect(valid).toBe(true)
  })

  it('verifyDocument fails with tampered document', async () => {
    const manager = makeManager()
    const kp = await manager.generate()

    const signed = await manager.signDocument({ name: 'original' })
    // Tamper
    const tampered = { ...signed, document: { name: 'tampered' } }
    const valid = await manager.verifyDocument(tampered, kp.publicKey)
    expect(valid).toBe(false)
  })

  it('verifyDocument fails with tampered signedAt', async () => {
    const manager = makeManager()
    const kp = await manager.generate()

    const signed = await manager.signDocument({ name: 'test' })
    const tampered = { ...signed, signedAt: '2020-01-01T00:00:00.000Z' }
    const valid = await manager.verifyDocument(tampered, kp.publicKey)
    expect(valid).toBe(false)
  })

  it('verifyDocument fails with wrong public key', async () => {
    const manager1 = makeManager()
    const manager2 = makeManager()
    await manager1.generate()
    const kp2 = await manager2.generate()

    const signed = await manager1.signDocument({ name: 'test' })
    const valid = await manager1.verifyDocument(signed, kp2.publicKey)
    expect(valid).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Key rotation
// ---------------------------------------------------------------------------

describe('KeyManager.rotate', () => {
  it('generates new active key and marks old as expiring', async () => {
    const store = makeStore()
    const manager = makeManager(store)

    const first = await manager.generate()
    expect(first.status).toBe('active')

    const second = await manager.rotate()
    expect(second.status).toBe('active')
    expect(second.keyId).not.toBe(first.keyId)

    // Old key should now be 'expiring'
    const oldKey = await store.get(first.keyId)
    expect(oldKey!.status).toBe('expiring')

    // New key is the active one
    const active = await manager.getActiveKey()
    expect(active).toBeDefined()
    expect(active!.keyId).toBe(second.keyId)
  })

  it('rotate works when no previous active key', async () => {
    const manager = makeManager()
    const kp = await manager.rotate()
    expect(kp.status).toBe('active')
    expect(kp.publicKey.length).toBe(32)
  })
})

// ---------------------------------------------------------------------------
// getActiveKey
// ---------------------------------------------------------------------------

describe('KeyManager.getActiveKey', () => {
  it('returns undefined before any key is generated', async () => {
    const manager = makeManager()
    const active = await manager.getActiveKey()
    expect(active).toBeUndefined()
  })

  it('returns the active key after generation', async () => {
    const manager = makeManager()
    const kp = await manager.generate()
    const active = await manager.getActiveKey()
    expect(active).toBeDefined()
    expect(active!.keyId).toBe(kp.keyId)
  })
})
