# Identity Module Architecture (`packages/core/src/identity`)

## Scope
The identity module in `@dzupagent/core` provides foundational primitives and services for:
- identity modeling and validation
- identity URI parsing/resolution
- authentication resolution (resolver abstraction + API key resolver)
- document signing and key lifecycle management (Ed25519)
- delegation token issuance/verification/chaining
- capability-based authorization checks
- trust score calculation and persistence

Primary entrypoint: `packages/core/src/identity/index.ts` (barrel exports).

## High-Level Design
The module is split into composable building blocks, not a single orchestrator:

1. Type/schema layer
- `identity-types.ts`
- `identity-schemas.ts`
- `signing-types.ts`
- `delegation-types.ts`

2. Service layer
- `forge-uri.ts`
- `identity-resolver.ts`
- `api-key-resolver.ts`
- `key-manager.ts`
- `delegation-manager.ts`
- `capability-checker.ts`
- `trust-scorer.ts`

3. In-memory default stores
- `InMemoryKeyStore`
- `InMemoryDelegationTokenStore`
- `InMemoryTrustScoreStore`

This keeps the module framework-style and reusable across packages (server, registry, adapters), with interfaces available for production-grade persistent implementations.

## Public Features and Responsibilities

### 1) Identity, Capability, Credential Models
Files:
- `identity-types.ts`
- `identity-schemas.ts`

What it provides:
- `ForgeIdentity`, `ForgeIdentityRef`, `ForgeCapability`, `ForgeCredential`
- `CredentialType` enum-like union (`api-key`, `oauth2`, `did-vc`, `mtls`, `delegation`, `custom`)
- `toIdentityRef(identity)` helper
- Zod schemas for all primary types

Behavior notes:
- capability names enforce a strict pattern: dot-separated lowercase segments with optional hyphens (for example, `code.review` or `code-gen.typescript`)
- capability version requires semver-like `x.y.z`
- schemas validate dates as real `Date` objects (not ISO strings)

Usage example:
```ts
import { ForgeIdentitySchema, toIdentityRef } from '@dzupagent/core'

const parsed = ForgeIdentitySchema.parse(identityPayload)
const identityRef = toIdentityRef(parsed)
```

### 2) Forge URI Utilities and Resolution
File:
- `forge-uri.ts`

What it provides:
- `ForgeUriSchema`
- parsing/building: `parseForgeUri`, `buildForgeUri`, `isForgeUri`
- scheme conversion: `toAgentUri`, `fromAgentUri`
- endpoint resolution strategies via `createUriResolver(...)`
  - `static`
  - `convention`
  - `registry` (HTTP lookup with timeout/retry/fallback support)

Resolution flow (`registry` strategy):
1. validate `forge://` URI
2. derive registry lookup URL
3. call registry with timeout + retry policy
4. parse endpoint from plain URL or nested JSON payload
5. fallback to template URL if lookup fails and template exists

Usage example:
```ts
import { createUriResolver } from '@dzupagent/core'

const resolver = createUriResolver('registry', {
  registryUrl: 'https://registry.forge.dev',
  urlTemplate: 'https://{org}.agents.internal/{name}',
  timeoutMs: 3000,
  maxRetries: 2,
})

const endpoint = await resolver.resolve('forge://acme/reviewer@1.2.0')
```

### 3) Identity Resolver Abstraction and Composition
File:
- `identity-resolver.ts`

What it provides:
- `IdentityResolver` interface:
  - `resolve(context) -> ForgeIdentity | null`
  - `verify(identity) -> boolean`
- `CompositeIdentityResolver` chain:
  - first non-null resolver wins during `resolve`
  - any resolver can satisfy `verify`

Flow:
- authentication context (token/headers/metadata) enters resolver chain
- each resolver attempts resolution in order
- first successful resolver returns identity

