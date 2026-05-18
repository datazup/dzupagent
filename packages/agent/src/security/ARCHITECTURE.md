# Security Module Architecture (`packages/agent/src/security`)

## Scope
This document describes the current implementation under `packages/agent/src/security`:
- `agent-auth.ts`
- `index.ts`

It is limited to this folder and its package-level exports through `@dzupagent/agent`. It does not describe other security controls implemented in `packages/agent/src/agent/**`, `guardrails/**`, or external packages.

## Responsibilities
The module provides a focused, in-process authentication utility for cross-agent messages:
- Generate Ed25519 credentials (`generateCredential`).
- Sign message envelopes (`signMessage`) with nonce and timestamp.
- Verify signed envelopes (`verifyMessage`) with freshness checks.
- Detect replay attempts (`checkReplay`) using a nonce cache.
- Support sender-based key lookup (`registerPublicKey`, `verifyWithRegisteredKey`).

## Structure
- `agent-auth.ts`: exports `AgentCredential`, `SignedAgentMessage`, `AgentAuthConfig`, internal serialization/key helpers, and the `AgentAuth` class.
- `index.ts`: barrel re-export for `AgentAuth` and the three exported interfaces.
- Package integration: `src/index.ts` re-exports `AgentAuth`, `AgentCredential`, `SignedAgentMessage`, and `AgentAuthConfig`.
- Export boundary: `package.json` does not expose a dedicated `./security` subpath; this module is consumed via the root export (`@dzupagent/agent`).

## Runtime and Control Flow
1. Sender calls `generateCredential(agentId)` to produce an Ed25519 keypair representation (`Uint8Array` public/private keys plus `createdAt`).
2. Sender calls `signMessage(payload, credential)`.
3. `signMessage` serializes payload with `JSON.stringify`, creates `{ nonce, payload, senderId, timestamp }`, canonicalizes object keys, signs with Ed25519, and returns a `SignedAgentMessage`.
4. Receiver verifies signature and timestamp via `verifyMessage(message, publicKey)` or `verifyWithRegisteredKey(message)`.
5. Receiver separately calls `checkReplay(message)` to enforce nonce uniqueness and message-age constraints.

Current implementation details:
- Cryptography uses Node `node:crypto` only.
- Nonces are 16 random bytes rendered as 32-char hex strings.
- Replay state is process-local (`Map<string, number>`) with periodic eviction in `evictExpiredNonces()`.
- Freshness is enforced in both verification and replay paths using `maxMessageAgeMs` and `allowedClockSkewMs`.

## Key APIs and Types
- `interface AgentCredential`: `agentId`, `publicKey`, `privateKey`, `createdAt`.
- `interface SignedAgentMessage`: `payload`, `signature`, `senderId`, `nonce`, `timestamp`.
- `interface AgentAuthConfig`: `maxMessageAgeMs?: number` (default `60_000`), `allowedClockSkewMs?: number` (default `5_000`), `requiredCapabilities?: string[]` (currently declared but not enforced).
- `class AgentAuth`:
- `generateCredential(agentId: string): AgentCredential`
- `signMessage(payload: unknown, credential: AgentCredential): SignedAgentMessage`
- `verifyMessage(message: SignedAgentMessage, publicKey: Uint8Array): { valid: boolean; reason?: string }`
- `checkReplay(message: SignedAgentMessage): { allowed: boolean; reason?: string }`
- `registerPublicKey(agentId: string, publicKey: Uint8Array): void`
- `verifyWithRegisteredKey(message: SignedAgentMessage): { valid: boolean; reason?: string }`

Return reasons implemented in code:
- Verification: `Message timestamp is too far in the future`, `Message expired`, `Invalid signature`, `Verification error`.
- Replay: `Message timestamp is too far in the future`, `Message too old`, `Duplicate nonce (replay detected)`.

## Dependencies
- Direct module dependency: Node built-in `node:crypto` (`generateKeyPairSync`, `sign`, `verify`, `createPrivateKey`, `createPublicKey`, `randomBytes`).
- No direct dependency from this folder on `@dzupagent/core`, `@dzupagent/security`, event bus APIs, pipeline runtime, persistence, or approval abstractions.
- Package context (`packages/agent/package.json`): `@dzupagent/agent` depends on `@dzupagent/security` and other internal packages, but `src/security/agent-auth.ts` itself is self-contained on Node crypto.

## Integration Points
- Public API exposure:
- Re-exported from `packages/agent/src/index.ts`.
- Listed in package docs (`packages/agent/README.md`, `packages/agent/docs/api-tiers.md`).
- Internal module barrel: `packages/agent/src/security/index.ts`.
- Current in-package usage:
- Direct runtime references outside `src/security/**` are not present in `src/**`.
- Active usage is currently test coverage in `src/__tests__/agent-auth.test.ts`.

## Testing and Observability
- Tests: `src/__tests__/agent-auth.test.ts` covers key generation shape and uniqueness, sign/verify success, wrong-key and tampered-payload failures, expired/future timestamp rejection, nonce uniqueness, replay rejection, and registered-key verification behavior.
- Local verification (current checkout):
- Command: `yarn test src/__tests__/agent-auth.test.ts`
- Result: `1` file passed, `14` tests passed.
- Observability:
- `AgentAuth` has no event-bus emission or internal logging.
- Diagnostics are return-value based as `{ valid|allowed, reason }`.

## Risks and TODOs
- `requiredCapabilities` in `AgentAuthConfig` is not used by `AgentAuth`; capability-based authorization is not implemented in this module.
- Replay detection is process-local and non-distributed.
- Registered public keys are in-memory only and are lost on process restart.
- Callers must enforce both signature verification and replay checks; there is no single combined `verifyAndCheckReplay` API.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

