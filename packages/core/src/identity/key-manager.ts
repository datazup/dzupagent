/**
 * Ed25519 key management — generation, signing, verification, and rotation.
 *
 * Uses `node:crypto` exclusively (no external deps).
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, randomUUID } from 'node:crypto'

import type { KeyStore, SignedDocument, SigningKeyPair, SigningKeyStatus } from './signing-types.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Configuration for creating a KeyManager. */
export interface KeyManagerConfig {
  /** Store used to persist key pairs. */
  store: KeyStore
}

// ---------------------------------------------------------------------------
// KeyManager interface
// ---------------------------------------------------------------------------

/** Ed25519 key manager for signing and verifying agent documents. */
export interface KeyManager {
  /** Generate a new Ed25519 key pair and persist it as active. */
  generate(): Promise<SigningKeyPair>
  /** Sign arbitrary data using the specified (or active) key. Returns Base64URL signature. */
  sign(data: unknown, keyId?: string): Promise<string>
  /** Verify a Base64URL signature against data and a public key. */
  verify(data: unknown, signature: string, publicKey: Uint8Array): Promise<boolean>
  /** Rotate keys: generate a new active key and mark the old one as 'expiring'. */
  rotate(): Promise<SigningKeyPair>
  /** Get the currently active key pair. */
  getActiveKey(): Promise<SigningKeyPair | undefined>
  /** Sign a document, wrapping it in a SignedDocument envelope. */
  signDocument<T>(doc: T, keyId?: string): Promise<SignedDocument<T>>
  /** Verify a SignedDocument against a public key. */
  verifyDocument<T>(signed: SignedDocument<T>, publicKey: Uint8Array): Promise<boolean>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Canonical JSON serialization for signing (deterministic key order). */
function canonicalize(data: unknown): Buffer {
  return Buffer.from(JSON.stringify(data, (_key, value: unknown) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      const sorted: Record<string, unknown> = {}
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k]
      }
      return sorted
    }
    return value
  }), 'utf-8')
}

/** Encode a Buffer as Base64URL (no padding). */
function toBase64Url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** Decode a Base64URL string to a Buffer. */
function fromBase64Url(str: string): Buffer {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/')
  const pad = 4 - (base64.length % 4)
  if (pad !== 4) {
    base64 += '='.repeat(pad)
  }
  return Buffer.from(base64, 'base64')
}

// ---------------------------------------------------------------------------
// InMemoryKeyStore
// ---------------------------------------------------------------------------

/** In-memory implementation of KeyStore. Useful for testing and ephemeral agents. */
export class InMemoryKeyStore implements KeyStore {
  private readonly keys = new Map<string, SigningKeyPair>()

  async save(keyPair: SigningKeyPair): Promise<void> {
    this.keys.set(keyPair.keyId, { ...keyPair })
  }

  async get(keyId: string): Promise<SigningKeyPair | undefined> {
    const kp = this.keys.get(keyId)
    return kp ? { ...kp } : undefined
  }

  async getActive(): Promise<SigningKeyPair | undefined> {
    for (const kp of this.keys.values()) {
      if (kp.status === 'active') {
        return { ...kp }
      }
    }
    return undefined
  }

  async list(): Promise<SigningKeyPair[]> {
    return [...this.keys.values()].map((kp) => ({ ...kp }))
  }

  async updateStatus(keyId: string, status: SigningKeyStatus): Promise<void> {
    const kp = this.keys.get(keyId)
    if (kp) {
      kp.status = status
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a KeyManager backed by the given store. */
export function createKeyManager(config: KeyManagerConfig): KeyManager {
  const { store } = config

  async function getKeyOrThrow(keyId?: string): Promise<SigningKeyPair> {
    if (keyId) {
      const kp = await store.get(keyId)
      if (!kp) {
        throw new Error(`Signing key not found: ${keyId}`)
      }
      return kp
    }
    const active = await store.getActive()
    if (!active) {
      throw new Error('No active signing key. Call generate() first.')
    }
    return active
  }

  const manager: KeyManager = {
    async generate(): Promise<SigningKeyPair> {
      const { publicKey: pubKeyObj, privateKey: privKeyObj } = generateKeyPairSync('ed25519')

      // Export raw key bytes
      const publicKeyDer = pubKeyObj.export({ type: 'spki', format: 'der' })
      const privateKeyDer = privKeyObj.export({ type: 'pkcs8', format: 'der' })

      // Ed25519 raw public key is the last 32 bytes of the SPKI DER
      const publicKey = new Uint8Array(publicKeyDer.subarray(publicKeyDer.length - 32))
      // Ed25519 PKCS8 DER contains the 32-byte seed starting at byte 16
      const privateKey = new Uint8Array(privateKeyDer.subarray(16, 48))

      const keyPair: SigningKeyPair = {
        keyId: randomUUID(),
        publicKey,
        privateKey,
        algorithm: 'Ed25519',
        createdAt: new Date(),
        status: 'active',
      }

      await store.save(keyPair)
      return keyPair
    },

    async sign(data: unknown, keyId?: string): Promise<string> {
      const kp = await getKeyOrThrow(keyId)
      const payload = canonicalize(data)

      // Reconstruct a KeyObject from the raw private key bytes
      const privKeyObj = createPrivateKey({
        key: Buffer.concat([
          // Ed25519 PKCS8 DER prefix (16 bytes) + 32-byte seed
          Buffer.from('302e020100300506032b657004220420', 'hex'),
          Buffer.from(kp.privateKey),
        ]),
        format: 'der',
        type: 'pkcs8',
      })

      const sig = sign(null, payload, privKeyObj)
      return toBase64Url(sig)
    },

    async verify(data: unknown, signature: string, publicKey: Uint8Array): Promise<boolean> {
      try {
        const payload = canonicalize(data)
        const sigBuf = fromBase64Url(signature)

        // Reconstruct a KeyObject from raw public key bytes
        const pubKeyObj = createPublicKey({
          key: Buffer.concat([
            // Ed25519 SPKI DER prefix (12 bytes) + 32-byte public key
            Buffer.from('302a300506032b6570032100', 'hex'),
            Buffer.from(publicKey),
          ]),
          format: 'der',
          type: 'spki',
        })

        return verify(null, payload, pubKeyObj, sigBuf)
      } catch {
        return false
      }
    },

    async rotate(): Promise<SigningKeyPair> {
      const current = await store.getActive()
      if (current) {
        await store.updateStatus(current.keyId, 'expiring')
      }
      return manager.generate()
    },

    async getActiveKey(): Promise<SigningKeyPair | undefined> {
      return store.getActive()
    },

    async signDocument<T>(doc: T, keyId?: string): Promise<SignedDocument<T>> {
      const kp = await getKeyOrThrow(keyId)
      const signedAt = new Date().toISOString()

      // The signable content includes the document and timestamp
      const signable = { document: doc, signedAt, keyId: kp.keyId, algorithm: 'Ed25519' as const }
      const signature = await manager.sign(signable, kp.keyId)

      return {
        document: doc,
        signature,
        signedAt,
        keyId: kp.keyId,
        algorithm: 'Ed25519',
      }
    },

    async verifyDocument<T>(signed: SignedDocument<T>, publicKey: Uint8Array): Promise<boolean> {
      const signable = {
        document: signed.document,
        signedAt: signed.signedAt,
        keyId: signed.keyId,
        algorithm: signed.algorithm,
      }
      return manager.verify(signable, signed.signature, publicKey)
    },
  }

  return manager
}