Usage example:
```ts
import { CompositeIdentityResolver, createAPIKeyResolver } from '@dzupagent/core'

const apiKeyResolver = createAPIKeyResolver({ records: apiKeyRecords })
const resolver = new CompositeIdentityResolver([apiKeyResolver /*, jwtResolver, didResolver */])

const identity = await resolver.resolve({ token: 'sk-live-...' })
```

### 4) API Key Identity Resolution
File:
- `api-key-resolver.ts`

What it provides:
- `hashAPIKey(key)` using SHA-256
- `createAPIKeyResolver(config)` with:
  - static or async record loader
  - internal TTL LRU cache
  - `invalidate(keyHash)` for cache eviction

Authentication flow:
1. receive token from context
2. hash token (never store plaintext key in records)
3. check LRU cache
4. on miss: load record source and find matching hash
5. reject expired records
6. cache positive or negative result

Usage example:
```ts
import { createAPIKeyResolver, hashAPIKey } from '@dzupagent/core'

const resolver = createAPIKeyResolver({
  records: [
    { keyHash: hashAPIKey('my-secret-key'), identity: myIdentity },
  ],
  cacheTtlMs: 5 * 60_000,
  cacheMaxSize: 1000,
})
```

### 5) Signing and Key Management (Ed25519)
Files:
- `signing-types.ts`
- `key-manager.ts`

What it provides:
- `createKeyManager({ store })`
- key lifecycle: `generate`, `rotate`, `getActiveKey`
- payload signing/verification: `sign`, `verify`
- envelope signing: `signDocument`, `verifyDocument`
- `InMemoryKeyStore` default implementation

Design details:
- deterministic canonical JSON serialization for signing input
- Base64URL signatures
- raw key bytes persisted in store; reconstructed into Node `KeyObject` for crypto ops

Usage example:
```ts
import { createKeyManager, InMemoryKeyStore } from '@dzupagent/core'

const manager = createKeyManager({ store: new InMemoryKeyStore() })
const key = await manager.generate()

const signed = await manager.signDocument({ card: 'agent metadata' }, key.keyId)
const ok = await manager.verifyDocument(signed, key.publicKey)
```

### 6) Delegation Tokens and Chains
Files:
- `delegation-types.ts`
- `delegation-store.ts`
- `delegation-manager.ts`

What it provides:
- token model: `DelegationToken`, `DelegationChain`, `DelegationConstraint`
- persistence interface: `DelegationTokenStore`
- default in-memory store: `InMemoryDelegationTokenStore`
- manager: `DelegationManager`
  - `issue`
  - `verify`
  - `validateChain`
  - `revoke` (with child cascade in-process)
  - `hasCapabilityInChain`

Delegation flow:
1. issue root token or child token
2. child issuance enforces max depth + scope narrowing relative to parent
3. token signed with HMAC-SHA256
4. validation walks leaf -> root and checks:
- existence
- revocation
- expiration
- signature validity
- max depth
5. effective scope is intersection across chain scopes

Usage example:
```ts
import { DelegationManager, InMemoryDelegationTokenStore } from '@dzupagent/core'

const manager = new DelegationManager({
  store: new InMemoryDelegationTokenStore(),
  signingSecret: process.env.DELEGATION_SECRET!,
  maxDepth: 3,
})

const token = await manager.issue({
  delegator: 'forge://acme/supervisor',
  delegatee: 'forge://acme/reviewer',
  scope: ['code.review.*'],
  expiresInMs: 60 * 60_000,
})

const chain = await manager.validateChain(token.id)
const allowed = manager.hasCapabilityInChain(chain, 'code.review.security')
```

### 7) Capability Authorization Checker
File:
- `capability-checker.ts`

What it provides:
- `createCapabilityChecker({ delegationManager?, roleCapabilityMap? })`
- precedence model:
  1. delegation chain scope (if `delegationTokenId` provided)
  2. direct identity capabilities
  3. role-based fallback map

