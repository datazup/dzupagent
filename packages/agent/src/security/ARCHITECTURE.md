# Security Module Architecture (`packages/agent/src/security`)

## Scope

This folder implements message-level authentication primitives for inter-agent communication.

Files:

- `agent-auth.ts`: core implementation (`AgentAuth`) with Ed25519 key generation, signing, verification, replay checks, and key registry.
- `index.ts`: local barrel exports.

This module is intentionally small and self-contained. It does not depend on the event bus, orchestration runtime, or persistence layers.

## Public API

### Types

- `AgentCredential`
  - `agentId: string`
  - `publicKey: Uint8Array` (32-byte Ed25519 public key)
  - `privateKey: Uint8Array` (32-byte Ed25519 seed)
  - `createdAt: Date`

- `SignedAgentMessage`
  - `payload: string` (JSON string)
  - `signature: string` (Base64URL Ed25519 signature)
  - `senderId: string`
  - `nonce: string` (16 random bytes encoded as 32-char hex)
  - `timestamp: number` (Unix ms)

- `AgentAuthConfig`
  - `maxMessageAgeMs?` (default `60_000`)
  - `allowedClockSkewMs?` (default `5_000`)
  - `requiredCapabilities?` (declared but currently not enforced by implementation)

### Class

- `new AgentAuth(config?)`
- `generateCredential(agentId)`
- `signMessage(payload, credential)`
- `verifyMessage(message, publicKey)`
- `checkReplay(message)`
- `registerPublicKey(agentId, publicKey)`
- `verifyWithRegisteredKey(message)`

## Features and Behavior

### 1) Ed25519 credential generation

`generateCredential(agentId)` creates a fresh Ed25519 keypair using `node:crypto.generateKeyPairSync('ed25519')`.

Implementation detail:

- Public key is extracted from exported SPKI DER (last 32 bytes).
- Private key seed is extracted from exported PKCS8 DER (bytes 16..48).

Result: compact raw keys (32 bytes each) suitable for serialization/storage.

### 2) Deterministic signing envelope

`signMessage(payload, credential)` creates a signed envelope with anti-replay metadata:

1. JSON-serializes payload to `payload: string`.
2. Generates `nonce` (`randomBytes(16).toString('hex')`).
3. Captures `timestamp`.
4. Canonicalizes `{ nonce, payload, senderId, timestamp }` with sorted object keys.
5. Signs canonical bytes using Ed25519 private key.
6. Returns `SignedAgentMessage` with signature encoded in Base64URL.

Why this matters:

- Signature binds sender ID, payload string, nonce, and timestamp together.
- Any tampering of these fields breaks verification.

### 3) Signature verification with freshness checks

`verifyMessage(message, publicKey)` performs:

1. Freshness checks using local clock.
- Rejects if timestamp is too far in future: `age < -allowedClockSkewMs`.
- Rejects if message is too old: `age > maxMessageAgeMs`.
2. Reconstructs canonical signable object.
3. Decodes Base64URL signature.
4. Verifies Ed25519 signature with provided public key.

Return shape:

- `{ valid: true }`
- `{ valid: false, reason: '...' }` for invalid signature, expiry, future timestamp, or parsing/key errors.

### 4) Replay prevention (nonce cache)

`checkReplay(message)` protects against duplicate processing:

1. Evicts expired nonce entries periodically.
2. Applies same timestamp window checks as verification.
3. Rejects if `nonce` already seen.
4. Stores nonce with expiry (`now + maxMessageAgeMs`) and allows first-seen message.

Behavioral note:

- Nonce cache is process-local in-memory state.
- Replay protection is effective only within one runtime instance.

### 5) Built-in sender-key registry

Two helper APIs support sender lookup by agent ID:

- `registerPublicKey(agentId, publicKey)`
- `verifyWithRegisteredKey(message)`

`verifyWithRegisteredKey` resolves key by `message.senderId` and delegates to `verifyMessage`.

## End-to-End Flow

### Flow A: Sign and verify with explicit key

```text
Sender
  -> generateCredential(senderId)
  -> signMessage(payload, credential)
  -> transmit SignedAgentMessage

Receiver
  -> verifyMessage(message, senderPublicKey)
  -> checkReplay(message)
  -> parse JSON payload if both checks pass
```

### Flow B: Verify with registered key lookup

```text
Bootstrap
  -> registerPublicKey('agent-a', keyA)
  -> registerPublicKey('agent-b', keyB)

At runtime
  -> verifyWithRegisteredKey(message)
  -> checkReplay(message)
  -> process payload
```

Recommended order on receiver side:

1. Verify signature/freshness (`verifyMessage` or `verifyWithRegisteredKey`).
2. Check replay (`checkReplay`).
3. Only then parse and execute payload.

## Usage Examples

### Example 1: Basic round-trip

