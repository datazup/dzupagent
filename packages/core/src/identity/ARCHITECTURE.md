# Identity Architecture (`@dzupagent/core`)

## Scope
This document covers the identity subsystem implemented in `packages/core/src/identity` and the package entry points that publish it.

Included source files:
- `identity-types.ts`
- `identity-schemas.ts`
- `forge-uri.ts`
- `identity-resolver.ts`
- `api-key-resolver.ts`
- `signing-types.ts`
- `key-manager.ts`
- `delegation-types.ts`
- `delegation-store.ts`
- `delegation-manager.ts`
- `capability-checker.ts`
- `trust-scorer.ts`
- `index.ts` (identity barrel)

Related package surfaces in scope:
- `src/identity.ts` (`@dzupagent/core/identity` subpath entry)
- `src/index.ts` (root `@dzupagent/core` entry also re-exporting identity)
- `packages/core/package.json` `exports["./identity"]` and `typesVersions.identity`
- `packages/core/README.md` high-level package usage notes (not identity implementation authority)

Validation scope:
- `src/identity/__tests__/*.test.ts`
- identity branch-coverage checks in `src/__tests__/w15-h2-branch-coverage.test.ts`

## Responsibilities
The identity subsystem is responsible for:
- Defining identity domain types: credentials, capabilities, full identities, and lightweight identity refs.
- Enforcing runtime shape validation with Zod schemas for identity and URI values.
- Parsing and building `forge://` identity URIs, plus conversion to/from `agent://`.
- Resolving identity from auth context through resolver interfaces and a composite chain.
- Resolving API keys via SHA-256 hashes with in-memory TTL/LRU caching.
- Managing Ed25519 key generation, signing, verification, and key rotation.
- Issuing and validating signed delegation tokens and delegation chains.
- Performing capability authorization across delegation scope, direct capabilities, and role mappings.
- Computing trust scores from outcome signals and persisting them via a pluggable store.

## Structure
- `identity-types.ts`
  - Core identity contracts: `CredentialType`, `ForgeCredential`, `ForgeCapability`, `ForgeIdentity`, `ForgeIdentityRef`.
  - Helper: `toIdentityRef(identity)`.
- `identity-schemas.ts`
  - Zod schemas for identity contracts.
  - Capability name regex allows lowercase dot-separated segments with optional hyphens.
- `forge-uri.ts`
  - `ForgeUriSchema` for `forge://<org>/<name>(@<semver>)?`.
  - URI helpers: `parseForgeUri`, `buildForgeUri`, `isForgeUri`, `toAgentUri`, `fromAgentUri`.
  - Resolver factory: `createUriResolver('static' | 'convention' | 'registry')`.
- `identity-resolver.ts`
  - `IdentityResolutionContext` and `IdentityResolver`.
  - `CompositeIdentityResolver` with ordered `resolve`, `verify`, and `addResolver`.
- `api-key-resolver.ts`
  - `APIKeyRecord`, `APIKeyResolverConfig`, `APIKeyIdentityResolver`.
  - `hashAPIKey` and `createAPIKeyResolver`.
  - Private `LRUCache` supporting TTL and max-size eviction.
- `signing-types.ts`
  - Signing/key contracts: `SigningKeyPair`, `SigningKeyStatus`, `SignedDocument<T>`, `SignedAgentCard`, `KeyStore`.
- `key-manager.ts`
  - `KeyManagerConfig` + `KeyManager` interface.
  - `createKeyManager` (Ed25519 sign/verify flow) and `InMemoryKeyStore`.
  - Canonical JSON serialization for deterministic signatures.
- `delegation-types.ts`
  - `DelegationConstraint`, `DelegationToken`, `DelegationChain`, `DelegationTokenStore`.
- `delegation-store.ts`
  - `InMemoryDelegationTokenStore` implementation with token map, revoked set, and delegatee index.
- `delegation-manager.ts`
  - `DelegationManagerConfig`, `IssueDelegationParams`.
  - `DelegationManager` with `issue`, `verify`, `validateChain`, `revoke`, `hasCapabilityInChain`.
  - Internal `childrenMap` for cascade revocation.
- `capability-checker.ts`
  - `CapabilityChecker` interfaces and default role map.
  - `createCapabilityChecker` with delegation-first authorization semantics.
- `trust-scorer.ts`
  - `TrustSignals`, `TrustScoreBreakdown`, `TrustScoreStore`, `TrustScorerConfig`, `TrustScorer`.
  - `createTrustScorer` and `InMemoryTrustScoreStore`.
- `index.ts`
  - Identity barrel exported by `src/identity.ts` and `src/index.ts`.

## Runtime and Control Flow
1. Type and schema gate
- Callers construct identity objects using interfaces from `identity-types.ts`.
- Runtime validation is done through Zod schemas in `identity-schemas.ts`.
- `toIdentityRef` reduces full identities to stable lightweight refs.

2. URI handling and resolution
- `ForgeUriSchema` validates identity URI format.
- `parseForgeUri` and `buildForgeUri` perform round-trip parsing/building.
- `toAgentUri` and `fromAgentUri` switch schemes with validation.
- `createUriResolver` strategies:
  - `static`: direct map lookup.
  - `convention`: template interpolation with `{org}` and `{name}`.
  - `registry`: lookup against registry endpoint with timeout/retry and optional template fallback.