Pattern support:
- exact (`runs.create`)
- global wildcard (`*`)
- suffix wildcard (`runs.*` via `CapabilityMatcher`)
- prefix wildcard (`*.read`)

Usage example:
```ts
import { createCapabilityChecker } from '@dzupagent/core'

const checker = createCapabilityChecker()
const result = await checker.check({
  identity: {
    id: 'id-1',
    uri: 'forge://acme/agent',
    displayName: 'Agent',
    capabilities: [{ name: 'runs.*', version: '1.0.0', description: 'run control' }],
  },
  requiredCapability: 'runs.cancel',
})

if (!result.allowed) throw new Error(result.reason)
```

### 8) Trust Scoring
File:
- `trust-scorer.ts`

What it provides:
- `createTrustScorer(...)`
- `calculate(signals)` for static scoring
- `recordOutcome(agentId, outcome)` for incremental updates
- `getScore(agentId)`
- `getChainTrust(chain)` (minimum score across delegatees)
- `InMemoryTrustScoreStore`

Scoring dimensions (weighted):
- reliability (0.35)
- performance (0.20)
- cost predictability (0.15)
- delegation compliance (0.15)
- recency decay (0.15)

Usage example:
```ts
import { createTrustScorer, InMemoryTrustScoreStore } from '@dzupagent/core'

const scorer = createTrustScorer({
  store: new InMemoryTrustScoreStore(),
  minSampleSize: 5,
  significanceThreshold: 0.05,
})

await scorer.recordOutcome('agent-42', {
  success: true,
  responseTimeMs: 420,
  estimatedCostCents: 8,
  actualCostCents: 9,
})

const trust = await scorer.getScore('agent-42')
```

## End-to-End Runtime Flows

### Flow A: HTTP identity + capability authorization (current real integration)
Used in `packages/server/src/middleware`:
1. `identityMiddleware` extracts token from `Authorization` (`Bearer` or `ApiKey`) or `X-API-Key`.
2. It calls configured `IdentityResolver.resolve({ token, headers })`.
3. On success, identity and capabilities are saved in request context.
4. `capabilityGuard` obtains identity via `getForgeIdentity`.
5. `createCapabilityChecker().check(...)` enforces required capability/capabilities.

This is currently the primary runtime consumption path of identity services outside `core`.

### Flow B: Registry identity metadata propagation
- `RegisterAgentInput` and `RegisteredAgent` include optional `identity?: ForgeIdentityRef` and `uri?: string` in `packages/core/src/registry/types.ts`.
- `packages/server/src/persistence/postgres-registry.ts` persists and restores these fields.
- This links registry records with identity URIs/references for discovery and downstream policy decisions.

### Flow C: Observability contract
- identity event types are declared in `packages/core/src/events/event-types.ts`.
- `packages/otel/src/event-metric-map/platform-identity.ts` maps those events to metrics.
- Note: event type contract exists; emission wiring is outside this module.

## References in Other Packages

### Direct runtime usage
- `packages/server/src/middleware/identity.ts`
  - consumes `IdentityResolver`, `ForgeIdentity`, `ForgeCapability`
  - request authentication/resolution glue
- `packages/server/src/middleware/capability-guard.ts`
  - consumes `createCapabilityChecker`
  - capability authorization middleware

### Type-level integration
- `packages/core/src/registry/types.ts`
  - consumes `ForgeCapability`, `ForgeIdentityRef`
- `packages/server/src/persistence/postgres-registry.ts`
  - consumes `ForgeCapability`, persists optional `identity` and `uri`
- `packages/server/src/routes/registry.ts`
  - consumes `ForgeCapability` in request/response shapes

### Event/telemetry contract usage
- `packages/core/src/events/event-types.ts`
  - declares identity event union members
- `packages/otel/src/event-metric-map/platform-identity.ts`
  - maps identity event types to metrics

### Current adoption status
At present, advanced identity services are mostly library-ready APIs within `core`:
- active external runtime usage: capability checker and resolver abstraction in server middleware
- limited/no direct runtime consumers yet for key manager, API key resolver factory, delegation manager, trust scorer, URI resolver
- these are currently validated primarily via `core` tests

