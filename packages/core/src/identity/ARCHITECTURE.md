# Identity Architecture (`@dzupagent/core`)

## Scope
This document describes the current implementation under `packages/core/src/identity` in `dzupagent`. The scope includes:
- identity domain types and Zod validation schemas
- `forge://` URI parsing/conversion and endpoint resolution strategies
- composable identity resolution (`IdentityResolver`, `CompositeIdentityResolver`)
- API key identity resolution with SHA-256 hashing and in-memory LRU TTL caching
- Ed25519 key lifecycle and document signing/verification
- delegation token issuance, verification, chain validation, and revocation
- capability authorization checks (delegation, direct capability, role fallback)
- trust-signal persistence and trust-score computation

The module is exported through `src/identity/index.ts` and re-exported from `packages/core/src/index.ts` (main `@dzupagent/core` export).

## Responsibilities
- Define identity primitives:
  - `ForgeIdentity`, `ForgeCapability`, `ForgeCredential`, `ForgeIdentityRef`, `CredentialType`
  - helper `toIdentityRef(identity)`
- Validate identity and URI payloads:
  - `ForgeCapabilitySchema`, `ForgeCredentialSchema`, `ForgeIdentitySchema`, `ForgeIdentityRefSchema`, `ForgeUriSchema`
- Handle URI operations:
  - parse/build/check `forge://` URIs
  - convert `forge://` <-> `agent://`
  - resolve URIs to endpoints via `static`, `convention`, or `registry` strategy
- Resolve identities from request context:
  - generic resolver contract (`IdentityResolver`)
  - chain composition (`CompositeIdentityResolver`)
  - API-key resolver (`createAPIKeyResolver`)
- Provide signing primitives:
  - key storage contract (`KeyStore`)
  - in-memory key store (`InMemoryKeyStore`)
  - key manager (`createKeyManager`) for generate/sign/verify/rotate
- Provide delegation primitives:
  - delegation types and token store interface
  - in-memory token store (`InMemoryDelegationTokenStore`)
  - delegation manager (`DelegationManager`) for issue/verify/validate/revoke
- Provide authorization helper:
  - `createCapabilityChecker` with explicit grant source (`delegation`, `direct`, `role`)
- Provide trust scoring:
  - trust store contract and in-memory store
  - scorer factory (`createTrustScorer`) with weighted scoring and change callback

## Structure
- `identity-types.ts`: core identity/capability/credential/reference types and `toIdentityRef`.
- `identity-schemas.ts`: Zod schemas for identity domain objects.
- `forge-uri.ts`: `ForgeUriSchema`, parse/build helpers, scheme conversion helpers, and URI resolver implementations.
- `identity-resolver.ts`: `IdentityResolutionContext`, `IdentityResolver`, `CompositeIdentityResolver`.
- `api-key-resolver.ts`: API key hashing (`hashAPIKey`) and resolver with LRU cache + TTL + invalidation.
- `signing-types.ts`: signing key and signed-document contracts.
- `key-manager.ts`: Ed25519 key generation/signing/verification/rotation and `InMemoryKeyStore`.
- `delegation-types.ts`: delegation token, constraints, chain, and persistence interface.
- `delegation-store.ts`: in-memory `DelegationTokenStore` implementation.
- `delegation-manager.ts`: token issue/verify/chain validation/revocation logic.
- `capability-checker.ts`: capability authorization with delegation/direct/role resolution order.
- `trust-scorer.ts`: trust signal model, score math, store contracts, in-memory store, scorer implementation.
- `index.ts`: identity barrel exports.
- `__tests__/identity.test.ts`: schemas + URI + resolver strategy tests.
- `__tests__/resolver.test.ts`: API key resolver and composite resolver tests.
- `__tests__/signing.test.ts`: key store/manager and signing tests.
- `__tests__/delegation.test.ts`: delegation store/manager + capability checker tests.
- `__tests__/trust-scorer.test.ts`: trust scoring/store tests.

## Runtime and Control Flow
1. Validation and identity shaping
- Callers validate identity/capability/credential/ref objects through Zod schemas.
- Date fields in schemas are strict `z.date()` values (not ISO strings).
- `toIdentityRef` strips a full identity down to `{ id, uri, displayName }`.