- Registry lookup behavior:
  - Defaults: `registryUrl = https://registry.forge.dev`, `timeoutMs = 5000`, `maxRetries = 1`.
  - Retryable statuses: `408`, `425`, `429`, `>=500`, timeout, and network errors.
  - Non-retry terminal statuses: other `4xx` (for example `401`).
  - Endpoint extraction accepts raw string body or nested JSON fields (`endpoint`, `url`, `uri`, `agentUrl`, `location`, `href`, and nested `data`/`result`/`value`), with `http/https` protocol enforcement.

3. Identity resolution
- `CompositeIdentityResolver.resolve` runs resolver chain in order; first non-null identity wins.
- `CompositeIdentityResolver.verify` returns true if any resolver verifies.
- `createAPIKeyResolver` flow:
  - Reads `context.token`.
  - Hashes token using SHA-256 (`hashAPIKey`).
  - Checks cache first.
  - On cache miss, loads records (static list or async loader), filters expiration, and caches hit/miss.
  - `invalidate(keyHash)` evicts a cached key hash.

4. Signing and key lifecycle
- `createKeyManager.generate` creates Ed25519 keypair and stores extracted raw 32-byte public/private key material.
- `sign` canonicalizes data (sorted object keys), signs with active or explicit key, and returns base64url signature.
- `verify` rebuilds public key object and returns signature validity (`false` on decode/parse errors).
- `signDocument` wraps `document`, `signedAt`, `keyId`, `algorithm`, then signs wrapper content.
- `verifyDocument` recomputes wrapper payload for verification.
- `rotate` marks current active key as `expiring` and creates a new active key.

5. Delegation issuance and chain validation
- `DelegationManager.issue`:
  - Supports root tokens and child tokens.
  - Verifies parent exists for child issue.
  - Enforces `maxDepth` (default `3`).
  - Enforces scope narrowing versus parent scope using `CapabilityMatcher`.
  - Applies default expiry of one hour (`3_600_000` ms) unless overridden.
  - Signs token with HMAC-SHA256 and stores it.
  - Registers parent-child relation in `childrenMap` for cascade revoke.
- `validateChain(tokenId)`:
  - Walks leaf to root via `parentTokenId`.
  - Checks existence, revocation, expiry, signature validity, and depth bounds.
  - Reverses to root-first token order and computes `effectiveScope` by intersection.
- `revoke(tokenId)`:
  - Marks token revoked in store and recursively revokes descendants tracked in `childrenMap`.

6. Capability authorization
- `createCapabilityChecker.check` precedence:
  - Delegation scope (when both `delegationTokenId` and `delegationManager` are present).
  - Direct identity capabilities.
  - Role fallback from role-capability map.
- Default role map:
  - `admin`: `*`
  - `operator`: `runs.*`, `agents.read`, `tools.*`, `approvals.*`
  - `viewer`: `*.read`
  - `agent`: `runs.*`, `tools.execute`
- Matching behavior:
  - Exact and global wildcard `*`.
  - Suffix wildcards via `CapabilityMatcher` (example `code.*`).
  - Prefix wildcard handling for `*.<suffix>` (example `*.read`).
- If delegation is provided and does not grant a capability, result is denied immediately (no direct/role fallback).

7. Trust scoring
- `createTrustScorer.calculate` computes weighted total:
  - Reliability `0.35`
  - Performance `0.20`
  - Cost predictability `0.15`
  - Delegation compliance `0.15`
  - Recency `0.15`
- Defaults:
  - Default score `0.5` when below minimum sample size (`minSampleSize` default `5`).
  - Recency half-life default: 7 days.
  - Change callback threshold default: `0.05`.
- `recordOutcome` updates aggregate signals, stores recalculated score, and invokes `onScoreChanged` when threshold is met.
- `getChainTrust` returns the minimum trust score across delegatees in chain tokens, defaulting to `0.5` for empty chains.

## Key APIs and Types
Core models and schemas:
- `CredentialType`, `ForgeCredential`, `ForgeCapability`, `ForgeIdentity`, `ForgeIdentityRef`
- `ForgeCapabilitySchema`, `ForgeCredentialSchema`, `ForgeIdentitySchema`, `ForgeIdentityRefSchema`
- `toIdentityRef(identity)`

URI and endpoint resolution:
- `ForgeUriSchema`
- `parseForgeUri`, `buildForgeUri`, `isForgeUri`, `toAgentUri`, `fromAgentUri`
- `createUriResolver`
- `ParsedForgeUri`, `UriResolver`, `UriResolverStrategy`, `UriResolverConfig`

Identity resolution:
- `IdentityResolutionContext`, `IdentityResolver`, `CompositeIdentityResolver`
- `APIKeyRecord`, `APIKeyResolverConfig`, `APIKeyIdentityResolver`
- `hashAPIKey`, `createAPIKeyResolver`

