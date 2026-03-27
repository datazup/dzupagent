/**
 * Cross-agent authentication — Ed25519 message signing, verification,
 * and replay prevention for secure inter-agent communication.
 *
 * Uses `node:crypto` exclusively (same pattern as core key-manager).
 *
 * @module security/agent-auth
 */
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  randomBytes,
} from 'node:crypto'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Credential pair for an agent, containing its Ed25519 keys. */
export interface AgentCredential {
  agentId: string
  publicKey: Uint8Array
  privateKey: Uint8Array
  createdAt: Date
}

/** A signed message envelope for inter-agent communication. */
export interface SignedAgentMessage {
  /** JSON string of the original message */
  payload: string
  /** Base64URL Ed25519 signature */
  signature: string
  /** Agent that signed the message */
  senderId: string
  /** Random nonce for replay prevention */
  nonce: string
  /** Unix milliseconds timestamp */
  timestamp: number
}

/** Configuration for AgentAuth. */
export interface AgentAuthConfig {
  /** Maximum age of a message before it is rejected (default: 60000ms = 1 min) */
  maxMessageAgeMs?: number
  /** Allowed sender clock skew into the future (default: 5000ms) */
  allowedClockSkewMs?: number
  /** Required capabilities for the sender (checked via PolicyEvaluator if provided) */
  requiredCapabilities?: string[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Canonical JSON serialization with sorted keys for deterministic signing. */
function canonicalize(data: unknown): Buffer {
  return Buffer.from(
    JSON.stringify(data, (_key, value: unknown) => {
      if (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        !(value instanceof Date)
      ) {
        const sorted: Record<string, unknown> = {}
        for (const k of Object.keys(value as Record<string, unknown>).sort()) {
          sorted[k] = (value as Record<string, unknown>)[k]
        }
        return sorted
      }
      return value
    }),
    'utf-8',
  )
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

/** Build a PKCS8 DER key object from 32-byte Ed25519 private key seed. */
function privateKeyFromRaw(raw: Uint8Array): ReturnType<typeof createPrivateKey> {
  return createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.from(raw),
    ]),
    format: 'der',
    type: 'pkcs8',
  })
}

/** Build an SPKI DER key object from 32-byte Ed25519 public key. */
function publicKeyFromRaw(raw: Uint8Array): ReturnType<typeof createPublicKey> {
  return createPublicKey({
    key: Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(raw),
    ]),
    format: 'der',
    type: 'spki',
  })
}

// ---------------------------------------------------------------------------
// AgentAuth
// ---------------------------------------------------------------------------

/**
 * Cross-agent authentication using Ed25519 signatures.
 *
 * Provides key generation, message signing/verification, and replay prevention.
 */
export class AgentAuth {
  private readonly maxMessageAgeMs: number
  private readonly allowedClockSkewMs: number
  private readonly seenNonces = new Map<string, number>() // nonce -> expiry timestamp
  private readonly registeredKeys = new Map<string, Uint8Array>() // agentId -> publicKey
  private lastEviction = Date.now()

  constructor(config?: AgentAuthConfig) {
    this.maxMessageAgeMs = config?.maxMessageAgeMs ?? 60_000
    this.allowedClockSkewMs = config?.allowedClockSkewMs ?? 5_000
  }

  // -------------------------------------------------------------------------
  // Key generation
  // -------------------------------------------------------------------------

  /** Generate a new Ed25519 key pair for an agent. */
  generateCredential(agentId: string): AgentCredential {
    const { publicKey: pubKeyObj, privateKey: privKeyObj } = generateKeyPairSync('ed25519')

    const publicKeyDer = pubKeyObj.export({ type: 'spki', format: 'der' })
    const privateKeyDer = privKeyObj.export({ type: 'pkcs8', format: 'der' })

    // Ed25519 raw public key = last 32 bytes of SPKI DER
    const publicKey = new Uint8Array(publicKeyDer.subarray(publicKeyDer.length - 32))
    // Ed25519 PKCS8 DER contains the 32-byte seed starting at byte 16
    const privateKey = new Uint8Array(privateKeyDer.subarray(16, 48))

    return { agentId, publicKey, privateKey, createdAt: new Date() }
  }