2. URI parse/build/resolve
- `parseForgeUri` and `buildForgeUri` enforce `forge://<org>/<name>(@<semver>)?`.
- `toAgentUri`/`fromAgentUri` perform scheme-only conversion with validation.
- `createUriResolver` chooses one strategy:
  - `static`: lookup from a provided map.
  - `convention`: interpolate `urlTemplate` placeholders `{org}` and `{name}`.
  - `registry`: call a registry endpoint with timeout/retry; optionally fallback to `urlTemplate`.
- Registry resolver behavior:
  - default registry URL: `https://registry.forge.dev`
  - default timeout: `5000ms`
  - default retries after first attempt: `1`
  - treats `404/410` as not-found, selected HTTP statuses and network/abort errors as retryable
  - accepts endpoint from direct URL string or nested JSON fields (`endpoint`, `url`, `uri`, `agentUrl`, `location`, `href`, including nested `data`/`result`/`value`)
  - only accepts `http:`/`https:` endpoints

3. Identity resolution path
- `CompositeIdentityResolver.resolve` executes resolvers in sequence and returns the first non-null identity.
- `CompositeIdentityResolver.verify` returns true if any resolver confirms the identity.
- `createAPIKeyResolver` flow:
  - read `context.token`
  - hash with SHA-256 (`hashAPIKey`)
  - check LRU cache (cached positive and negative results)
  - on miss, load records (static array or async provider), filter expired records, cache result
  - `invalidate(keyHash)` removes one cached entry

4. Signing and key lifecycle
- `createKeyManager.generate` creates an Ed25519 keypair and stores 32-byte raw public/private key material in `SigningKeyPair`.
- `sign` canonicalizes JSON by sorting object keys and signs with Ed25519, returning base64url.
- `verify` reconstructs public key object and validates signature; invalid format returns `false`.
- `signDocument` signs `{ document, signedAt, keyId, algorithm }` and returns a `SignedDocument<T>`.
- `verifyDocument` reconstructs that same signable payload and verifies.
- `rotate` marks current active key as `expiring`, then generates a new active key.

5. Delegation issuance and validation
- `DelegationManager.issue`:
  - if `parentTokenId` is present, parent must exist
  - child depth is `parent.depth + 1` and must be `<= maxDepth` (default `3`)
  - requested child scope must be covered by parent scope patterns
  - token TTL defaults to `1 hour`
  - signature is HMAC-SHA256 (base64url) over selected token fields
  - parent-child relation is tracked in-memory for cascade revoke
- `verify(token)` recomputes HMAC and compares using `timingSafeEqual`.
- `validateChain(tokenId)` walks leaf -> root via `parentTokenId` and rejects on:
  - missing token
  - revoked token
  - expired token
  - invalid signature
  - depth overflow
- valid chains are returned root-first with `effectiveScope` intersection.
- `revoke(tokenId)` revokes token and recursively revokes tracked descendants.

6. Capability authorization
- `createCapabilityChecker.check` order:
  - delegation check (only when both `delegationTokenId` and `delegationManager` are present)
  - direct identity capabilities
  - role capability map (default roles: `admin`, `operator`, `viewer`, `agent`)
- Pattern matching supports:
  - exact match
  - global `*`
  - suffix wildcard patterns handled by `CapabilityMatcher` (for example `runs.*`)
  - prefix wildcard `*.<suffix>` (for example `*.read`)
- If delegation is supplied but does not grant the capability, the result is denied without direct/role fallback.

7. Trust scoring
- `createTrustScorer` computes a weighted total:
  - reliability `0.35`
  - performance `0.20`
  - cost predictability `0.15`
  - delegation compliance `0.15`
  - recency `0.15`
- Defaults:
  - score `0.5` for agents below `minSampleSize` (default `5`)
  - recency half-life `7 days`
  - significance threshold `0.05`
- `recordOutcome` updates rolling aggregates in store and persists the new score.
- `onScoreChanged` is called only when absolute score delta meets threshold.
- `getChainTrust` returns the minimum score across delegatees in a chain (or `0.5` for empty chain).

## Key APIs and Types
- Identity primitives:
  - `ForgeIdentity`, `ForgeCapability`, `ForgeCredential`, `ForgeIdentityRef`, `CredentialType`
  - `toIdentityRef(identity)`
- Schemas:
  - `ForgeCapabilitySchema`, `ForgeCredentialSchema`, `ForgeIdentitySchema`, `ForgeIdentityRefSchema`, `ForgeUriSchema`
