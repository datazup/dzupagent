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
  /** Required capabilities for the sender. */
  requiredCapabilities?: string[]
  /** Optional nonce store for replay prevention. Defaults to in-memory. */
  replayStore?: AgentReplayStore
  /** Optional public-key store. Defaults to in-memory. */
  publicKeyStore?: AgentPublicKeyStore
}

/** Structured capability claims expected in a signed message payload. */
export interface AgentCapabilityClaims {
  /** Capability identifiers granted to the sender. */
  capabilities: string[]
  /** Optional capability-claim expiry as a JWT-style unix timestamp (seconds). */
  capabilitiesExp?: number
}

/** Failure reason codes emitted by AgentAuth verification. */
export type AgentAuthFailureCode =
  | 'message_timestamp_future'
  | 'message_expired'
  | 'invalid_signature'
  | 'verification_error'
  | 'missing_capability_claim'
  | 'malformed_capability_claim'
  | 'expired_capability_claim'
  | 'insufficient_capabilities'
  | 'missing_registered_public_key'
  | 'replay_duplicate_nonce'
  | 'replay_message_too_old'
  | 'replay_message_timestamp_future'

/** Verification stage for deterministic triage and telemetry. */
export type AgentAuthVerificationStage = 'signature' | 'replay' | 'capability' | 'success'

/** Structured failure payload for operator diagnostics. */
export interface AgentAuthFailure {
  code: AgentAuthFailureCode
  stage: Exclude<AgentAuthVerificationStage, 'success'>
  reason: string
  missingCapabilities?: string[]
}

/** Unified AgentAuth result shape for verify/replay/capability stages. */
export interface AgentAuthResult {
  valid: boolean
  reason?: string
  stage: AgentAuthVerificationStage
  failure?: AgentAuthFailure
  capabilities?: string[]
}

/** Replay check result shape retained for backwards compatibility. */
export interface AgentReplayResult {
  allowed: boolean
  reason?: string
  failure?: AgentAuthFailure
}

/** Store contract for replay nonce tracking (supports durable implementations). */
export interface AgentReplayStore {
  hasNonce(nonce: string): boolean
  setNonce(nonce: string, expiresAtMs: number): void
  evictExpired(nowMs: number): void
}

/** Store contract for sender public keys (supports durable implementations). */
export interface AgentPublicKeyStore {
  getPublicKey(agentId: string): Uint8Array | undefined
  setPublicKey(agentId: string, publicKey: Uint8Array): void
}

/** In-memory replay store used by default in local/test runtime. */
export class InMemoryAgentReplayStore implements AgentReplayStore {
  private readonly seenNonces = new Map<string, number>()

  hasNonce(nonce: string): boolean {
    return this.seenNonces.has(nonce)
  }

  setNonce(nonce: string, expiresAtMs: number): void {
    this.seenNonces.set(nonce, expiresAtMs)
  }

  evictExpired(nowMs: number): void {
    for (const [nonce, expiresAt] of this.seenNonces) {
      if (expiresAt <= nowMs) {
        this.seenNonces.delete(nonce)
      }
    }
  }
}

/** In-memory public-key registry used by default in local/test runtime. */
export class InMemoryAgentPublicKeyStore implements AgentPublicKeyStore {
  private readonly keys = new Map<string, Uint8Array>()

  getPublicKey(agentId: string): Uint8Array | undefined {
    const key = this.keys.get(agentId)
    if (!key) {
      return undefined
    }
    return new Uint8Array(key)
  }

  setPublicKey(agentId: string, publicKey: Uint8Array): void {
    this.keys.set(agentId, new Uint8Array(publicKey))
  }
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
  private readonly requiredCapabilities?: readonly string[]
  private readonly replayStore: AgentReplayStore
  private readonly publicKeyStore: AgentPublicKeyStore
  private lastEviction = Date.now()