  // -------------------------------------------------------------------------
  // Signing
  // -------------------------------------------------------------------------

  /** Sign a message payload, producing a SignedAgentMessage envelope. */
  signMessage(payload: unknown, credential: AgentCredential): SignedAgentMessage {
    const payloadStr = JSON.stringify(payload)
    const nonce = randomBytes(16).toString('hex')
    const timestamp = Date.now()

    // Build canonical signable content
    const signable = { nonce, payload: payloadStr, senderId: credential.agentId, timestamp }
    const canonical = canonicalize(signable)

    const privKey = privateKeyFromRaw(credential.privateKey)
    const sig = sign(null, canonical, privKey)

    return {
      payload: payloadStr,
      signature: toBase64Url(sig),
      senderId: credential.agentId,
      nonce,
      timestamp,
    }
  }

  // -------------------------------------------------------------------------
  // Verification
  // -------------------------------------------------------------------------

  /** Verify a signed message against a provided public key. */
  verifyMessage(
    message: SignedAgentMessage,
    publicKey: Uint8Array,
  ): { valid: boolean; reason?: string } {
    try {
      // Check timestamp freshness
      const age = Date.now() - message.timestamp
      if (age < -this.allowedClockSkewMs) {
        return { valid: false, reason: 'Message timestamp is too far in the future' }
      }
      if (age > this.maxMessageAgeMs) {
        return { valid: false, reason: 'Message expired' }
      }

      // Rebuild canonical signable
      const signable = {
        nonce: message.nonce,
        payload: message.payload,
        senderId: message.senderId,
        timestamp: message.timestamp,
      }
      const canonical = canonicalize(signable)
      const sigBuf = fromBase64Url(message.signature)
      const pubKey = publicKeyFromRaw(publicKey)

      const isValid = verify(null, canonical, pubKey, sigBuf)
      if (!isValid) {
        return { valid: false, reason: 'Invalid signature' }
      }
      return { valid: true }
    } catch {
      return { valid: false, reason: 'Verification error' }
    }
  }

  // -------------------------------------------------------------------------
  // Replay prevention
  // -------------------------------------------------------------------------

  /** Check whether a message should be rejected for replay or staleness. */
  checkReplay(message: SignedAgentMessage): { allowed: boolean; reason?: string } {
    // Evict expired nonces periodically
    this.evictExpiredNonces()

    // Timestamp check
    const age = Date.now() - message.timestamp
    if (age < -this.allowedClockSkewMs) {
      return { allowed: false, reason: 'Message timestamp is too far in the future' }
    }
    if (age > this.maxMessageAgeMs) {
      return { allowed: false, reason: 'Message too old' }
    }

    // Nonce uniqueness
    if (this.seenNonces.has(message.nonce)) {
      return { allowed: false, reason: 'Duplicate nonce (replay detected)' }
    }

    // Record nonce with expiry
    this.seenNonces.set(message.nonce, Date.now() + this.maxMessageAgeMs)
    return { allowed: true }
  }

  // -------------------------------------------------------------------------
  // Public key registry
  // -------------------------------------------------------------------------

  /** Register a public key for an agent (for later verification). */
  registerPublicKey(agentId: string, publicKey: Uint8Array): void {
    this.registeredKeys.set(agentId, new Uint8Array(publicKey))
  }

  /** Verify a message using the registered public key for its sender. */
  verifyWithRegisteredKey(
    message: SignedAgentMessage,
  ): { valid: boolean; reason?: string } {
    const publicKey = this.registeredKeys.get(message.senderId)
    if (!publicKey) {
      return { valid: false, reason: `No registered key for agent: ${message.senderId}` }
    }
    return this.verifyMessage(message, publicKey)
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /** Evict expired nonces to prevent unbounded growth. */
  private evictExpiredNonces(): void {
    const now = Date.now()
    // Only evict every maxMessageAgeMs to avoid overhead
    if (now - this.lastEviction < this.maxMessageAgeMs) {
      return
    }
    this.lastEviction = now
    for (const [nonce, expiry] of this.seenNonces) {
      if (expiry <= now) {
        this.seenNonces.delete(nonce)
      }
    }
  }
}