- URI:
  - `parseForgeUri`, `buildForgeUri`, `isForgeUri`, `toAgentUri`, `fromAgentUri`, `createUriResolver`
  - `ParsedForgeUri`, `UriResolver`, `UriResolverStrategy`, `UriResolverConfig`
- Identity resolution:
  - `IdentityResolutionContext`, `IdentityResolver`, `CompositeIdentityResolver`
  - `createAPIKeyResolver`, `hashAPIKey`
  - `APIKeyRecord`, `APIKeyResolverConfig`, `APIKeyIdentityResolver`
- Signing:
  - `SigningKeyStatus`, `SigningKeyPair`, `SignedDocument<T>`, `SignedAgentCard`, `KeyStore`
  - `KeyManagerConfig`, `KeyManager`, `createKeyManager`, `InMemoryKeyStore`
- Delegation and authorization:
  - `DelegationConstraint`, `DelegationToken`, `DelegationChain`, `DelegationTokenStore`
  - `DelegationManagerConfig`, `IssueDelegationParams`, `DelegationManager`, `InMemoryDelegationTokenStore`
  - `CapabilityCheckParams`, `CapabilityCheckResult`, `CapabilityCheckerConfig`, `CapabilityChecker`, `createCapabilityChecker`
- Trust:
  - `TrustSignals`, `TrustScoreBreakdown`, `TrustScoreStore`, `InMemoryTrustScoreStore`
  - `TrustScorerConfig`, `TrustScorer`, `createTrustScorer`

## Dependencies
- External/runtime:
  - `zod` for identity and URI schemas
  - Node `crypto` for SHA-256 hashing, HMAC signing, Ed25519 key/signature operations, UUID generation
  - `globalThis.fetch` in registry URI resolver (or injected `fetchImpl`)
- Internal:
  - `../registry/capability-matcher.js` used by `DelegationManager` and `createCapabilityChecker`
- Packaging context (`packages/core/package.json`):
  - package name: `@dzupagent/core`
  - identity exports are part of the main package entry (`"."`) and not a dedicated `./identity` export

## Integration Points
- Export surface:
  - identity barrel: `packages/core/src/identity/index.ts`
  - public package export: `packages/core/src/index.ts` re-exports identity APIs
- Pluggable contracts for production adapters:
  - `IdentityResolver`
  - `KeyStore`
  - `DelegationTokenStore`
  - `TrustScoreStore`
- Authorization integration:
  - `createCapabilityChecker({ delegationManager, roleCapabilityMap })` allows app-specific role policy and delegation enforcement wiring
- Service discovery integration:
  - URI registry mode accepts custom `registryUrl`, `fetchImpl`, retry/timeout, and template fallback

## Testing and Observability
- Test suites under `src/identity/__tests__`:
  - `identity.test.ts`: schema constraints, URI parse/build/conversion, URI resolver static/convention/registry behavior
  - `resolver.test.ts`: hashing consistency, API-key lookup/expiry/cache/invalidation, composite resolver order
  - `signing.test.ts`: in-memory keystore operations, key generation, sign/verify, signed-document integrity, rotation
  - `delegation.test.ts`: token issue/verify/chain validation/revocation cascade, capability checker matching and precedence
  - `trust-scorer.test.ts`: score math, defaults, `recordOutcome`, score callbacks, chain trust, in-memory store CRUD
- Observability in this module is minimal by design:
  - no built-in logging/metrics/tracing
  - one callback hook: `TrustScorerConfig.onScoreChanged`
  - callers must instrument resolver checks, delegation decisions, and trust updates if operational telemetry is required

## Risks and TODOs
- `DelegationManager.computeSignature` does not include `constraints` or `parentTokenId` in signed payload, so tampering of those fields is not detected by `verify`.
- `DelegationConstraint` values are stored but not enforced in `DelegationManager` validation or `createCapabilityChecker`.
- In-memory stores (`InMemoryKeyStore`, `InMemoryDelegationTokenStore`, `InMemoryTrustScoreStore`) are process-local and non-durable.
- `createCapabilityChecker` does not fallback to direct/role grants when a delegation token is supplied but insufficient.
- Registry URI resolution depends on available `fetch` unless `fetchImpl` is injected.
- Identity schemas require `Date` objects; raw JSON timestamp strings must be hydrated by callers before schema validation.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

