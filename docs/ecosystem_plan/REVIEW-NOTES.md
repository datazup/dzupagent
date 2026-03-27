# Ecosystem Plan Review Notes (Docs 01-03)

> **Reviewed:** 2026-03-24
> **Reviewer:** Principal Architect
> **Scope:** Cross-document consistency for 01-IDENTITY-TRUST, 02-COMMUNICATION-PROTOCOLS, 03-DISCOVERY-REGISTRY
> **Index:** 00-INDEX.md

---

## Cross-Document Issues (01-03)

### Critical (must fix)

#### C1: `ForgeCapability` vs `CapabilityDescriptor` — duplicate type with divergent shapes

**Doc 01** (line 226) defines `ForgeCapability` in `@dzipagent/core/src/identity/identity-types.ts` with fields: `name`, `version`, `description?`, `inputSchema: JSONSchema7` (required), `outputSchema?: JSONSchema7`, `sla?`.

**Doc 03** (line 169) defines `CapabilityDescriptor` in `@dzipagent/core/src/registry/types.ts` with fields: `name`, `version`, `description` (required, not optional), `inputSchema?: Record<string, unknown>` (optional), `outputSchema?: Record<string, unknown>`, `tags?: string[]`.

These represent the same concept (an agent's capability declaration) but diverge in four ways:
- `ForgeCapability.inputSchema` is `JSONSchema7` (typed) and **required**; `CapabilityDescriptor.inputSchema` is `Record<string, unknown>` (untyped) and **optional**.
- `ForgeCapability.description` is **optional**; `CapabilityDescriptor.description` is **required**.
- `CapabilityDescriptor` has `tags`; `ForgeCapability` does not.
- `ForgeCapability` has `sla`; `CapabilityDescriptor` does not.

**Impact:** Any code converting between identity capabilities and registry capabilities will need manual mapping. `RegisteredAgent` stores `CapabilityDescriptor[]` but `ForgeIdentity` stores `ForgeCapability[]`. Discovery results that include identity will have mismatched capability shapes.

**Fix:** Unify into a single type. Recommended approach:
1. Merge into `ForgeCapability` in `@dzipagent/core/src/identity/identity-types.ts`.
2. Add `tags?: string[]` to `ForgeCapability`.
3. Make `inputSchema` optional with type `Record<string, unknown>` (JSON Schema is a plain object at runtime; the `JSONSchema7` import adds an unnecessary dependency for consumers who do not need schema validation).
4. Make `description` consistently required (the registry needs it for search).
5. Move `sla` out of `ForgeCapability` and into `RegisteredAgent` at the agent level, or keep it as optional on the capability.
6. Alias `CapabilityDescriptor = ForgeCapability` in the registry module, or simply use `ForgeCapability` directly.

---

#### C2: `ForgeCapability` name regex vs capability taxonomy regex — incompatible validation rules

**Doc 01** (line 343) defines `ForgeCapabilitySchema` with capability name regex:
```
/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/
```
This **forbids hyphens** in segment names.

**Doc 03** (line 627, 782) states "Lowercase alphanumeric + hyphens within segments" and validates with per-segment regex:
```
/^[a-z][a-z0-9-]{0,63}$/
```
This **allows hyphens**.

The standard capability tree in Doc 03 (line 669) includes `'bulk-rename'`, `'line-by-line'`, and `'security-owasp'` as example segments, confirming hyphens are intended.

**Impact:** An agent registered with capability `code.edit.bulk-rename` would pass Doc 03 validation but **fail** Doc 01 Zod schema validation. This breaks round-trip consistency between identity and registry.

**Fix:** Update `ForgeCapabilitySchema` in Doc 01 (line 343) to allow hyphens:
```
/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/
```

---

#### C3: `ForgeMessage.metadata.delegationToken` is `string` but `DelegationToken` is a rich object

**Doc 02** (line 288) defines `ForgeMessageMetadata.delegationToken` as type `string`.

**Doc 01** (line 902) defines `DelegationToken` as a complex object with fields: `id`, `delegator`, `delegatee`, `scope`, `constraints`, `parentTokenId`, `depth`, `issuedAt`, `expiresAt`, `signature`.

**Doc 01** (line 1049) says "the delegation token is attached to the `ForgeMessage.metadata.delegationToken` field" but does not specify whether the field holds the **token ID** (for lookup) or the **serialized token** (for self-contained verification).

**Impact:** Implementers of the A2A adapter and the delegation validation logic will not know which representation to expect, leading to incompatible implementations.

**Fix:** Choose one convention and document it explicitly:
- **Option A (recommended for internal):** Rename to `delegationTokenId: string`. Receivers resolve the full token via `DelegationTokenStore.get(id)`.
- **Option B (recommended for cross-process A2A):** Change type to `delegationToken?: DelegationToken` (the full serialized object) so messages are self-contained.
- A practical approach: use Option A for `protocol: 'internal'` and Option B for `protocol: 'a2a'`/`'grpc'`. Document this convention in both docs.

---

#### C4: `RegisteredAgent` does not include `ForgeIdentity` despite Doc 03 claiming it does

**Doc 03** Section 1.4 (line 123) states: "Registration requires identity -- `register()` accepts a `RegisteredAgent` that includes a `ForgeIdentity` (URI, public key fingerprint, credential type). Anonymous registration is rejected."

However, the actual `RegisteredAgent` interface (Doc 03 line 192) has **no** `identity`, `ForgeIdentity`, or `ForgeIdentityRef` field. It also has no `uri` field matching the `forge://` scheme.

The `RegisterAgentInput` (line 411) likewise has no identity-related field.

**Impact:** The stated integration contract between the identity layer (Doc 01) and the registry (Doc 03) is not reflected in the types. Discovery results cannot include identity information for verification as the prose claims. The sentence "Anonymous registration is rejected" has no enforcement mechanism.

**Fix:**
1. Add `identity?: ForgeIdentityRef` to `RegisteredAgent` (optional for backward compat with pre-identity adoption).
2. Add `identity?: ForgeIdentityRef` to `RegisterAgentInput`.
3. Add `uri?: string` to `RegisteredAgent` for the `forge://` URI.
4. If anonymous rejection is desired, enforce it in `PostgresRegistry` (not `InMemoryRegistry`, which should remain lenient for dev).

---

### Warnings (should fix)

#### W1: `AgentProtocol` (Doc 03) vs `ForgeProtocol` (Doc 02) — overlapping but different enums

**Doc 02** (line 187): `ForgeProtocol = 'internal' | 'a2a' | 'mcp' | 'grpc' | 'anp' | 'http'`

**Doc 03** (line 227): `AgentProtocol = 'a2a' | 'mcp' | 'http' | 'ws' | 'grpc' | (string & {})`

Differences:
- Doc 03 includes `'ws'`; Doc 02 does not.
- Doc 02 includes `'internal'` and `'anp'`; Doc 03 does not.
- Doc 03 uses an open-ended string union `(string & {})`; Doc 02 is a closed union.

**Fix:** Define a single `ForgeProtocol` type in core that both modules use. Add `'ws'` to it. Keep `'internal'` and `'anp'`. Make it extensible with `(string & {})`. Then `AgentProtocol` becomes a type alias or is removed entirely.

---

#### W2: Index doc (00-INDEX.md) proposes `@dzipagent/identity` package but Doc 01 ADR rejects it

**00-INDEX.md** (line 120) lists `@dzipagent/identity` as a "New Package Proposal" from Doc 01.

**Doc 01** Appendix B (line 2211) contains ADR-001 with status **"Accepted"** deciding identity types live in `@dzipagent/core/src/identity/`, not a separate package.

**Fix:** Remove `@dzipagent/identity` from the 00-INDEX package proposals table, or annotate it as "deferred/conditional -- see ADR-001 in Doc 01."

---

#### W3: Effort totals inconsistent across docs

| Document | Header claim | Actual sum from features | Delta |
|----------|-------------|-------------------------|-------|
| Doc 01 | ~76h | 4+2+4+8+6+4+12+16+12+8 = 76h | OK |
| Doc 02 | ~72h | 4+4+0+12+8+8+8+4+12+8 = 68h | **-4h** |
| Doc 03 | ~58h | 4+4+4+8+8+6+4+16+8 = 62h | **+4h** |

Doc 03 header also states "(P0: 12h, P1: 22h, P2: 12h, P3: 16h)" which sums to 62h, contradicting the "~58h" header.

**Fix:** Update Doc 02 header to "~68h". Update Doc 03 header to "~62h".

---

#### W4: `CircuitBreaker` API usage in Doc 03 is unverified against existing implementation

**Doc 03** (line 2089) uses: `new CircuitBreaker({ failureThreshold, resetTimeoutMs, halfOpenMaxAttempts })` with methods `canExecute()`, `recordSuccess()`, `recordFailure()`, `getState()`.

The existing `CircuitBreaker` in `@dzipagent/core/src/llm/circuit-breaker.ts` may have a different API surface.

**Fix:** Verify the existing `CircuitBreaker` API and align the `HealthMonitor` code, or add the expected API contract to the doc.

---

#### W5: `registerFromCard()` and `AgentCardCache` use different well-known paths

- **Doc 03** `registerFromCard()` (line 1300): fetches the raw `cardUrl` parameter directly (no path appended).
- **Doc 02** `AgentCardCache` (line 1390): appends `/.well-known/agent.json` to the base URL.
- **Doc 03** migration section (line 3153): mentions both `/.well-known/agent.json` (existing) and `/.well-known/agent-card.json` (A2A v2 standard).

**Fix:** Standardize. `registerFromCard(cardUrl)` should accept a full URL (as it does). `AgentCardCache.getCard(baseUrl)` should try `/.well-known/agent-card.json` first, then `/.well-known/agent.json` as fallback. Document the convention.

---

#### W6: `RegistryEvent` typed union loses type safety when added to `DzipEvent`

**Doc 03** defines `RegistryEvent` union (line 433) with properly typed fields using `DeregistrationReason` and `AgentHealthStatus`.

But the "Event types to add to `event-types.ts`" block (line 609) weakens these to plain `string`:
```typescript
| { type: 'registry:agent_deregistered'; agentId: string; reason: string }
| { type: 'registry:health_changed'; agentId: string; previousStatus: string; newStatus: string }
```

**Fix:** The `event-types.ts` additions should use the typed aliases: `reason: DeregistrationReason`, `previousStatus: AgentHealthStatus`, `newStatus: AgentHealthStatus`.

---

#### W7: `ForgeMessage.from`/`to` accept URI schemes beyond `forge://` but `ForgeUriSchema` only validates `forge://`

**Doc 01** (line 368): `ForgeUriSchema` validates only `forge://org/agent-name[@version]`.

**Doc 02** (line 123, 349-354): `ForgeMessage.from`/`to` fields use `a2a://`, `mcp://`, and `forge://` URI schemes.

**Impact:** Applying `ForgeUriSchema` to validate message URIs would reject all non-forge:// URIs.

**Fix:** Define a separate `ForgeMessageUriSchema` that accepts all protocol schemes, or document that `ForgeUriSchema` is for identity URIs only and must not be used for message routing URIs.

---

#### W8: `AgentAuthentication.type` naming diverges from `CredentialType`

**Doc 03** (line 233): `AgentAuthentication.type = 'none' | 'bearer' | 'api-key' | 'oauth2' | 'mtls' | 'delegation-token'`

**Doc 01** (line 176): `CredentialType = 'api-key' | 'oauth2' | 'did-vc' | 'mtls' | 'delegation' | 'custom'`

Naming mismatch: `'delegation-token'` (Doc 03) vs `'delegation'` (Doc 01). Also `'none'` and `'bearer'` exist only in Doc 03.

**Fix:** Use `'delegation'` consistently. Document that `AgentAuthentication.type` describes what auth **callers** must provide, while `CredentialType` describes what credentials an **agent holds** -- these are related but distinct concepts. Add a cross-reference.

---

### Suggestions (nice to have)

#### S1: Consider a shared `SLA` type

Doc 01 (line 237) defines per-capability SLA: `{ maxLatencyMs: number; maxCostCents: number }`.
Doc 03 (line 284) defines per-agent SLA: `{ maxLatencyMs?; minUptimeRatio?; maxErrorRate?; maxRps? }`.

Consider a base `SLA` type both extend, or at minimum cross-reference in JSDoc.

---

#### S2: Use `ForgeIdentityRef` more broadly

Doc 01 (line 298) defines `ForgeIdentityRef` (`{ id, uri, displayName }`) as a lightweight reference. Docs 02 and 03 could use this for `ForgeMessage.from`/`to` attribution or `RegisteredAgent` owner identification to improve traceability without carrying full `ForgeIdentity` objects.

---

#### S3: Zod schema naming convention inconsistency

- Doc 01 uses PascalCase: `ForgeIdentitySchema`, `ForgeCapabilitySchema`, `ForgeUriSchema`.
- Doc 02 uses camelCase: `forgeMessageSchema`, `forgeMessageMetadataSchema`, `forgePayloadSchema`.

**Fix:** Pick one convention. PascalCase for exported schemas and camelCase for file-local schemas would be a reasonable rule.

---

#### S4: Missing consolidated event type catalog

Doc 01 adds `identity:*` events (5 types). Doc 02 adds `protocol:*` events (7 types). Doc 03 adds `registry:*` events (5 types). That is 17 new event types being added to the `DzipEvent` discriminated union across three documents.

**Fix:** Add a cross-reference table to 00-INDEX.md listing all new event type prefixes, their owning docs, and payload shapes. This prevents naming collisions and helps implementers see the full picture.

---

#### S5: `InternalAdapter.extractAgentId` captures version suffix

Doc 02 (line 1129) regex `/^forge:\/\/[^/]+\/(.+)$/` extracts `code-reviewer@1.2.0` from `forge://acme/code-reviewer@1.2.0`. AgentBus channels are likely keyed by simple names, not versioned identifiers.

**Fix:** Strip the `@version` suffix before routing to AgentBus, or document that channel names include the version.

---

#### S6: `InMemoryRegistry.update()` mutates objects in place

Doc 03 (line 1164) mutates the stored `RegisteredAgent` via direct property writes. If `RegisteredAgent` fields are ever made `readonly`, this breaks.

**Fix:** Use spread to create a new object: `const updated = { ...existing, ...changes, lastUpdatedAt: new Date() }; this.agents.set(agentId, updated)`.

---

#### S7: `DiscoveryQuery.capabilityExact.minVersion` uses string comparison for semver

Doc 03 (line 933) uses `exact.version < query.capabilityExact.minVersion` which is a lexicographic string comparison, not semver comparison. `"2.0.0" < "10.0.0"` is `false` lexicographically but should be `true` semantically.

Doc 03 Section 2.4 (line 1033) acknowledges this and provides a `compareSemver()` function but the `scoreAgent()` function does not use it.

**Fix:** Wire `compareSemver()` into `scoreAgent()` for the version check.

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 4 |
| Warning | 8 |
| Suggestion | 7 |

**Recommended resolution order:**

1. **C1 + C2** first -- unifying the capability type and regex is foundational; it affects interfaces in all three docs.
2. **C4** next -- add identity reference to `RegisteredAgent` to fulfill the stated contract.
3. **C3** -- clarify delegation token representation in messages.
4. **W1, W6, W8** -- naming and type consistency pass.
5. **W2, W3** -- index doc corrections.
6. Remaining warnings and suggestions can be addressed during implementation.

---

## Cross-Document Issues (04-06)

**Reviewer:** Principal Software Architect
**Date:** 2026-03-24
**Documents reviewed:** 04-ORCHESTRATION-PATTERNS.md, 05-MEMORY-SHARING.md, 06-OBSERVABILITY-TRACING.md
**Cross-referenced with:** 01-IDENTITY-TRUST.md, 02-COMMUNICATION-PROTOCOLS.md, 09-FORMATS-STANDARDS.md, 10-PIPELINES-WORKFLOWS.md

---

### Critical (must fix)

#### C9: Doc 05 defines its own `ForgeUri` type instead of importing from Doc 01

**Doc 05** (line 140) defines `type ForgeUri = \`forge://${string}\`` as a template literal type local to `@dzipagent/memory/src/sharing/types.ts`. This is a loose validation: it accepts any string after `forge://`, including malformed URIs like `forge://` (empty), `forge://UPPERCASE/BAD`, or `forge://a/b/c/d/e` (too many segments).

**Doc 01** (line 368) defines `ForgeUriSchema` with a strict Zod regex: `/^forge:\/\/[a-z0-9_-]+\/[a-z0-9_-]+(@\d+\.\d+\.\d+)?$/`. Doc 01 also provides `parseForgeUri()`, `buildForgeUri()`, and `isForgeUri()` utility functions in `@dzipagent/core/src/identity/forge-uri.ts`.

**Impact:** The `MemoryProvenance.createdBy` field uses `ForgeUri` from Doc 05, meaning provenance records can contain URIs that fail Doc 01 validation. When provenance data is later correlated with identity data (e.g., "who created this record?"), the URI mismatch will cause lookup failures. The `SharedMemorySpace.owner` and `MemoryParticipant.agentUri` fields have the same problem.

**Fix:** Doc 05 should import the `ForgeUri` type (or a branded string type) from `@dzipagent/core/src/identity/forge-uri.ts` instead of redefining it. If `@dzipagent/memory` cannot depend on core identity types (it can -- memory already depends on core), use the same template literal type but add a runtime validation call to `isForgeUri()` on writes.

---

#### C10: Doc 05 `ForgeUri` format diverges from Doc 01 URI scheme

**Doc 05** (line 134) uses a three-segment URI format: `forge://{tenantId}/{agentType}/{agentId}` with examples like `forge://t1/agent/planner` and `forge://t1/space/planning`.

**Doc 01** (line 515-526) uses a two-segment URI format: `forge://{org}/{agent-name}[@version]` with examples like `forge://acme/code-reviewer@1.2.0`.

These are structurally incompatible:
- Doc 01: `forge://acme/code-reviewer` -- org = `acme`, agentName = `code-reviewer`
- Doc 05: `forge://t1/agent/planner` -- this has 3 path segments, which Doc 01's parser would reject (it expects exactly 1 path segment after the org)

**Impact:** Agent URIs stored in provenance lineage chains (Doc 05 F2) cannot be resolved by the URI resolver (Doc 01 F2). Identity lookup from provenance data will fail. The `SharedMemorySpace.owner` field is also incompatible.

**Fix:** Standardize on Doc 01's two-segment format. Doc 05 examples should use `forge://t1/planner` instead of `forge://t1/agent/planner`. If a resource type discriminator is needed, encode it in the agent name (e.g., `forge://t1/space--planning`) or add an optional third segment to Doc 01's `ForgeUriSchema`. The recommended approach is to use the Doc 01 format as-is -- the identity layer owns URI format definition.

---

### Warnings (should fix)

#### W15: Blackboard architecture (Doc 04 F4) does not reference MemoryService or SharedMemorySpace (Doc 05)

Doc 04's `Blackboard` interface (line 1417) and `InMemoryBlackboard` (line 1538) define a standalone in-memory key-value store with `get/put/delete/onChange` methods. This is functionally identical to a simplified `SharedMemorySpace` from Doc 05 F1, but with no integration.

Key differences:
- `Blackboard.put()` takes `(key, value, writtenBy, tags?)`. `MemorySpaceManager.share()` takes `MemoryShareRequest` with `from`, `spaceId`, `key`, `value`, `mode`.
- `BlackboardEntry` stores `writtenBy: string` (plain agent ID). `MemoryProvenance` stores `createdBy: ForgeUri` (full URI with lineage chain).
- `Blackboard` has `onChange()` with local listeners. `SharedMemorySpace` uses `DzipEventBus` for cross-component notification.
- `Blackboard` has no persistence. `SharedMemorySpace` persists through `MemoryService`.

**Impact:** Two parallel shared-state mechanisms will exist in `@dzipagent/agent`, creating confusion about which to use. The blackboard gains no provenance tracking, no conflict resolution, and no persistence. Orchestration patterns using the blackboard cannot leverage memory sharing infrastructure.

**Fix:** Either (a) implement `Blackboard` as a thin wrapper around `SharedMemorySpace` with a simplified API, or (b) document that `Blackboard` is intentionally ephemeral (session-scoped, not persisted) while `SharedMemorySpace` is durable. Option (b) is simpler and likely correct -- the blackboard is a coordination primitive for a single orchestration run, not a cross-session store. Add a sentence to Doc 04 F4 clarifying this distinction and cross-referencing Doc 05 for durable shared state.

---

#### W16: Orchestration patterns (Doc 04) do not reference ForgeIdentity or DelegationToken from Doc 01

Doc 04 lists Doc 01 (Identity) as a dependency in the header and mentions "agent URIs" but none of the actual pattern interfaces reference `ForgeIdentity`, `ForgeIdentityRef`, or `DelegationToken`. Specifically:

- `ContractNetCFP` (Doc 04 line ~400) identifies the manager by plain string, not by `ForgeUri` or `ForgeIdentityRef`.
- `Bid.agentId` (Doc 04 line ~423) is a plain `string`, not a `ForgeUri`.
- `BlackboardEntry.writtenBy` (Doc 04 line 1399) is a plain `string`.
- No orchestration pattern checks capabilities before delegating work to an agent.

Meanwhile, Doc 01 Section 7.3 (line 2180) states: "04-ORCHESTRATION-PATTERNS: Delegation tokens for contract-net bidding, trust scores for agent selection."

**Impact:** The claimed integration between identity and orchestration does not exist in the type definitions. Contract-net bidding has no trust score awareness. Delegation tokens are not issued when the supervisor delegates to a specialist.

**Fix:** Add optional `identity?: ForgeIdentityRef` fields to `Bid`, `ContractNetCFP`, and `BlackboardEntry`. Add an optional `trustThreshold?: number` to `ContractNetConfig` that filters bidders by trust score. Document that these fields are opt-in for progressive adoption (patterns work without identity, but gain trust-based filtering when identity is available).

---

#### W17: Doc 06 observability events do not cover orchestration events from Doc 04

Doc 06's `OTelBridge` (line ~440) maps `DzipEvent` types to OTel metrics. The mapping table covers `agent:started`, `agent:completed`, `agent:failed`, `tool:called`, `tool:result` but does not mention any orchestration-specific events.

Doc 04 emits events through `DzipEventBus` with types like `contract-net:awarded` (line 745), `contract-net:retry` (line 703), and `BlackboardEvent` subtypes (`entry:written`, `entry:deleted`). These are fired via `eventBus?.emit()` calls throughout the orchestration code.

**Impact:** Orchestration executions (contract-net negotiations, blackboard rounds, quorum votes) will not produce OTel spans or metrics unless the `OTelBridge` is updated to handle these event types. Observability of multi-agent coordination will be a blind spot.

**Fix:** Doc 06 should add an `orchestration:*` event prefix to its metric mapping table, or Doc 04 events should use the existing `agent:*` prefix with additional metadata fields. The simpler approach: Doc 04 events should be added to `DzipEvent` in core, and Doc 06's `OTelBridge` mapping should include them.

---

#### W18: Doc 04 F5 (Workflow Persistence) is partially superseded by Doc 10 F3 but not marked

Doc 04 F5 defines `WorkflowCheckpoint` and `WorkflowStore` (line 1919-1961) for `CompiledWorkflow` persistence. Doc 10 F3 defines `PipelineCheckpoint` and `PipelineCheckpointStore` (line 1097-1200) for `PipelineRuntime` persistence. The existing Cross-Document Issues (10-12) section (C6) already identified this duplication and recommended Doc 04 F5 be superseded.

However, there is a nuance: Doc 04 F5 is designed for `CompiledWorkflow.run()` which is the existing sequential workflow runner, while Doc 10 is designed for the new `PipelineRuntime`. Until `WorkflowBuilder.build()` compiles to `PipelineDefinition` (Doc 10 goal), both systems coexist. Doc 04 F5 should be marked as "transitional -- will be superseded by Doc 10 F3 once WorkflowBuilder migration is complete."

---

#### W19: Doc 05 provenance `createdBy` type alignment with Doc 01 identity types

Doc 05 F2 `MemoryProvenance.createdBy` (line 509) is typed as `ForgeUri` (the Doc 05 template literal type). Doc 01's identity system uses `ForgeIdentityRef.id` (opaque string) and `ForgeIdentityRef.uri` (validated forge:// URI) as separate fields.

When other systems (Doc 06 audit trail, Doc 12 audit trail) need to correlate "who did this?", they need to resolve a `ForgeUri` string to an identity. But `ForgeUri` from Doc 05 could be the three-segment format (see C10), making resolution impossible.

**Fix:** Once C10 is resolved (standardize URI format), add a JSDoc comment to `MemoryProvenance.createdBy` specifying it MUST use the Doc 01 `forge://org/agent-name` format and can be resolved via `parseForgeUri()`.

---

### Suggestions (nice to have)

#### S13: Doc 04 Blackboard could emit events on `DzipEventBus`, not just local listeners

The `InMemoryBlackboard` (Doc 04 line 1538) uses a private `listeners` array for change notification. If it also emitted `DzipEventBus` events (with `blackboard:entry_written` etc.), the OTel bridge (Doc 06) could automatically trace blackboard activity. The `BlackboardRunner` (line 1693) already receives an optional `DzipEventBus` -- it should pass it to the blackboard instance.

---

#### S14: Doc 05 `SharedMemoryEvent` types should be registered in `DzipEvent` union

Doc 05 defines `SharedMemoryEvent` (line 231) with 7 event types (`memory:space:created`, `memory:space:joined`, `memory:space:write`, etc.) but does not mention adding them to the `DzipEvent` discriminated union in `@dzipagent/core`. Without this registration, the `OTelBridge` (Doc 06) and `EventLogSink` cannot capture memory sharing events.

**Fix:** Add the 7 `SharedMemoryEvent` types to the event registration list in the 00-INDEX.md event catalog (if S4 from the 01-03 review is implemented).

---

#### S15: Doc 06 cost attribution (F6) could leverage Doc 05 provenance lineage

Doc 06 F6 attributes costs to agents and phases. Doc 05's provenance lineage tracks which agents touched a record. Combining these would enable "cost of producing this knowledge" queries -- e.g., "how much did it cost across all agents to arrive at this architectural decision?" This integration is not mentioned in either doc.

---

## Cross-Document Issues (10-12)

**Reviewer:** Principal Software Architect
**Date:** 2026-03-24
**Documents reviewed:** 10-PIPELINES-WORKFLOWS.md, 11-DEVELOPER-EXPERIENCE.md, 12-SECURITY-GOVERNANCE.md
**Cross-referenced with:** 00-INDEX.md, 04-ORCHESTRATION-PATTERNS.md, 06-OBSERVABILITY-TRACING.md, 09-FORMATS-STANDARDS.md

---

### Critical (must fix)

#### C5: Duplicate and conflicting PipelineDefinition types (Doc 09 vs Doc 10)

Doc 09 (Formats & Standards, F5) defines `PipelineDefinition` in `@dzipagent/codegen/src/pipeline/pipeline-definition-types.ts`. Doc 10 (Pipelines & Workflows, F1) defines a completely different `PipelineDefinition` in `@dzipagent/core/src/pipeline/pipeline-definition.ts`. These are two incompatible interfaces with the same name:

- Doc 09 places it in `@dzipagent/codegen`. Doc 10 places it in `@dzipagent/core`.
- Doc 09 uses `PipelineNodeDefinition` with a discriminated union via `PipelineNodeConfig` and a `nodeType` field on each config variant. Doc 10 uses `PipelineNode` as a discriminated union with a `type` field directly on each node variant (e.g., `AgentNode`, `ToolNode`).
- Doc 09 includes `input` and `output` node types. Doc 10 does not -- it uses `entryNodeId` instead.
- Doc 09 edges use `from`/`to` fields. Doc 10 edges use `sourceNodeId`/`targetNodeId`.
- Doc 09 edges use a `condition` object with `type: 'field_equals'`. Doc 10 uses `ConditionalEdge` with `predicateName` and `branches` map.
- Doc 09 has `inputSchema`/`outputSchema` at the pipeline level. Doc 10 has `budgetLimitCents`/`tokenLimit`/`checkpointStrategy` instead.
- Doc 09 validation function is `validatePipelineDefinition()` in `@dzipagent/codegen`. Doc 10 validation is `validatePipeline()` in `@dzipagent/agent`.

**Resolution required:** One canonical `PipelineDefinition` must be chosen. Doc 10's version is more comprehensive (richer type-safe discriminated unions per node type, checkpoint strategy, budget limits, suspend/resume semantics). Recommendation: adopt Doc 10's types in `@dzipagent/core` as the canonical format. Doc 09 F5 should be rewritten to reference Doc 10's types and focus only on the serialization/import/export adapters for `GenPipelineBuilder`, not redefine the types. Package ownership must be `@dzipagent/core` (types only) per Doc 10's dependency rules. This supersedes the earlier C1 finding from the 07-09 review which identified the same package placement conflict but did not yet have Doc 10's full type definitions for comparison.

#### C6: Duplicate workflow persistence systems (Doc 04 F5 vs Doc 10 F3)

Doc 04 defines `WorkflowCheckpoint` and `WorkflowStore` for `CompiledWorkflow` persistence. Doc 10 defines `PipelineCheckpoint` and `PipelineCheckpointStore` for `PipelineRuntime` persistence. These are two separate checkpoint systems for what Doc 10 explicitly intends to unify:

- Doc 04 `WorkflowCheckpoint` tracks by `nodeIndex` (linear position in a flat list). Doc 10 `PipelineCheckpoint` tracks by `completedNodeIds` set (DAG-aware, supports parallel and loop nodes).
- Doc 04 `WorkflowStore` has `save/load/list/delete` (4 methods). Doc 10 `PipelineCheckpointStore` has `save/load/loadVersion/listVersions/delete/prune` (6 methods, with version history and garbage collection).
- Doc 04's `InMemoryWorkflowStore` is in `@dzipagent/agent`. Doc 10's `InMemoryPipelineCheckpointStore` is also in `@dzipagent/agent`.
- Doc 04 checkpoint stores a single version per runId (overwrite). Doc 10 stores all versions with auto-incrementing version numbers.

**Resolution required:** Since Doc 10's stated goal (Section 1.2) is "one execution engine" that replaces both `CompiledWorkflow.run()` and `PipelineExecutor.execute()`, Doc 04 F5 should be marked as superseded by Doc 10 F3. The `PipelineCheckpointStore` becomes the single persistence interface. Doc 04 should note that `WorkflowBuilder.build()` compiles to `PipelineDefinition` and uses `PipelineRuntime` for execution, making a separate `WorkflowStore` unnecessary.

#### C7: Duplicate and conflicting safety monitoring (Doc 06 F9 vs Doc 12 F2)

Doc 06 defines `SafetyMonitor` in `@dzipagent/otel` with `SafetyEvent`, `SafetyCategory`, and methods `scanInput/scanOutput/scanMemoryWrite/trackToolInvocation`. Doc 12 defines `SafetyMonitor` in `@dzipagent/core` with `SafetyViolation`, `SafetyCategory`, and methods `scanContent/getViolations/dispose`.

Key conflicts:
- **Package placement:** Doc 06 puts it in `@dzipagent/otel`. Doc 12 puts it in `@dzipagent/core`. These are fundamentally different dependency decisions. Placing in core means safety monitoring is available without the optional OTel plugin. Placing in otel means it requires OTel.
- **Behavioral semantics:** Doc 06 F9 explicitly states "the safety monitor does NOT block operations." Doc 12 F2 includes `SafetyAction` values of `'block' | 'kill'` and states the monitor can emit block/kill events that "the agent tool-loop must honor." These are contradictory design philosophies.
- **Type names:** Doc 06 uses `SafetyEvent`. Doc 12 uses `SafetyViolation`. Different shapes entirely -- `SafetyEvent` has `confidence: number` and `threats: string[]`; `SafetyViolation` has `evidence: { type, content, metadata }` and `action: SafetyAction`.
- **Severity levels:** Doc 06 has 3 levels (`info | warning | critical`). Doc 12 has 4 levels (`info | warning | critical | emergency`).
- **Categories:** Doc 06 has 6 categories (split injection into input/output). Doc 12 has 10 categories (adds `harmful_content`, `off_topic`, `rate_limit_exceeded`, merges injection into one).
- **Factory signature:** Doc 06 `createSafetyMonitor(config?)` returns `SafetyMonitor` (no event bus param). Doc 12 `createSafetyMonitor(eventBus, config?)` takes event bus as first argument.

**Resolution required:** Choose one canonical design. Recommendation: interfaces in `@dzipagent/core` using Doc 12's richer model (with blocking capability and 4 severity levels). Implementation as a `DzipPlugin` in `@dzipagent/otel` per Doc 06's plugin pattern. Doc 06 F9 should be rewritten to reference the core interfaces and provide only the OTel-integrated implementation (adding OTel span attributes to safety events).

#### C8: Duplicate and conflicting audit trail (Doc 06 F10 vs Doc 12 F3)

Doc 06 defines `AuditEntry`, `AuditStore`, and `AuditTrail` in `@dzipagent/otel`. Doc 12 defines `AuditEntry`, `AuditStore`, and `AuditLogger` in `@dzipagent/core` with Postgres impl in `@dzipagent/server`.

Key conflicts:
- **Package placement:** Doc 06 puts all in `@dzipagent/otel`. Doc 12 puts interfaces in `@dzipagent/core`, `PostgresAuditStore` in `@dzipagent/server`.
- **AuditEntry shape:** Doc 06 uses `seq: number` for ordering, `agentId`/`runId` as flat top-level fields, and `success: boolean` for result. Doc 12 uses `id: string` (UUID v7) for ordering, `actor: { id, type, name }` object (supports user/agent/service/system actors), and `result: 'success' | 'denied' | 'failed' | 'blocked'` as a discriminated string.
- **AuditStore API surface:** Doc 06 has purpose-specific getters (`getByRun`, `getByAgent`, `getByCategory`, `getAll`). Doc 12 has a general-purpose `search(filter: AuditFilter)` plus `count(filter)`. Doc 12 also adds `applyRetention(policies)` with regulation-aware retention policies (GDPR, SOX, HIPAA, SOC2).
- **Hash computation:** Both use SHA-256 hash chains but the serialization payload differs.
- **Orchestrator naming:** Doc 06 calls it `AuditTrail` (with `attach(eventBus)`). Doc 12 calls it `AuditLogger` (with `record()` and `dispose()`).
- **Schema:** Only Doc 12 provides a Drizzle table definition (`forge_audit_entries`) and server REST routes (`GET /api/audit`, `GET /api/audit/:id`, etc.).

**Resolution required:** Doc 12's version is strictly more capable (multi-actor types, regulation-aware retention, richer result states, Drizzle schema, REST routes). Recommendation: adopt Doc 12 interfaces in `@dzipagent/core`. Doc 06 F10 should be reduced to "the OTel plugin correlates audit entries with OTel trace/span IDs and exports audit metrics." Remove the full `AuditEntry`/`AuditStore`/`AuditTrail` type definitions from Doc 06.

---

### Warnings (should fix)

#### W9: Effort double-counting for Safety Monitoring and Audit Trail

Both Doc 06 and Doc 12 estimate 8h each for Safety Monitoring (16h total for what should be one feature) and 8h each for Compliance Audit Trail (16h total for one feature). If the duplicates are consolidated per C7 and C8, the total plan effort should be reduced by approximately 16h.

#### W10: Doc 09 F5 effort overlaps with Doc 10 F1

Doc 09 estimates 8h for "Pipeline Definition Format" (F5). Doc 10 estimates 8h for "Pipeline Definition Protocol" (F1). These are the same deliverable -- a JSON-serializable pipeline format with types, validation, and import/export. If consolidated per C5, approximately 5-6h of effort should be removed. Doc 09 F5 can be reduced to the adapter functions only (~2-3h).

#### W11: Doc 11 CLI commands reference features from Doc 10 without explicit dependency

Doc 11 (Developer Experience) lists `forgeagent docs:generate` which generates "Pipeline flow diagrams (Mermaid)" from `WorkflowBuilder` definitions. Doc 11's header dependency list references `04-Orchestration (workflow engine)` but not `10-Pipelines-Workflows`. After Doc 10 supersedes Doc 04 for pipeline/workflow execution, this dependency reference becomes stale. Update Doc 11's dependency line to include `10-Pipelines-Workflows`.

#### W12: Doc 12 F1 PolicyTranslator interface lives in core but requires LLM

The `PolicyTranslator` interface in Doc 12 is specified at `@dzipagent/core/src/security/policy/policy-translator.ts`. It requires an LLM call (`modelRegistry`). While the doc correctly notes this is an "AUTHORING tool only -- never in the enforcement path," core should not contain implementations that invoke LLMs (core provides types and pure functions only). The interface definition can stay in core, but the implementation class must live in `@dzipagent/agent` or `@dzipagent/server`. Doc 12 should add an explicit note about this split.

#### W13: DzipEvent type name collisions across docs 06, 10, and 12

Multiple documents introduce new `DzipEvent` types with overlapping semantics:
- Doc 06 F9: `safety:threat_detected`, `safety:memory_poisoning`
- Doc 12 F2: `safety:violation`, `safety:blocked`, `safety:kill_requested`
- Doc 12 F4: `memory:threat_detected`, `memory:quarantined`

The `safety:threat_detected` (doc 06) vs `safety:violation` (doc 12) represent the same semantic event with different names and payloads. Similarly, `safety:memory_poisoning` (doc 06) overlaps with `memory:threat_detected` (doc 12). A single unified event taxonomy must be established before implementation begins.

Additionally, Doc 10 defines 12 new `PipelineRuntimeEvent` types in `@dzipagent/agent` that must be registered in the `DzipEvent` union in `@dzipagent/core`. This cross-package type registration is noted in Doc 10 but could be missed during implementation.

#### W14: Doc 12 F9 DataClassification references an undefined import path

In Doc 12 F6 (Cross-Agent Security), the `DataLabel` interface has `level: import('../../core-types.js').ClassificationLevel`. This references a `ClassificationLevel` type that is specified in Doc 12 F9 (Data Classification) but the import path `../../core-types.js` does not correspond to any existing file in the codebase. The type needs to be defined in a concrete location (likely `@dzipagent/core/src/security/classification-types.ts`) before F6 can reference it.

---

### Suggestions (nice to have)

#### S8: Doc 10 should reference Doc 09's format adapter pattern

Doc 09 establishes a clean adapter pattern for format conversions (pure functions, no state, bidirectional). Doc 10's `GenPipelineBuilder.toPipelineDefinition()` and `WorkflowBuilder.toPipelineDefinition()` follow this pattern implicitly but do not reference it. Cross-referencing would improve consistency and make the convention explicit.

#### S9: Doc 11 playground trace viewer should consume Doc 10 pipeline events

Doc 11's playground `TraceTab` visualizes agent events via the WebSocket `EventBridge`. With Doc 10's pipeline events (`pipeline:node_started`, `pipeline:loop_iteration`, `pipeline:checkpoint_saved`, etc.), the trace viewer could show pipeline-level execution flow with loop iterations and checkpoints. This integration is not mentioned in Doc 11 and would be a valuable enhancement.

#### S10: Doc 12 should reference Doc 10 GateNode for approval gates

Doc 10's `GateNode` with `gateType: 'approval'` implements the same human-in-the-loop concept as the approval gates discussed in Doc 12's security layers. Cross-referencing would clarify that pipeline approval gates and security approval gates share the same mechanism and event flow.

#### S11: Doc 11 `forgeagent test:scaffold` should generate pipeline tests

Doc 11 F6 (Integration Test Scaffolding) generates tests for agents but not for pipelines. With Doc 10's `PipelineDefinition` format, the scaffolder could also generate pipeline integration tests that validate node execution order, checkpoint/resume behavior, and loop termination.

#### S12: Consider a shared `@dzipagent/security` package

Doc 12 places a significant volume of code in `@dzipagent/core`: PolicyEvaluator, SafetyMonitor, AuditStore, MemoryDefense, OutputFilter enhancements, and DataClassification types. This is 6 major subsystems with substantial combined LOC. If these grow, they risk bloating core beyond its intended scope. A dedicated `@dzipagent/security` package (depending only on `@dzipagent/core` for types) could provide better separation of concerns. This is not urgent for initial implementation but should be reconsidered if security code exceeds ~1500 LOC in core.

---

## Global Summary

### Total Effort Estimate (all docs)

| Doc | Title | Effort (hours) |
|-----|-------|----------------|
| 01 | Identity & Trust | 76 |
| 02 | Communication Protocols | 72 |
| 03 | Discovery & Registry | 58 |
| 04 | Orchestration Patterns | 82 |
| 05 | Memory Sharing | 70 |
| 06 | Observability & Tracing | 74 |
| 07 | Runtime & Deployment | 78 |
| 08 | Evaluation & Testing | 68 |
| 09 | Formats & Standards | 38 |
| 10 | Pipelines & Workflows | 82 |
| 11 | Developer Experience | 88 |
| 12 | Security & Governance | 76 |
| **Raw Total** | | **862h** |
| Dedup: Safety Monitor (06 F9 = 12 F2) | | -8 |
| Dedup: Audit Trail (06 F10 = 12 F3) | | -8 |
| Dedup: Pipeline Def (09 F5 partially = 10 F1) | | -5 |
| Dedup: Workflow Persistence (04 F5 partially = 10 F3) | | -4 |
| **Adjusted Total** | | **~837h** |

At 6 productive hours per day, this is approximately **140 working days** or **28 engineer-weeks**. With a 3-engineer team, this is a **9-10 week** effort, which aligns with the 10-week phased roadmap described in `00-INDEX.md` (Phases 1-5, Weeks 1-10).

### Duplicate Feature Detection (across all 12 docs)

| Feature | Defined In | Severity | Resolution |
|---------|-----------|----------|------------|
| PipelineDefinition types | Doc 09 F5, Doc 10 F1 | Critical | Consolidate to Doc 10 in `@dzipagent/core` |
| Pipeline validation | Doc 09 F5 (`@dzipagent/codegen`), Doc 10 F1 (`@dzipagent/agent`) | Critical | Consolidate to Doc 10 in `@dzipagent/agent` |
| Workflow checkpoint/persistence | Doc 04 F5, Doc 10 F3 | Critical | Supersede Doc 04 F5 with Doc 10 F3 |
| Safety monitoring | Doc 06 F9, Doc 12 F2 | Critical | Interfaces in core (Doc 12), impl in otel plugin (Doc 06) |
| Compliance audit trail | Doc 06 F10, Doc 12 F3 | Critical | Interfaces in core (Doc 12), OTel correlation in otel (Doc 06) |
| Approval gates in pipelines | Doc 04 (ApprovalGate), Doc 10 (GateNode `approval`) | Warning | Doc 10 GateNode unifies the concept |
| Agent Card capability type | Doc 01 (ForgeCapability), Doc 09 (AgentCardCapability) | Warning | Adapter function or shared base type |
| JsonSchema type | Doc 08 (JSONSchemaDefinition), Doc 09 (JsonSchema) | Warning | Unify in `@dzipagent/core` |
| Evaluation framework scope | Doc 06 F5, Doc 08 (full package) | Warning | Doc 06 F5 limited to metric export only |
| ForgeUri type | Doc 01 (validated), Doc 05 (loose template literal) | Critical | Use Doc 01's definition everywhere (see C9) |
| Shared state (Blackboard vs SharedMemorySpace) | Doc 04 F4, Doc 05 F1 | Warning | Document Blackboard as ephemeral, SharedMemorySpace as durable (see W15) |

### Interface Consistency Score

Scoring methodology: For each cross-document interface pair, check (a) same package placement, (b) same type name, (c) compatible type shape, (d) same behavioral semantics. Each criterion scores 0 or 1 (PARTIAL = 0.5).

| Interface Pair | Package | Name | Shape | Semantics | Score |
|---------------|---------|------|-------|-----------|-------|
| PipelineDefinition (09 vs 10) | FAIL | MATCH | FAIL | PARTIAL | 1.5/4 |
| WorkflowCheckpoint vs PipelineCheckpoint (04 vs 10) | MATCH | FAIL | FAIL | PARTIAL | 1.5/4 |
| SafetyMonitor (06 vs 12) | FAIL | MATCH | FAIL | FAIL | 1/4 |
| AuditEntry (06 vs 12) | FAIL | MATCH | FAIL | PARTIAL | 1.5/4 |
| AuditStore (06 vs 12) | FAIL | MATCH | FAIL | PARTIAL | 1.5/4 |
| DzipEvent taxonomy (06 vs 12) | MATCH | FAIL | FAIL | PARTIAL | 1.5/4 |
| ForgeUri (01 vs 05) | FAIL | MATCH | FAIL | PARTIAL | 1.5/4 |
| Blackboard vs SharedMemorySpace (04 vs 05) | FAIL | FAIL | FAIL | PARTIAL | 0.5/4 |
| **Average** | | | | | **1.3/4 (33%)** |

**Overall consistency score: 33% -- Poor.**

The cross-cutting features (safety, audit, pipeline, shared state, URI) have been designed independently in their respective domain documents without a reconciliation pass. Before implementation begins, a consolidation effort is required for the 6 critical items (C5-C10). Without this, implementing agents working from different documents will produce conflicting type definitions that cannot coexist in a single TypeScript strict-mode codebase.

### Recommended Consolidation Order

1. **ForgeUri** (C9, C10) -- Standardize on Doc 01's two-segment format. Update Doc 05 to import from core identity. All downstream types (provenance, shared spaces, blackboard) depend on this. Estimated effort: 1h to update Doc 05.
2. **PipelineDefinition** (C5) -- Rewrite Doc 09 F5 to reference Doc 10 F1 types. Mark Doc 04 F5 as superseded by Doc 10 F3. Estimated effort: 2h to update both documents.
3. **AuditEntry / AuditStore** (C8) -- Adopt Doc 12 F3 interfaces as canonical. Rewrite Doc 06 F10 to add only OTel trace correlation. Estimated effort: 1h to update Doc 06.
4. **SafetyMonitor** (C7) -- Adopt Doc 12 F2 interfaces in `@dzipagent/core` as canonical. Rewrite Doc 06 F9 to be the OTel plugin implementation of those interfaces. Estimated effort: 2h to update Doc 06.
5. **DzipEvent taxonomy** (W13, W17) -- Create a single addendum or section in `00-INDEX.md` listing all new event types across docs 04, 05, 06, 10, and 12 with deduplicated names and canonical payloads. Estimated effort: 2h.
6. **Blackboard vs SharedMemorySpace** (W15) -- Add clarifying prose to Doc 04 F4. No type changes needed. Estimated effort: 0.5h.
