/**
 * Type contracts for cross-agent authentication.
 *
 * @module security/agent-auth/types
 */

/** Credential pair for an agent, containing its Ed25519 keys. */
export interface AgentCredential {
  agentId: string;
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  createdAt: Date;
}

/** A signed message envelope for inter-agent communication. */
export interface SignedAgentMessage {
  /** JSON string of the original message */
  payload: string;
  /** Base64URL Ed25519 signature */
  signature: string;
  /** Agent that signed the message */
  senderId: string;
  /** Random nonce for replay prevention */
  nonce: string;
  /** Unix milliseconds timestamp */
  timestamp: number;
}

/** Configuration for AgentAuth. */
export interface AgentAuthConfig {
  /** Maximum age of a message before it is rejected (default: 60000ms = 1 min) */
  maxMessageAgeMs?: number;
  /** Allowed sender clock skew into the future (default: 5000ms) */
  allowedClockSkewMs?: number;
  /** Required capabilities for the sender. */
  requiredCapabilities?: string[];
  /** Optional nonce store for replay prevention. Defaults to in-memory. */
  replayStore?: AgentReplayStore;
  /** Optional public-key store. Defaults to in-memory. */
  publicKeyStore?: AgentPublicKeyStore;
}

/** Structured capability claims expected in a signed message payload. */
export interface AgentCapabilityClaims {
  /** Capability identifiers granted to the sender. */
  capabilities: string[];
  /** Optional capability-claim expiry as a JWT-style unix timestamp (seconds). */
  capabilitiesExp?: number;
}

/** Failure reason codes emitted by AgentAuth verification. */
export type AgentAuthFailureCode =
  | "message_timestamp_future"
  | "message_expired"
  | "invalid_signature"
  | "verification_error"
  | "missing_capability_claim"
  | "malformed_capability_claim"
  | "expired_capability_claim"
  | "insufficient_capabilities"
  | "missing_registered_public_key"
  | "replay_duplicate_nonce"
  | "replay_message_too_old"
  | "replay_message_timestamp_future";

/** Verification stage for deterministic triage and telemetry. */
export type AgentAuthVerificationStage =
  | "signature"
  | "replay"
  | "capability"
  | "success";

/** Structured failure payload for operator diagnostics. */
export interface AgentAuthFailure {
  code: AgentAuthFailureCode;
  stage: Exclude<AgentAuthVerificationStage, "success">;
  reason: string;
  missingCapabilities?: string[];
}

/** Unified AgentAuth result shape for verify/replay/capability stages. */
export interface AgentAuthResult {
  valid: boolean;
  reason?: string;
  stage: AgentAuthVerificationStage;
  failure?: AgentAuthFailure;
  capabilities?: string[];
}

/** Replay check result shape retained for backwards compatibility. */
export interface AgentReplayResult {
  allowed: boolean;
  reason?: string;
  failure?: AgentAuthFailure;
}

/** Store contract for replay nonce tracking (supports durable implementations). */
export interface AgentReplayStore {
  hasNonce(nonce: string): boolean;
  setNonce(nonce: string, expiresAtMs: number): void;
  evictExpired(nowMs: number): void;
}

/** Store contract for sender public keys (supports durable implementations). */
export interface AgentPublicKeyStore {
  getPublicKey(agentId: string): Uint8Array | undefined;
  setPublicKey(agentId: string, publicKey: Uint8Array): void;
}