Signing:
- `SigningKeyStatus`, `SigningKeyPair`, `SignedDocument<T>`, `SignedAgentCard`, `KeyStore`
- `KeyManagerConfig`, `KeyManager`, `InMemoryKeyStore`, `createKeyManager`

Delegation and authorization:
- `DelegationConstraint`, `DelegationToken`, `DelegationChain`, `DelegationTokenStore`
- `InMemoryDelegationTokenStore`
- `DelegationManagerConfig`, `IssueDelegationParams`, `DelegationManager`
- `CapabilityCheckParams`, `CapabilityCheckResult`, `CapabilityCheckerConfig`, `CapabilityChecker`, `createCapabilityChecker`

Trust scoring:
- `TrustSignals`, `TrustScoreBreakdown`, `TrustScoreStore`, `TrustScorerConfig`, `TrustScorer`
- `InMemoryTrustScoreStore`, `createTrustScorer`

## Dependencies
External/runtime dependencies used directly in this subsystem:
- `node:crypto`
  - SHA-256 hashing in API-key resolution.
  - HMAC signing and timing-safe comparison in delegation verification.
  - Ed25519 key generation/sign/verify and UUID generation in key/delegation flows.
- `zod`
  - Identity and URI runtime schemas.
- `globalThis.fetch` or injected `fetchImpl`
  - Registry URI resolution in `forge-uri.ts`.

Internal package dependencies:
- `../registry/capability-matcher.js`
  - Used by delegation and capability authorization for wildcard/pattern handling.

Packaging/deployment dependencies:
- `src/identity.ts` is included as a tsup entry point (`tsup.config.ts`) and published as `@dzupagent/core/identity`.
- `package.json` maps the identity subpath to `dist/identity.js` and `dist/identity.d.ts`.

## Integration Points
Internal integration:
- `src/identity/index.ts` is the local barrel for all identity primitives.
- `src/index.ts` re-exports identity APIs on root `@dzupagent/core`.

Public import surfaces:
- `@dzupagent/core/identity` (`src/identity.ts`) exports:
  - Identity subsystem APIs from `src/identity/index.ts`.
  - Protocol APIs from `src/protocol/index.ts` (message envelope, router, A2A, JSON-RPC, push notifications).
- `@dzupagent/core` (`src/index.ts`) exports identity and protocol in separate sections.

Extension seams for consumers:
- `IdentityResolver` for custom auth mechanisms.
- `KeyStore` for durable key persistence.
- `DelegationTokenStore` for durable token storage/revocation state.
- `TrustScoreStore` for persistent trust signals/scores.
- `UriResolverConfig.fetchImpl` for runtime-specific network behavior.

## Testing and Observability
Identity test coverage is concentrated in `src/identity/__tests__`:
- `identity.test.ts`
  - Capability/credential/identity schema validation.
  - URI parsing, building, scheme conversion, and resolver strategy behavior.
  - Registry resolver edge behavior (fallback, retry bounds, endpoint normalization, non-retry `401`).
- `resolver.test.ts`
  - API-key hash behavior.
  - API-key resolver resolution/verification paths, cache TTL/eviction/invalidation.
  - Composite resolver ordering and verification behavior.
- `signing.test.ts`
  - In-memory key store CRUD/status behavior.
  - Key generation, sign/verify integrity, document signing, rotation.
- `delegation.test.ts`
  - Delegation store behavior.
  - Token issue constraints (scope narrowing, depth limits, parent existence), tamper detection.
  - Chain validation failures, revocation cascade, capability-check precedence.
- `trust-scorer.test.ts`
  - Weighted score calculation behavior and defaults.
  - Outcome accumulation and callback threshold logic.
  - Chain trust minimum-score behavior and in-memory store CRUD.

Additional branch-focused coverage:
- `src/__tests__/w15-h2-branch-coverage.test.ts`
  - Extra trust-scorer branches.
  - Additional `forge-uri` resolver branches.

Observability currently built into identity code:
- `TrustScorerConfig.onScoreChanged` callback for score change notifications.
- No built-in logging/metrics/tracing emission in identity modules; external observability must be implemented by callers/integration layers.

## Risks and TODOs
- Delegation signature payload excludes `constraints` and `parentTokenId`; token verification does not cryptographically bind those fields.
- `DelegationConstraint` is modeled but not actively enforced by `DelegationManager.validateChain` or `createCapabilityChecker`.
- In-memory stores (`InMemoryKeyStore`, `InMemoryDelegationTokenStore`, `InMemoryTrustScoreStore`) are non-durable and process-local.
- Cascade revocation relies on in-memory `childrenMap`; descendants cannot be discovered from `DelegationTokenStore` alone after restart.
- `InMemoryKeyStore.getActive()` returns the first active entry by map iteration order when multiple keys are marked active.
- Identity and credential schemas use `z.date()`, so serialized JSON timestamp strings must be converted to `Date` before validation.
- Registry resolver needs `fetch` availability (or injected `fetchImpl`) for active lookup; otherwise registry strategy can only return template fallback when configured.
- `@dzupagent/core/identity` currently bundles protocol exports in the same subpath, which broadens the import surface beyond identity-only concerns.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js

