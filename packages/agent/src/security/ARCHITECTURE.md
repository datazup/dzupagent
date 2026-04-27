# Security Module Architecture (`packages/agent/src/security`)

## Scope
This document covers the code in `packages/agent/src/security`:
- `agent-auth.ts`
- `index.ts`

It describes only what is implemented in this folder and how it is exported through `@dzupagent/agent`. It does not describe broader package security controls outside this module.

## Responsibilities
The security module provides a small, self-contained message-authentication primitive for agent-to-agent traffic:
- Generate Ed25519 credentials for an agent identity.
- Sign a message envelope (`payload`, `senderId`, `nonce`, `timestamp`).
- Verify signatures and enforce message freshness windows.
- Detect replay attempts using an in-memory nonce cache.
- Optionally verify by sender ID through a local registered public-key map.

## Structure
- `agent-auth.ts`: declares `AgentCredential`, `SignedAgentMessage`, `AgentAuthConfig`, helper functions, and the `AgentAuth` class.
- `index.ts`: re-exports `AgentAuth` and the three security types from `agent-auth.ts`.

Package root integration:
- `src/index.ts` re-exports `AgentAuth`, `AgentCredential`, `SignedAgentMessage`, and `AgentAuthConfig` from `./security/agent-auth.js`.

## Runtime and Control Flow
1. A sender creates credentials with `generateCredential(agentId)`.
2. The sender signs payload data with `signMessage(payload, credential)`.
3. The receiver verifies authenticity and freshness via `verifyMessage(message, publicKey)` or `verifyWithRegisteredKey(message)` after key registration.
4. The receiver runs `checkReplay(message)` to reject duplicate nonces.
5. If both verification and replay checks pass, the receiver can parse and process `message.payload`.

Implementation details reflected in code:
- Signing uses Ed25519 from `node:crypto`.
- Signable content is canonicalized JSON over `{ nonce, payload, senderId, timestamp }`.
- `payload` is always the JSON string produced by `JSON.stringify(payload)` in `signMessage`.
- Nonces are 16 random bytes encoded as 32-char hex strings.
- Replay state uses `Map<string, number>` and periodic eviction (`evictExpiredNonces`).

## Key APIs and Types
- `interface AgentCredential`: `agentId`, `publicKey`, `privateKey`, `createdAt`.
- `interface SignedAgentMessage`: `payload`, `signature`, `senderId`, `nonce`, `timestamp`.
- `interface AgentAuthConfig`: `maxMessageAgeMs?` (default `60_000`), `allowedClockSkewMs?` (default `5_000`), `requiredCapabilities?` (declared but not enforced in current implementation).
- `class AgentAuth`: runtime class implementing signing, verification, replay checks, and key registration.
- `AgentAuth.generateCredential(agentId: string): AgentCredential`
- `AgentAuth.signMessage(payload: unknown, credential: AgentCredential): SignedAgentMessage`
- `AgentAuth.verifyMessage(message: SignedAgentMessage, publicKey: Uint8Array): { valid: boolean; reason?: string }`
- `AgentAuth.checkReplay(message: SignedAgentMessage): { allowed: boolean; reason?: string }`
- `AgentAuth.registerPublicKey(agentId: string, publicKey: Uint8Array): void`
- `AgentAuth.verifyWithRegisteredKey(message: SignedAgentMessage): { valid: boolean; reason?: string }`

Behavioral return reasons present in code/tests:
- Verification failure reasons include `Message timestamp is too far in the future`, `Message expired`, `Invalid signature`, and `Verification error`.
- Replay failure reasons include `Message timestamp is too far in the future`, `Message too old`, and `Duplicate nonce (replay detected)`.

## Dependencies
Direct code dependency inside this module:
- Node built-in `node:crypto` APIs: `generateKeyPairSync`, `sign`, `verify`, `createPrivateKey`, `createPublicKey`, `randomBytes`.

No direct dependency on event bus, pipeline runtime, approval gate, or persistence layers.

Package-level context (`packages/agent/package.json`):
- Runtime deps include `@dzupagent/adapter-types`, `@dzupagent/agent-types`, `@dzupagent/context`, `@dzupagent/core`, `@dzupagent/memory`, `@dzupagent/memory-ipc`.
- Security module logic itself uses only Node crypto primitives.

## Integration Points
- Public package API: exported from `@dzupagent/agent` root via `src/index.ts`.
- Module-local barrel: `src/security/index.ts` re-exports the same security surface.
- Package docs: `packages/agent/README.md` lists `AgentAuth` and related types; `packages/agent/docs/ARCHITECTURE.md` references `security/` for auth/signing.

Current in-package runtime usage:
- Search across `src/` (excluding `src/security/**` and `src/index.ts`) shows no additional production call sites.
- Active direct usage in this package is the dedicated test file `src/__tests__/agent-auth.test.ts`.

## Testing and Observability
Automated tests:
- `src/__tests__/agent-auth.test.ts` covers credential generation, sign/verify success, wrong-key and tampered payload failures, timestamp bounds, nonce uniqueness, replay rejection, and registered-key verification behavior.

Local verification run:
- Command: `yarn test src/__tests__/agent-auth.test.ts`
- Result: 1 file passed, 14 tests passed.

Observability:
- `AgentAuth` has no internal telemetry/event-bus emission.
- Diagnostics are return-value based (`valid/allowed` plus `reason`).

## Risks and TODOs
- `AgentAuthConfig.requiredCapabilities` is declared but unused by `AgentAuth`.
- Replay protection is process-local (`seenNonces` in memory), so duplicate detection does not synchronize across multiple instances.
- Public key registration is in-memory only; restarts clear registered keys unless callers rehydrate them.
- Verification and replay checks are separate calls; callers must enforce both in receive pipelines.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