  constructor(config?: AgentAuthConfig) {
    this.maxMessageAgeMs = config?.maxMessageAgeMs ?? 60_000
    this.allowedClockSkewMs = config?.allowedClockSkewMs ?? 5_000
    if (config?.requiredCapabilities !== undefined) {
      this.requiredCapabilities = config.requiredCapabilities.slice()
    }
    this.replayStore = config?.replayStore ?? new InMemoryAgentReplayStore()
    this.publicKeyStore = config?.publicKeyStore ?? new InMemoryAgentPublicKeyStore()
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
  ): AgentAuthResult {
    try {
      const freshness = this.verifyMessageFreshness(message)
      if (!freshness.valid) {
        return freshness
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
        return this.failureResult('signature', 'invalid_signature', 'Invalid signature')
      }

      return this.verifyCapabilityClaims(message)
    } catch {
      return this.failureResult('signature', 'verification_error', 'Verification error')
    }
  }

  // -------------------------------------------------------------------------
  // Replay prevention
  // -------------------------------------------------------------------------

  /** Check whether a message should be rejected for replay or staleness. */
  checkReplay(message: SignedAgentMessage): AgentReplayResult {
    // Evict expired nonces periodically
    this.evictExpiredNonces()

    // Timestamp check
    const age = Date.now() - message.timestamp
    if (age < -this.allowedClockSkewMs) {
      return {
        allowed: false,
        reason: 'Message timestamp is too far in the future',
        failure: {
          code: 'replay_message_timestamp_future',
          stage: 'replay',
          reason: 'Message timestamp is too far in the future',
        },
      }
    }
    if (age > this.maxMessageAgeMs) {
      return {
        allowed: false,
        reason: 'Message too old',
        failure: { code: 'replay_message_too_old', stage: 'replay', reason: 'Message too old' },
      }
    }

    // Nonce uniqueness
    if (this.replayStore.hasNonce(message.nonce)) {
      return {
        allowed: false,
        reason: 'Duplicate nonce (replay detected)',
        failure: {
          code: 'replay_duplicate_nonce',
          stage: 'replay',
          reason: 'Duplicate nonce (replay detected)',
        },
      }
    }

    // Record nonce with expiry
    this.replayStore.setNonce(message.nonce, Date.now() + this.maxMessageAgeMs)
    return { allowed: true }
  }

  // -------------------------------------------------------------------------
  // Public key registry
  // -------------------------------------------------------------------------

  /** Register a public key for an agent (for later verification). */
  registerPublicKey(agentId: string, publicKey: Uint8Array): void {
    this.publicKeyStore.setPublicKey(agentId, publicKey)
  }

  /** Verify a message using the registered public key for its sender. */
  verifyWithRegisteredKey(
    message: SignedAgentMessage,
  ): AgentAuthResult {
    const publicKey = this.publicKeyStore.getPublicKey(message.senderId)
    if (!publicKey) {
      const reason = `No registered key for agent: ${message.senderId}`
      return this.failureResult('signature', 'missing_registered_public_key', reason)
    }
    return this.verifyMessage(message, publicKey)
  }

  /**
   * Deterministic combined verification helper:
   * signature -> replay -> capability (capability is checked inside signature verification).
   */
  verifyAndAuthorizeMessage(
    message: SignedAgentMessage,
    publicKey: Uint8Array,
  ): AgentAuthResult {
    const signatureResult = this.verifyMessage(message, publicKey)
    if (!signatureResult.valid) {
      return signatureResult
    }

    const replayResult = this.checkReplay(message)
    if (!replayResult.allowed) {
      return this.failureResult(
        'replay',
        replayResult.failure?.code ?? 'replay_duplicate_nonce',
        replayResult.reason ?? 'Replay check failed',
      )
    }

    return {
      valid: true,
      stage: 'success',
      ...(signatureResult.capabilities !== undefined
        ? { capabilities: signatureResult.capabilities }
        : {}),
    }
  }

