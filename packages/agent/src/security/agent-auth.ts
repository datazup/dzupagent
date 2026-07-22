/**
 * Cross-agent authentication — Ed25519 message signing, verification,
 * and replay prevention for secure inter-agent communication.
 *
 * Uses `node:crypto` exclusively (same pattern as core key-manager).
 *
 * This module is the composition root for the AgentAuth class. Its cohesive
 * concerns are decomposed into leaf modules under `agent-auth/`:
 * - `types.ts` — public type contracts and store interfaces
 * - `crypto.ts` — canonical serialization, Base64URL codec, raw-key DER wrapping
 * - `stores.ts` — default in-memory replay/public-key stores
 * - `capability-claims.ts` — capability-claim parsing and validation
 *
 * @module security/agent-auth
 */
import { generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";

import { extractCapabilityClaims } from "./agent-auth/capability-claims.js";
import {
  canonicalize,
  fromBase64Url,
  privateKeyFromRaw,
  publicKeyFromRaw,
  toBase64Url,
} from "./agent-auth/crypto.js";
import {
  InMemoryAgentPublicKeyStore,
  InMemoryAgentReplayStore,
} from "./agent-auth/stores.js";
import type {
  AgentAuthConfig,
  AgentAuthFailure,
  AgentAuthFailureCode,
  AgentAuthResult,
  AgentAuthVerificationStage,
  AgentCredential,
  AgentPublicKeyStore,
  AgentReplayResult,
  AgentReplayStore,
  SignedAgentMessage,
} from "./agent-auth/types.js";

export {
  InMemoryAgentPublicKeyStore,
  InMemoryAgentReplayStore,
} from "./agent-auth/stores.js";
export type {
  AgentAuthConfig,
  AgentAuthFailure,
  AgentAuthFailureCode,
  AgentAuthResult,
  AgentAuthVerificationStage,
  AgentCapabilityClaims,
  AgentCredential,
  AgentPublicKeyStore,
  AgentReplayResult,
  AgentReplayStore,
  SignedAgentMessage,
} from "./agent-auth/types.js";

/**
 * Cross-agent authentication using Ed25519 signatures.
 *
 * Provides key generation, message signing/verification, and replay prevention.
 */
export class AgentAuth {
  private readonly maxMessageAgeMs: number;
  private readonly allowedClockSkewMs: number;
  private readonly requiredCapabilities?: readonly string[];
  private readonly replayStore: AgentReplayStore;
  private readonly publicKeyStore: AgentPublicKeyStore;
  private lastEviction = Date.now();

  constructor(config?: AgentAuthConfig) {
    this.maxMessageAgeMs = config?.maxMessageAgeMs ?? 60_000;
    this.allowedClockSkewMs = config?.allowedClockSkewMs ?? 5_000;
    if (config?.requiredCapabilities !== undefined) {
      this.requiredCapabilities = config.requiredCapabilities.slice();
    }
    this.replayStore = config?.replayStore ?? new InMemoryAgentReplayStore();
    this.publicKeyStore =
      config?.publicKeyStore ?? new InMemoryAgentPublicKeyStore();
  }

  // -------------------------------------------------------------------------
  // Key generation
  // -------------------------------------------------------------------------

  /** Generate a new Ed25519 key pair for an agent. */
  generateCredential(agentId: string): AgentCredential {
    const { publicKey: pubKeyObj, privateKey: privKeyObj } =
      generateKeyPairSync("ed25519");

    const publicKeyDer = pubKeyObj.export({ type: "spki", format: "der" });
    const privateKeyDer = privKeyObj.export({ type: "pkcs8", format: "der" });

    // Ed25519 raw public key = last 32 bytes of SPKI DER
    const publicKey = new Uint8Array(
      publicKeyDer.subarray(publicKeyDer.length - 32)
    );
    // Ed25519 PKCS8 DER contains the 32-byte seed starting at byte 16
    const privateKey = new Uint8Array(privateKeyDer.subarray(16, 48));

    return { agentId, publicKey, privateKey, createdAt: new Date() };
  }

  // -------------------------------------------------------------------------
  // Signing
  // -------------------------------------------------------------------------

  /** Sign a message payload, producing a SignedAgentMessage envelope. */
  signMessage(
    payload: unknown,
    credential: AgentCredential
  ): SignedAgentMessage {
    const payloadStr = JSON.stringify(payload);
    const nonce = randomBytes(16).toString("hex");
    const timestamp = Date.now();

    // Build canonical signable content
    const signable = {
      nonce,
      payload: payloadStr,
      senderId: credential.agentId,
      timestamp,
    };
    const canonical = canonicalize(signable);

    const privKey = privateKeyFromRaw(credential.privateKey);
    const sig = sign(null, canonical, privKey);

    return {
      payload: payloadStr,
      signature: toBase64Url(sig),
      senderId: credential.agentId,
      nonce,
      timestamp,
    };
  }

  // -------------------------------------------------------------------------
  // Verification
  // -------------------------------------------------------------------------

  /** Verify a signed message against a provided public key. */
  verifyMessage(
    message: SignedAgentMessage,
    publicKey: Uint8Array
  ): AgentAuthResult {
    try {
      const freshness = this.verifyMessageFreshness(message);
      if (!freshness.valid) {
        return freshness;
      }

      // Rebuild canonical signable
      const signable = {
        nonce: message.nonce,
        payload: message.payload,
        senderId: message.senderId,
        timestamp: message.timestamp,
      };
      const canonical = canonicalize(signable);
      const sigBuf = fromBase64Url(message.signature);
      const pubKey = publicKeyFromRaw(publicKey);

      const isValid = verify(null, canonical, pubKey, sigBuf);
      if (!isValid) {
        return this.failureResult(
          "signature",
          "invalid_signature",
          "Invalid signature"
        );
      }

      return this.verifyCapabilityClaims(message);
    } catch {
      return this.failureResult(
        "signature",
        "verification_error",
        "Verification error"
      );
    }
  }

  // -------------------------------------------------------------------------
  // Replay prevention
  // -------------------------------------------------------------------------

  /** Check whether a message should be rejected for replay or staleness. */
  checkReplay(message: SignedAgentMessage): AgentReplayResult {
    // Evict expired nonces periodically
    this.evictExpiredNonces();

    // Timestamp check
    const age = Date.now() - message.timestamp;
    if (age < -this.allowedClockSkewMs) {
      return {
        allowed: false,
        reason: "Message timestamp is too far in the future",
        failure: {
          code: "replay_message_timestamp_future",
          stage: "replay",
          reason: "Message timestamp is too far in the future",
        },
      };
    }
    if (age > this.maxMessageAgeMs) {
      return {
        allowed: false,
        reason: "Message too old",
        failure: {
          code: "replay_message_too_old",
          stage: "replay",
          reason: "Message too old",
        },
      };
    }

    // Nonce uniqueness
    if (this.replayStore.hasNonce(message.nonce)) {
      return {
        allowed: false,
        reason: "Duplicate nonce (replay detected)",
        failure: {
          code: "replay_duplicate_nonce",
          stage: "replay",
          reason: "Duplicate nonce (replay detected)",
        },
      };
    }

    // Record nonce with expiry
    this.replayStore.setNonce(message.nonce, Date.now() + this.maxMessageAgeMs);
    return { allowed: true };
  }

  // -------------------------------------------------------------------------
  // Public key registry
  // -------------------------------------------------------------------------

  /** Register a public key for an agent (for later verification). */
  registerPublicKey(agentId: string, publicKey: Uint8Array): void {
    this.publicKeyStore.setPublicKey(agentId, publicKey);
  }

  /** Verify a message using the registered public key for its sender. */
  verifyWithRegisteredKey(message: SignedAgentMessage): AgentAuthResult {
    const publicKey = this.publicKeyStore.getPublicKey(message.senderId);
    if (!publicKey) {
      const reason = `No registered key for agent: ${message.senderId}`;
      return this.failureResult(
        "signature",
        "missing_registered_public_key",
        reason
      );
    }
    return this.verifyMessage(message, publicKey);
  }

  /**
   * Deterministic combined verification helper:
   * signature -> replay -> capability (capability is checked inside signature verification).
   */
  verifyAndAuthorizeMessage(
    message: SignedAgentMessage,
    publicKey: Uint8Array
  ): AgentAuthResult {
    const signatureResult = this.verifyMessage(message, publicKey);
    if (!signatureResult.valid) {
      return signatureResult;
    }

    const replayResult = this.checkReplay(message);
    if (!replayResult.allowed) {
      return this.failureResult(
        "replay",
        replayResult.failure?.code ?? "replay_duplicate_nonce",
        replayResult.reason ?? "Replay check failed"
      );
    }

    return {
      valid: true,
      stage: "success",
      ...(signatureResult.capabilities !== undefined
        ? { capabilities: signatureResult.capabilities }
        : {}),
    };
  }

  /**
   * Combined verification helper using the registered sender key:
   * signature -> replay -> capability.
   */
  verifyAndAuthorizeWithRegisteredKey(
    message: SignedAgentMessage
  ): AgentAuthResult {
    const publicKey = this.publicKeyStore.getPublicKey(message.senderId);
    if (!publicKey) {
      const reason = `No registered key for agent: ${message.senderId}`;
      return this.failureResult(
        "signature",
        "missing_registered_public_key",
        reason
      );
    }
    return this.verifyAndAuthorizeMessage(message, publicKey);
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /** Evict expired nonces to prevent unbounded growth. */
  private evictExpiredNonces(): void {
    const now = Date.now();
    // Only evict every maxMessageAgeMs to avoid overhead
    if (now - this.lastEviction < this.maxMessageAgeMs) {
      return;
    }
    this.lastEviction = now;
    this.replayStore.evictExpired(now);
  }

  private verifyMessageFreshness(message: SignedAgentMessage): AgentAuthResult {
    const age = Date.now() - message.timestamp;
    if (age < -this.allowedClockSkewMs) {
      return this.failureResult(
        "signature",
        "message_timestamp_future",
        "Message timestamp is too far in the future"
      );
    }
    if (age > this.maxMessageAgeMs) {
      return this.failureResult(
        "signature",
        "message_expired",
        "Message expired"
      );
    }
    return { valid: true, stage: "signature" };
  }

  private verifyCapabilityClaims(message: SignedAgentMessage): AgentAuthResult {
    if (!this.requiredCapabilities || this.requiredCapabilities.length === 0) {
      return { valid: true, stage: "success" };
    }

    const capabilityClaims = extractCapabilityClaims(message.payload);
    if (capabilityClaims.kind === "failure") {
      return this.failureResult(
        "capability",
        capabilityClaims.failure.code,
        capabilityClaims.failure.reason
      );
    }

    const claimedCapabilities = capabilityClaims.capabilities;
    const missingCapabilities = this.requiredCapabilities.filter(
      (capability) => !claimedCapabilities.includes(capability)
    );
    if (missingCapabilities.length > 0) {
      return this.failureResult(
        "capability",
        "insufficient_capabilities",
        `Missing required capabilities: ${missingCapabilities.join(", ")}`,
        missingCapabilities
      );
    }

    return {
      valid: true,
      stage: "success",
      capabilities: claimedCapabilities,
    };
  }

  private failureResult(
    stage: Exclude<AgentAuthVerificationStage, "success">,
    code: AgentAuthFailureCode,
    reason: string,
    missingCapabilities?: string[]
  ): AgentAuthResult {
    const failure: AgentAuthFailure = {
      code,
      stage,
      reason,
      ...(missingCapabilities !== undefined ? { missingCapabilities } : {}),
    };
    return {
      valid: false,
      reason,
      stage,
      failure,
    };
  }
}