## Test Coverage

## Executed checks
- `yarn workspace @dzupagent/core test -- src/identity`
  - result: `5` test files passed, `172` tests passed
- `yarn workspace @dzupagent/core test:coverage -- src/identity`
  - identity module coverage is very high
  - command exits non-zero because package-level global coverage thresholds are enforced across all `core` files, not only `src/identity`

## Identity test suite inventory
- `identity.test.ts` (63 tests)
  - schemas, URI parsing/building, resolver strategy behavior
- `resolver.test.ts` (22 tests)
  - API key hashing/resolution/cache behavior, composite resolver chaining
- `signing.test.ts` (24 tests)
  - key store behavior, signing/verification, rotation, signed document integrity
- `delegation.test.ts` (41 tests)
  - token store, delegation manager issuance/verification/chain/revocation, capability checker behavior
- `trust-scorer.test.ts` (22 tests)
  - scoring math, decay logic, outcome recording, chain trust, in-memory store

## Coverage highlights (identity folder)
From `vitest --coverage` output for `src/identity`:
- folder aggregate: `97.79%` statements, `89.44%` branches, `97.75%` functions, `97.79%` lines
- files at or near 100% include:
  - `capability-checker.ts`
  - `delegation-store.ts`
  - `identity-resolver.ts`
  - `identity-schemas.ts`
  - `identity-types.ts`
- comparatively lower branch coverage:
  - `forge-uri.ts` (82.75% branches)
  - `trust-scorer.ts` (70.21% branches)

## Observed test gaps
- delegation constraints are modeled and stored but not enforced in authorization logic; tests assert storage/propagation more than runtime enforcement.
- no external integration tests showing delegation manager/trust scorer/API key resolver wired into server runtime.
- identity event types are tested on telemetry mapping side, but this module does not emit those events directly.

## Architectural Strengths
- clear interface-based design with swappable storage backends
- strong unit test depth for module-level behavior
- minimal coupling to framework/runtime layers
- security-conscious defaults in key areas (hashed API keys, timing-safe signature comparison, deterministic signing payloads)

## Risks and Design Caveats

### High: incomplete delegation token signing scope
In `delegation-manager.ts`, token signature payload currently includes id/delegator/delegatee/scope/depth/timestamps, but not all token fields (`constraints`, `parentTokenId`).

Impact:
- unsigned fields can be tampered with without invalidating signature checks
- chain semantics and future constraint enforcement can be undermined if relying on signature as full-token integrity guarantee

Recommendation:
- sign a canonical representation of the complete token payload except `signature` itself (including `constraints` and `parentTokenId`)
- add tampering tests for each signed field

### Medium: constraints are not enforced at authorization time
`DelegationConstraint` types exist, and tokens carry constraints, but capability authorization only evaluates scope patterns.

Impact:
- a token may appear constrained (cost/tool/time), but enforcement is currently absent in the checker path

Recommendation:
- add a constraint evaluation stage (time window, tool allowlist, budget dimensions) to delegation authorization flow

### Medium: in-memory parent-child revocation map is process-local
Cascading revocation relies on an in-memory `childrenMap` inside `DelegationManager`.

Impact:
- revocation cascade may be incomplete across restarts or multi-instance deployments unless backed by persistent child lookups

Recommendation:
- extend `DelegationTokenStore` with parent->children query and perform cascade via store data

## Practical Integration Guidance
For production adoption sequence:
1. start with `IdentityResolver` + `identityMiddleware` + `capabilityGuard`
2. wire in `createAPIKeyResolver` with persistent record source
3. introduce delegation issuance/validation only after full-token signing + constraint enforcement
4. add trust score persistence store and emit identity trust/delegation events through event bus
5. connect URI resolver strategy (`registry` or `convention`) to service discovery layer
