/**
 * Signing and key management types for DzipAgent identity.
 *
 * Used for Ed25519 agent card signing and document verification.
 */

// ---------------------------------------------------------------------------
// Key pair
// ---------------------------------------------------------------------------

/** Status of a signing key pair. */
export type SigningKeyStatus = 'active' | 'expiring' | 'revoked'

/** An Ed25519 signing key pair managed by the key manager. */
export interface SigningKeyPair {
  /** Unique identifier for this key pair. */
  keyId: string
  /** Raw Ed25519 public key bytes. */
  publicKey: Uint8Array
  /** Raw Ed25519 private key bytes. */
  privateKey: Uint8Array
  /** Algorithm used — always Ed25519. */
  algorithm: 'Ed25519'
  /** When this key was generated. */
  createdAt: Date
  /** Optional expiration date. */
  expiresAt?: Date
  /** Current lifecycle status. */
  status: SigningKeyStatus
}

// ---------------------------------------------------------------------------
// Signed document
// ---------------------------------------------------------------------------

/** A document with its cryptographic signature and metadata. */
export interface SignedDocument<T> {
  /** The original document payload. */
  document: T
  /** Base64URL-encoded Ed25519 signature. */
  signature: string
  /** ISO 8601 timestamp of when the signature was created. */
  signedAt: string
  /** ID of the key used to produce the signature. */
  keyId: string
  /** Algorithm used — always Ed25519. */
  algorithm: 'Ed25519'
}

/** A signed agent card (document is a generic record). */
export type SignedAgentCard = SignedDocument<Record<string, unknown>>

// ---------------------------------------------------------------------------
// Key store
// ---------------------------------------------------------------------------

/** Persistence interface for signing key pairs. */
export interface KeyStore {
  /** Persist a key pair. */
  save(keyPair: SigningKeyPair): Promise<void>
  /** Retrieve a key pair by its ID. */
  get(keyId: string): Promise<SigningKeyPair | undefined>
  /** Get the currently active key pair (if any). */
  getActive(): Promise<SigningKeyPair | undefined>
  /** List all stored key pairs. */
  list(): Promise<SigningKeyPair[]>
  /** Update the status of a key pair. */
  updateStatus(keyId: string, status: SigningKeyStatus): Promise<void>
}