```ts
import { AgentAuth } from '@dzupagent/agent'

const auth = new AgentAuth({ maxMessageAgeMs: 60_000 })
const cred = auth.generateCredential('agent-alpha')

const msg = auth.signMessage({ action: 'deploy', env: 'staging' }, cred)

const verify = auth.verifyMessage(msg, cred.publicKey)
if (!verify.valid) throw new Error(verify.reason)

const replay = auth.checkReplay(msg)
if (!replay.allowed) throw new Error(replay.reason)

const payload = JSON.parse(msg.payload) as { action: string; env: string }
```

### Example 2: Receiver with key registry

```ts
import { AgentAuth, type SignedAgentMessage } from '@dzupagent/agent'

const receiverAuth = new AgentAuth({ maxMessageAgeMs: 30_000, allowedClockSkewMs: 2_000 })

receiverAuth.registerPublicKey('agent-alpha', alphaPublicKey)
receiverAuth.registerPublicKey('agent-beta', betaPublicKey)

export function acceptSignedMessage(msg: SignedAgentMessage): unknown {
  const verified = receiverAuth.verifyWithRegisteredKey(msg)
  if (!verified.valid) throw new Error(`auth failed: ${verified.reason}`)

  const replay = receiverAuth.checkReplay(msg)
  if (!replay.allowed) throw new Error(`replay blocked: ${replay.reason}`)

  return JSON.parse(msg.payload)
}
```

### Example 3: Cross-process consideration

If receivers are horizontally scaled, each process has a separate nonce cache.
Use one of these patterns when strict replay guarantees are required:

- route each sender to a sticky receiver instance,
- or add a shared nonce store (Redis/DB) in front of `checkReplay`,
- or include short-lived request IDs validated by a central coordinator.

## Use Cases

- Inter-agent RPC where sender identity must be cryptographically bound to payload.
- Delegation graphs where child agents must prove origin of result messages.
- Approval/audit pipelines where signed envelopes are retained as tamper-evident records.
- Multi-tenant routing where receiver validates known sender public keys before processing actions.

## References in Other Packages

## Direct runtime imports

No other package currently imports `packages/agent/src/security/agent-auth.ts` directly.
Within this monorepo, usage is concentrated in `@dzupagent/agent` exports and tests.

## Public export surface

- `packages/agent/src/index.ts`
  - re-exports `AgentAuth`, `AgentCredential`, `SignedAgentMessage`, `AgentAuthConfig`.

## Documentation references

- `packages/agent/README.md` lists `AgentAuth` under Security.
- `packages/agent/ARCHITECTURE.md` references `src/security` as the security primitive module.
- `packages/agent/docs/ARCHITECTURE.md` lists `security/` as signed-message support.

Practical implication: other packages consume this functionality indirectly via `@dzupagent/agent` public API rather than direct source-level coupling.

## Test Coverage

## Existing tests

`packages/agent/src/__tests__/agent-auth.test.ts` currently covers:

- credential generation shape and uniqueness,
- sign/verify happy path,
- wrong-key and tampered-payload failure paths,
- expiry and future-skew checks,
- nonce uniqueness,
- replay duplicate detection,
- registered-key success and failure paths.

Executed locally:

- `yarn workspace @dzupagent/agent test src/__tests__/agent-auth.test.ts`
- result: `14/14` tests passed.

## Measured module-local coverage

Executed:

- `yarn workspace @dzupagent/agent test:coverage -- src/__tests__/agent-auth.test.ts`

Observed for this module:

- `packages/agent/src/security/agent-auth.ts`
  - statements: `97.28%`
  - branches: `91.89%`
  - functions: `100%`
  - lines: `97.28%`
  - uncovered lines: `225-226`, `288-293`

Notes:

- The coverage command exited non-zero because package-wide global thresholds apply, while only one test file was run.
- Uncovered paths are:
  - catch-all verification error return path,
  - nonce-eviction loop branch where expired entries are deleted.

## Quality and Security Observations

### Strengths

- Uses modern Ed25519 signatures via Node crypto primitives.
- Canonicalized signable content reduces accidental serialization mismatch.
- Timestamp + nonce model addresses both stale and duplicate message classes.
- API returns structured reasons for reject outcomes, helping observability/debugging.

### Current limitations

- `requiredCapabilities` exists in config type but is not enforced in runtime logic.
- Replay cache is in-memory only (not shared across processes/nodes).
- Verification and replay checks are separate calls, so integration correctness depends on caller discipline.
- No built-in key rotation lifecycle (versioning, expiry, revocation metadata).

## Recommended Enhancements

1. Add a `verifyAndCheckReplay(...)` convenience API to reduce incorrect integration ordering.
2. Implement optional pluggable nonce store for distributed replay defense.
3. Either remove `requiredCapabilities` from config or implement capability policy hook enforcement.
4. Add targeted tests for:
- malformed signature/base64 decode error path,
- nonce eviction branch with controlled clock advancement,
- optional capability enforcement (if implemented).
