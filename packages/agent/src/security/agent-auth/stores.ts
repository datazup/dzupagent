/**
 * Default in-memory store implementations for cross-agent authentication —
 * replay-nonce tracking and sender public-key registry.
 *
 * @module security/agent-auth/stores
 */
import type { AgentPublicKeyStore, AgentReplayStore } from "./types.js";

/** In-memory replay store used by default in local/test runtime. */
export class InMemoryAgentReplayStore implements AgentReplayStore {
  private readonly seenNonces = new Map<string, number>();

  hasNonce(nonce: string): boolean {
    return this.seenNonces.has(nonce);
  }

  setNonce(nonce: string, expiresAtMs: number): void {
    this.seenNonces.set(nonce, expiresAtMs);
  }

  evictExpired(nowMs: number): void {
    for (const [nonce, expiresAt] of this.seenNonces) {
      if (expiresAt <= nowMs) {
        this.seenNonces.delete(nonce);
      }
    }
  }
}

/** In-memory public-key registry used by default in local/test runtime. */
export class InMemoryAgentPublicKeyStore implements AgentPublicKeyStore {
  private readonly keys = new Map<string, Uint8Array>();

  getPublicKey(agentId: string): Uint8Array | undefined {
    const key = this.keys.get(agentId);
    if (!key) {
      return undefined;
    }
    return new Uint8Array(key);
  }

  setPublicKey(agentId: string, publicKey: Uint8Array): void {
    this.keys.set(agentId, new Uint8Array(publicKey));
  }
}