  /**
   * Combined verification helper using the registered sender key:
   * signature -> replay -> capability.
   */
  verifyAndAuthorizeWithRegisteredKey(message: SignedAgentMessage): AgentAuthResult {
    const publicKey = this.publicKeyStore.getPublicKey(message.senderId)
    if (!publicKey) {
      const reason = `No registered key for agent: ${message.senderId}`
      return this.failureResult('signature', 'missing_registered_public_key', reason)
    }
    return this.verifyAndAuthorizeMessage(message, publicKey)
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
    this.replayStore.evictExpired(now)
  }

  private verifyMessageFreshness(message: SignedAgentMessage): AgentAuthResult {
    const age = Date.now() - message.timestamp
    if (age < -this.allowedClockSkewMs) {
      return this.failureResult(
        'signature',
        'message_timestamp_future',
        'Message timestamp is too far in the future',
      )
    }
    if (age > this.maxMessageAgeMs) {
      return this.failureResult('signature', 'message_expired', 'Message expired')
    }
    return { valid: true, stage: 'signature' }
  }

  private verifyCapabilityClaims(message: SignedAgentMessage): AgentAuthResult {
    if (!this.requiredCapabilities || this.requiredCapabilities.length === 0) {
      return { valid: true, stage: 'success' }
    }

    const capabilityClaims = this.extractCapabilityClaims(message.payload)
    if (capabilityClaims.kind === 'failure') {
      return capabilityClaims.failure
    }

    const claimedCapabilities = capabilityClaims.capabilities
    const missingCapabilities = this.requiredCapabilities.filter(
      (capability) => !claimedCapabilities.includes(capability),
    )
    if (missingCapabilities.length > 0) {
      return this.failureResult(
        'capability',
        'insufficient_capabilities',
        `Missing required capabilities: ${missingCapabilities.join(', ')}`,
        missingCapabilities,
      )
    }

    return {
      valid: true,
      stage: 'success',
      capabilities: claimedCapabilities,
    }
  }

  private extractCapabilityClaims(payload: string):
    | { kind: 'ok'; capabilities: string[] }
    | { kind: 'failure'; failure: AgentAuthResult } {
    const fail = (
      code: AgentAuthFailureCode,
      reason: string,
    ): { kind: 'failure'; failure: AgentAuthResult } => ({
      kind: 'failure',
      failure: this.failureResult('capability', code, reason),
    })

    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      return fail('malformed_capability_claim', 'Capability claim payload must be valid UTF-8 JSON')
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail('malformed_capability_claim', 'Capability claim payload must be a JSON object')
    }

    const record = parsed as Record<string, unknown>
    const capabilitiesValue = record['capabilities']
    if (capabilitiesValue === undefined) {
      return fail('missing_capability_claim', 'Missing capabilities claim')
    }

    if (
      !Array.isArray(capabilitiesValue) ||
      capabilitiesValue.some((entry) => typeof entry !== 'string')
    ) {
      return fail('malformed_capability_claim', 'Capabilities claim must be a string array')
    }

    const normalizedCapabilities = capabilitiesValue.map((entry) => entry.trim())
    if (normalizedCapabilities.some((entry) => entry.length === 0)) {
      return fail('malformed_capability_claim', 'Capabilities claim contains empty entries')
    }

    const expirationValue = record['capabilitiesExp'] ?? record['exp']
    if (expirationValue !== undefined) {
      if (typeof expirationValue !== 'number' || !Number.isFinite(expirationValue)) {
        return fail(
          'malformed_capability_claim',
          'Capability claim expiry must be a finite number',
        )
      }
      if (expirationValue <= Math.floor(Date.now() / 1000)) {
        return fail('expired_capability_claim', 'Capability claim expired')
      }
    }

    return { kind: 'ok', capabilities: normalizedCapabilities }
  }

  private failureResult(
    stage: Exclude<AgentAuthVerificationStage, 'success'>,
    code: AgentAuthFailureCode,
    reason: string,
    missingCapabilities?: string[],
  ): AgentAuthResult {
    const failure: AgentAuthFailure = {
      code,
      stage,
      reason,
      ...(missingCapabilities !== undefined ? { missingCapabilities } : {}),
    }
    return {
      valid: false,
      reason,
      stage,
      failure,
    }
  }
}
