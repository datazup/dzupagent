# DzipAgent Ecosystem -- Implementation Tickets

> **Created:** 2026-03-24
> **Source:** ecosystem_plan docs 01-06
> **Scope:** Phases 1-3 (Weeks 1-6)
> **Total Tickets:** 62
> **Total Estimated Effort:** ~310h

---

## Summary

| Phase | Tickets | Total Effort | Key Deliverables |
|-------|---------|-------------|------------------|
| **Phase 1: Foundation Abstractions** (Weeks 1-2) | ECO-001 -- ECO-023 | ~114h | ForgeIdentity types, URI scheme, API-key resolver, ForgeMessage envelope, ProtocolAdapter, InternalAdapter, A2A client, AgentRegistry interface, capability taxonomy, InMemoryRegistry, supervisor fix, OTel integration, distributed tracing, Prometheus export, structured logging, memory provenance |
| **Phase 2: Communication & Observability** (Weeks 3-4) | ECO-024 -- ECO-042 | ~108h | MCP Resources, MCP Sampling, protocol bridge, message serialization, delegation tokens, capability auth, agent card signing, cascading timeouts, cost attribution, safety monitoring, audit trail, causal graph, convention memory, memory encryption |
| **Phase 3: Memory Sharing & Discovery** (Weeks 5-6) | ECO-043 -- ECO-062 | ~88h | Shared memory spaces, Agent File export/import, PostgresRegistry, semantic capability search, health monitoring, contract-net protocol, dynamic topology, CRDT conflict resolution, multi-modal memory, trust scoring |

---

## Phase 1: Foundation Abstractions (Weeks 1-2)

### ECO-001: ForgeIdentity Type System
- **Source:** Doc 01, Feature F1
- **Phase:** 1
- **Priority:** P0
- **Package:** @dzipagent/core
- **Effort:** 4h
- **Dependencies:** None
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-core/src/identity/identity-types.ts` -- ForgeIdentity, ForgeCredential, ForgeCapability, ForgeIdentityRef, CredentialType, toIdentityRef
  - `packages/forgeagent-core/src/identity/identity-schemas.ts` -- Zod schemas for all identity types
  - `packages/forgeagent-core/src/identity/index.ts` -- Barrel exports
  - `packages/forgeagent-core/src/index.ts` -- Re-export identity module
  - `packages/forgeagent-core/src/events/event-types.ts` -- Add identity:* event variants
  - `packages/forgeagent-core/src/errors/error-codes.ts` -- Add IDENTITY_* and DELEGATION_* error codes
- **Acceptance Criteria:**
  - [ ] ForgeIdentity, ForgeCredential, ForgeCapability interfaces exported from @dzipagent/core
  - [ ] Zod schemas validate all identity types correctly
  - [ ] ForgeIdentityRef lightweight reference type exported
  - [ ] toIdentityRef() extracts id, uri, displayName from full identity
  - [ ] Identity events added to DzipEvent discriminated union
  - [ ] Identity error codes added to ForgeErrorCode union
  - [ ] Tests: schema validation (valid/invalid), toIdentityRef round-trip
  - [ ] Zero TS errors

---

### ECO-002: Agent URI Scheme (forge://)
- **Source:** Doc 01, Feature F2
- **Phase:** 1
- **Priority:** P0
- **Package:** @dzipagent/core
- **Effort:** 2h
- **Dependencies:** None
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-core/src/identity/forge-uri.ts` -- parseForgeUri, buildForgeUri, isForgeUri, toAgentUri, fromAgentUri, UriResolver, createUriResolver
- **Acceptance Criteria:**
  - [ ] parseForgeUri extracts organization, agentName, version from forge://org/name@version
  - [ ] buildForgeUri round-trips with parseForgeUri
  - [ ] isForgeUri returns boolean without throwing
  - [ ] toAgentUri/fromAgentUri convert between forge:// and agent:// schemes
  - [ ] createUriResolver supports static, convention, and registry strategies
  - [ ] ForgeUriSchema Zod regex validates correctly
  - [ ] Tests: valid URIs, missing version, invalid chars, round-trip, agent:// conversion
  - [ ] Zero TS errors

---

### ECO-003: API-Key Identity Resolver
- **Source:** Doc 01, Feature F3
- **Phase:** 1
- **Priority:** P0
- **Package:** @dzipagent/core
- **Effort:** 4h
- **Dependencies:** ECO-001, ECO-002
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-core/src/identity/identity-resolver.ts` -- IdentityResolver, CompositeIdentityResolver, IdentityResolutionContext interfaces
  - `packages/forgeagent-core/src/identity/api-key-resolver.ts` -- APIKeyRecord, APIKeyResolverConfig, createAPIKeyResolver with LRU cache
- **Acceptance Criteria:**
  - [ ] IdentityResolver interface: resolve() and verify() methods
  - [ ] CompositeIdentityResolver tries resolvers in order, first non-null wins
  - [ ] createAPIKeyResolver maps APIKeyRecord to ForgeIdentity
  - [ ] LRU cache with configurable TTL and max entries (keyed by SHA-256 hash of key)
  - [ ] Cache invalidation via invalidate(keyHash) method
  - [ ] Tests: successful resolution, invalid key returns null, expired key, cache hit/miss, LRU eviction
  - [ ] Zero TS errors

---

### ECO-004: Identity Middleware for Hono
- **Source:** Doc 01, Feature F3 (server integration)
- **Phase:** 1
- **Priority:** P0
- **Package:** @dzipagent/server
- **Effort:** 3h
- **Dependencies:** ECO-003
- **Agent:** forgeagent-server-dev
- **Files to create/modify:**
  - `packages/forgeagent-server/src/middleware/identity.ts` -- identityMiddleware(), getForgeIdentity()
- **Acceptance Criteria:**
  - [ ] identityMiddleware() is a Hono MiddlewareHandler
  - [ ] Reads token from Hono context (set by authMiddleware), passes to resolver chain
  - [ ] Sets forgeIdentity and forgeCapabilities in Hono context
  - [ ] required:false (default) allows requests without identity to pass through
  - [ ] required:true rejects with 401 if no resolver returns an identity
  - [ ] getForgeIdentity() helper extracts identity from context
  - [ ] Tests: resolution success, failure with required:true/false, resolver chain ordering
  - [ ] Zero TS errors

---

### ECO-005: ForgeMessage Envelope Types
- **Source:** Doc 02, Feature F1
- **Phase:** 1
- **Priority:** P0
- **Package:** @dzipagent/core
- **Effort:** 4h
- **Dependencies:** ECO-001
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-core/src/protocol/message.ts` -- ForgeMessage, ForgeMessageId, ForgeMessageType, ForgeProtocol, ForgePayload (7 variants), ForgeMessageMetadata, Zod schemas, factory helpers
  - `packages/forgeagent-core/src/protocol/index.ts` -- Barrel exports
  - `packages/forgeagent-core/src/index.ts` -- Re-export protocol module
- **Acceptance Criteria:**
  - [ ] ForgeMessage interface with id, type, from, to, protocol, timestamp, correlationId, parentId, payload, metadata
  - [ ] ForgePayload discriminated union: text, json, tool_call, tool_result, task, binary, error
  - [ ] ForgeMessageMetadata includes traceId, spanId, priority, ttlMs, delegationToken, budget
  - [ ] createMessageId() generates UUIDv7
  - [ ] createForgeMessage(), createResponse(), createErrorResponse() factory helpers
  - [ ] isMessageAlive() checks TTL expiration
  - [ ] Zod validation: forgeMessageSchema with .strict()
  - [ ] validateForgeMessage() returns discriminated result (never throws)
  - [ ] Tests: create/validate round-trip, each payload variant, TTL check, expired message detection
  - [ ] Zero TS errors

---

### ECO-006: ProtocolAdapter Interface
- **Source:** Doc 02, Feature F2
- **Phase:** 1
- **Priority:** P0
- **Package:** @dzipagent/core
- **Effort:** 3h
- **Dependencies:** ECO-005
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-core/src/protocol/adapter.ts` -- ProtocolAdapter interface, AdapterState, AdapterHealthStatus, SendOptions, MessageHandler, Subscription
- **Acceptance Criteria:**
  - [ ] ProtocolAdapter: connect(), disconnect(), send(), stream(), subscribe(), health() methods
  - [ ] AdapterState lifecycle: disconnected -> connecting -> connected -> draining -> disconnected
  - [ ] send() returns ForgeMessage response
  - [ ] stream() returns AsyncIterable<ForgeMessage>
  - [ ] subscribe() returns Subscription with unsubscribe()
  - [ ] health() returns AdapterHealthStatus
  - [ ] Tests: interface contract verification via mock adapter
  - [ ] Zero TS errors

---

### ECO-007: InternalAdapter Implementation
- **Source:** Doc 02, Feature F3
- **Phase:** 1
- **Priority:** P0
- **Package:** @dzipagent/core
- **Effort:** 3h
- **Dependencies:** ECO-006
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-core/src/protocol/internal-adapter.ts` -- InternalAdapter class implementing ProtocolAdapter, wraps DzipEventBus/AgentBus
- **Acceptance Criteria:**
  - [ ] InternalAdapter wraps DzipEventBus for in-process message routing
  - [ ] send() dispatches message to target agent via AgentBus, returns response
  - [ ] stream() emits ForgeMessage stream_chunk events
  - [ ] subscribe() registers handler on AgentBus channel
  - [ ] connect()/disconnect() are no-ops (always connected for in-process)
  - [ ] Tests: send/receive round-trip, subscription delivery, stream chunks
  - [ ] Zero TS errors

---

### ECO-008: ProtocolRouter
- **Source:** Doc 02, Feature F2 (routing layer)
- **Phase:** 1
- **Priority:** P0
- **Package:** @dzipagent/core
- **Effort:** 3h
- **Dependencies:** ECO-006, ECO-007
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-core/src/protocol/protocol-router.ts` -- ProtocolRouter class that routes messages to the correct adapter based on URI scheme
- **Acceptance Criteria:**
  - [ ] registerAdapter() maps protocol names to adapter instances
  - [ ] route() selects adapter based on message.to URI scheme
  - [ ] forge://local/* routes to InternalAdapter
  - [ ] a2a://* routes to A2AClientAdapter
  - [ ] mcp://* routes to MCPClientAdapter
  - [ ] Throws ForgeError if no adapter matches
  - [ ] Tests: routing by scheme, missing adapter error, multiple adapters
  - [ ] Zero TS errors

---

### ECO-009: A2A Client Adapter
- **Source:** Doc 02, Feature F4
- **Phase:** 1
- **Priority:** P0
- **Package:** @dzipagent/core
- **Effort:** 6h
- **Dependencies:** ECO-005, ECO-006
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-core/src/protocol/a2a-client-adapter.ts` -- A2AClientAdapter implementing ProtocolAdapter, translates ForgeMessage to/from A2A JSON-RPC
- **Acceptance Criteria:**
  - [ ] A2AClientAdapter sends tasks via HTTP POST to A2A endpoints
  - [ ] Translates ForgeMessage to A2A task submit format
  - [ ] Translates A2A task results back to ForgeMessage responses
  - [ ] stream() uses SSE for real-time A2A task updates
  - [ ] Retry with exponential backoff on transient failures
  - [ ] connect() validates agent card endpoint reachability
  - [ ] Tests: task submit/poll, SSE streaming, retry on 500, timeout handling
  - [ ] Zero TS errors

---

### ECO-010: A2A Client Adapter -- SSE Streaming
- **Source:** Doc 02, Feature F4 (streaming component)
- **Phase:** 1
- **Priority:** P0
- **Package:** @dzipagent/core
- **Effort:** 4h
- **Dependencies:** ECO-009
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-core/src/protocol/a2a-sse-stream.ts` -- SSE client for A2A task streaming, emits ForgeMessage stream_chunk events
- **Acceptance Criteria:**
  - [ ] Connects to A2A SSE endpoint for a given task
  - [ ] Parses SSE events and converts to ForgeMessage stream_chunk/stream_end
  - [ ] Handles reconnection on connection drop
  - [ ] AbortSignal support for cancellation
  - [ ] Tests: SSE event parsing, reconnection, abort
  - [ ] Zero TS errors

---

### ECO-011: AgentRegistry Interface
- **Source:** Doc 03, Feature F1
- **Phase:** 1
- **Priority:** P0
- **Package:** @dzipagent/core
- **Effort:** 4h
- **Dependencies:** ECO-001
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-core/src/registry/types.ts` -- RegisteredAgent, CapabilityDescriptor, DiscoveryQuery, DiscoveryResult, DiscoveryResultPage, AgentHealth, AgentSLA, RegistryEvent, AgentRegistry interface
  - `packages/forgeagent-core/src/registry/index.ts` -- Barrel exports
  - `packages/forgeagent-core/src/index.ts` -- Re-export registry module
  - `packages/forgeagent-core/src/errors/error-codes.ts` -- Add REGISTRY_* error codes
  - `packages/forgeagent-core/src/events/event-types.ts` -- Add registry:* event variants
- **Acceptance Criteria:**
  - [ ] AgentRegistry interface: register, deregister, update, discover, getAgent, getHealth, updateHealth, subscribe, listAgents, registerFromCard, evictExpired, stats
  - [ ] RegisteredAgent includes health snapshot, SLA, protocol list, capabilities
  - [ ] DiscoveryQuery supports capability prefix, semantic query, tags, health filter, SLA filter, pagination
  - [ ] DiscoveryResult includes matchScore and scoreBreakdown
  - [ ] Registry events added to DzipEvent union
  - [ ] Tests: type validation via Zod schemas
  - [ ] Zero TS errors

---

### ECO-012: Capability Taxonomy
- **Source:** Doc 03, Feature F2
- **Phase:** 1
- **Priority:** P0
- **Package:** @dzipagent/core
- **Effort:** 4h
- **Dependencies:** ECO-011
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-core/src/registry/capability-taxonomy.ts` -- STANDARD_CAPABILITIES tree, isStandardCapability(), getCapabilityDescription()
  - `packages/forgeagent-core/src/registry/capability-matcher.ts` -- CapabilityMatcher class with prefix matching, wildcard matching, hierarchy-aware scoring
- **Acceptance Criteria:**
  - [ ] STANDARD_CAPABILITIES covers code.*, data.*, memory.*, planning.*, communication.* domains
  - [ ] isStandardCapability() validates against the tree
  - [ ] CapabilityMatcher.match(query, candidate) returns score 0-1
  - [ ] Prefix matching: "code.review" matches "code.review.security"
  - [ ] Wildcard: "code.*" matches any code.* capability
  - [ ] Tests: prefix match, exact match, wildcard, non-standard capability, hierarchy depth
  - [ ] Zero TS errors

---

### ECO-013: InMemoryRegistry Implementation
- **Source:** Doc 03, Feature F3
- **Phase:** 1
- **Priority:** P0
- **Package:** @dzipagent/core
- **Effort:** 4h
- **Dependencies:** ECO-011, ECO-012
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-core/src/registry/in-memory-registry.ts` -- InMemoryRegistry implementing AgentRegistry using Map storage
- **Acceptance Criteria:**
  - [ ] InMemoryRegistry stores RegisteredAgent in a Map
  - [ ] register() validates input and emits registry:agent_registered event
  - [ ] discover() supports capability prefix, tag, and health filtering
  - [ ] Score breakdown includes capabilityScore, tagScore, healthAdjustment
  - [ ] evictExpired() removes agents past TTL
  - [ ] subscribe() filters events by agentIds, eventTypes, capabilities
  - [ ] registerFromCard() fetches and validates remote agent card
  - [ ] Tests: register/discover round-trip, TTL eviction, event emission, deregister, update, pagination
  - [ ] Zero TS errors

---

### ECO-014: Fix Supervisor Tool Wiring
- **Source:** Doc 04, Feature F1
- **Phase:** 1
- **Priority:** P0
- **Package:** @dzipagent/agent
- **Effort:** 2h
- **Dependencies:** None
- **Agent:** forgeagent-agent-dev
- **Files to create/modify:**
  - `packages/forgeagent-agent/src/orchestration/orchestrator.ts` -- Replace broken supervisor method with working implementation
  - `packages/forgeagent-agent/src/agent/dzip-agent.ts` -- Add public agentConfig getter
- **Acceptance Criteria:**
  - [ ] supervisor() wraps specialists via asTool() and injects into fresh manager instance
  - [ ] Manager's LLM can invoke specialist tools via function calling
  - [ ] Specialist results flow back through ToolMessage
  - [ ] Optional healthCheck filters unresponsive specialists
  - [ ] OrchestrationError class with pattern/context fields
  - [ ] Existing sequential/parallel/debate patterns unchanged
  - [ ] Tests: supervisor delegates to specialist, specialist results returned, health check filters
  - [ ] Zero TS errors

---

### ECO-015: OpenTelemetry DzipTracer
- **Source:** Doc 06, Feature F1
- **Phase:** 1
- **Priority:** P0
- **Package:** @dzipagent/otel (new)
- **Effort:** 6h
- **Dependencies:** None (new package, depends on @dzipagent/core types)
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-otel/package.json` -- New package setup with OTel peer deps
  - `packages/forgeagent-otel/tsconfig.json` -- TypeScript config
  - `packages/forgeagent-otel/src/tracer.ts` -- DzipTracer class with startAgentSpan, startLLMSpan, startToolSpan, startMemorySpan, startPhaseSpan
  - `packages/forgeagent-otel/src/span-attributes.ts` -- ForgeSpanAttr constants
  - `packages/forgeagent-otel/src/index.ts` -- Barrel exports
- **Acceptance Criteria:**
  - [ ] DzipTracer wraps OTel SDK tracer with DzipAgent-specific helpers
  - [ ] ForgeSpanAttr constants follow OTel GenAI semantic conventions
  - [ ] startAgentSpan sets forge.agent.id, forge.agent.name, forge.run.id
  - [ ] startLLMSpan sets gen_ai.* attributes
  - [ ] startToolSpan sets forge.tool.* attributes
  - [ ] currentContext() returns traceId, spanId, agentId, runId
  - [ ] inject()/extract() use W3C Trace Context format
  - [ ] Tests: span creation, attribute setting, context propagation
  - [ ] Zero TS errors

---

### ECO-016: AsyncLocalStorage Trace Context
- **Source:** Doc 06, Feature F1 (context propagation)
- **Phase:** 1
- **Priority:** P0
- **Package:** @dzipagent/otel
- **Effort:** 2h
- **Dependencies:** ECO-015
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-otel/src/trace-context-store.ts` -- ForgeTraceContext, forgeContextStore (AsyncLocalStorage), withForgeContext(), currentForgeContext()
- **Acceptance Criteria:**
  - [ ] ForgeTraceContext carries traceId, spanId, agentId, runId, phase, tenantId, baggage
  - [ ] withForgeContext() runs function within context scope
  - [ ] currentForgeContext() returns current context or undefined
  - [ ] Nested contexts inherit and can override parent fields
  - [ ] Tests: context propagation through async boundaries, nesting
  - [ ] Zero TS errors

---

### ECO-017: OTel Event Bridge
- **Source:** Doc 06, Feature F1 (event bus integration)
- **Phase:** 1
- **Priority:** P0
- **Package:** @dzipagent/otel
- **Effort:** 4h
- **Dependencies:** ECO-015, ECO-016
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-otel/src/otel-bridge.ts` -- OTelBridge subscribes to DzipEventBus, translates events to OTel spans/metrics
  - `packages/forgeagent-otel/src/event-metric-map.ts` -- EVENT_METRIC_MAP mapping DzipEvent types to metric operations
- **Acceptance Criteria:**
  - [ ] OTelBridge.attach(eventBus) subscribes to all DzipEvent types
  - [ ] agent:started creates span events on active agent spans
  - [ ] agent:completed records duration histogram
  - [ ] tool:called/tool:result records tool metrics
  - [ ] memory:written/memory:searched records memory metrics
  - [ ] budget:warning/exceeded records budget metrics
  - [ ] EVENT_METRIC_MAP covers all ~25 DzipEvent types
  - [ ] Tests: event -> metric mapping for each event type
  - [ ] Zero TS errors

---

### ECO-018: Distributed Tracing -- Cross-Agent Propagation
- **Source:** Doc 06, Feature F2
- **Phase:** 1
- **Priority:** P0
- **Package:** @dzipagent/otel
- **Effort:** 4h
- **Dependencies:** ECO-015, ECO-005
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-otel/src/distributed-tracing.ts` -- TracePropagator with injectIntoMessage, extractFromMessage, injectIntoHeaders, extractFromHeaders, createSpanLink
- **Acceptance Criteria:**
  - [ ] TracePropagator injects W3C traceparent/tracestate into ForgeMessage metadata
  - [ ] Extract creates OTel Context from incoming message headers
  - [ ] Sub-agent spawner integration: extractTraceContextForChild() / restoreTraceContextFromParent()
  - [ ] Cross-service A2A traces produce connected spans
  - [ ] Tests: inject/extract round-trip, child span creation, link creation
  - [ ] Zero TS errors

---

### ECO-019: Prometheus Metrics Exporter
- **Source:** Doc 06, Feature F3
- **Phase:** 1
- **Priority:** P0
- **Package:** @dzipagent/otel
- **Effort:** 4h
- **Dependencies:** ECO-017
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-otel/src/prometheus.ts` -- MetricsExporter with counter(), histogram(), gauge(), toPrometheusText(), DZIP_METRICS constant
- **Acceptance Criteria:**
  - [ ] MetricsExporter records counters, histograms, gauges with labels
  - [ ] toPrometheusText() outputs valid Prometheus text exposition format
  - [ ] Histogram buckets: default [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120]
  - [ ] DZIP_METRICS defines all standard metrics with name, type, help, labels
  - [ ] Label sanitization follows Prometheus naming rules
  - [ ] HELP and TYPE annotations in output
  - [ ] Tests: counter increment, histogram recording, text format parsing
  - [ ] Zero TS errors

---

### ECO-020: Prometheus /metrics Endpoint
- **Source:** Doc 06, Feature F3 (server integration)
- **Phase:** 1
- **Priority:** P0
- **Package:** @dzipagent/server
- **Effort:** 2h
- **Dependencies:** ECO-019
- **Agent:** forgeagent-server-dev
- **Files to create/modify:**
  - `packages/forgeagent-server/src/routes/health.ts` -- Update /metrics endpoint to serve Prometheus text format via content negotiation
- **Acceptance Criteria:**
  - [ ] GET /metrics returns text/plain Prometheus format when Accept includes text/plain
  - [ ] Falls back to JSON when MetricsExporter not configured
  - [ ] Content-Type: text/plain; version=0.0.4; charset=utf-8
  - [ ] Tests: content negotiation, Prometheus format output
  - [ ] Zero TS errors

---

### ECO-021: Structured Logging (ForgeLogger)
- **Source:** Doc 06, Feature F4
- **Phase:** 1
- **Priority:** P0
- **Package:** @dzipagent/otel
- **Effort:** 4h
- **Dependencies:** ECO-016
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-otel/src/logger.ts` -- ForgeLogger with debug/info/warn/error, auto-includes traceId/spanId/agentId from AsyncLocalStorage context
- **Acceptance Criteria:**
  - [ ] ForgeLogger outputs structured JSON log entries
  - [ ] Each entry includes timestamp, level, message, traceId, spanId, agentId
  - [ ] Configurable log level (debug/info/warn/error)
  - [ ] Configurable transports: console, file, custom
  - [ ] Auto-reads ForgeTraceContext from AsyncLocalStorage
  - [ ] Tests: log entry format, level filtering, context injection
  - [ ] Zero TS errors

---

### ECO-022: OTel Plugin (DzipPlugin)
- **Source:** Doc 06, Feature F1 (plugin wrapper)
- **Phase:** 1
- **Priority:** P0
- **Package:** @dzipagent/otel
- **Effort:** 3h
- **Dependencies:** ECO-015, ECO-017, ECO-019, ECO-021
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-otel/src/otel-plugin.ts` -- createOTelPlugin() returning DzipPlugin that wires tracer, bridge, logger, prometheus
- **Acceptance Criteria:**
  - [ ] createOTelPlugin(config) returns a DzipPlugin
  - [ ] onRegister() attaches OTelBridge to DzipEventBus
  - [ ] onRegister() registers AgentHooks for span lifecycle
  - [ ] Config supports optional tracer, logger, prometheus, costAttribution, safetyMonitor, auditTrail sections
  - [ ] Omitting a section disables that feature (zero-cost)
  - [ ] Tests: plugin registration, bridge attachment, cleanup on dispose
  - [ ] Zero TS errors

---

### ECO-023: Memory Provenance Tracking
- **Source:** Doc 05, Feature F2
- **Phase:** 1
- **Priority:** P0
- **Package:** @dzipagent/memory
- **Effort:** 4h
- **Dependencies:** None
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-memory/src/provenance/types.ts` -- MemoryProvenance, ProvenanceSource, ProvenanceWriteOptions
  - `packages/forgeagent-memory/src/provenance/provenance-writer.ts` -- ProvenanceWriter class, extractProvenance(), createProvenance(), extendProvenance()
  - `packages/forgeagent-memory/src/memory-types.ts` -- Add includeProvenance to FormatOptions
  - `packages/forgeagent-memory/src/index.ts` -- Re-export provenance module
- **Acceptance Criteria:**
  - [ ] ProvenanceWriter auto-injects _provenance on every write
  - [ ] _provenance includes createdBy, createdAt, source, confidence, lineage
  - [ ] extendProvenance() appends agent to lineage chain
  - [ ] getByProvenance() filters by creator, source, minConfidence
  - [ ] getLineage() returns full lineage chain for a record
  - [ ] formatForPrompt with includeProvenance:true adds annotations
  - [ ] Tests: auto-inject, lineage extension, provenance filtering, content hash
  - [ ] Zero TS errors

---

## Phase 2: Communication & Observability (Weeks 3-4)

### ECO-024: MCP Resources Support
- **Source:** Doc 02, Feature F5
- **Phase:** 2
- **Priority:** P1
- **Package:** @dzipagent/core
- **Effort:** 8h
- **Dependencies:** ECO-006
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-core/src/mcp/mcp-resources.ts` -- MCP Resources client: listResources, readResource, subscribeToResource
  - `packages/forgeagent-core/src/mcp/mcp-resource-types.ts` -- MCPResource, MCPResourceTemplate, ResourceSubscription types
- **Acceptance Criteria:**
  - [ ] listResources() returns available resources from MCP server
  - [ ] readResource() fetches resource content by URI
  - [ ] subscribeToResource() receives change notifications
  - [ ] Resource content exposed via ProtocolAdapter interface
  - [ ] Tests: resource listing, reading, subscription round-trip
  - [ ] Zero TS errors

---

### ECO-025: MCP Sampling Support
- **Source:** Doc 02, Feature F6
- **Phase:** 2
- **Priority:** P1
- **Package:** @dzipagent/core
- **Effort:** 8h
- **Dependencies:** ECO-006
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-core/src/mcp/mcp-sampling.ts` -- MCP Sampling handler: handleSamplingRequest, SamplingHandler interface
  - `packages/forgeagent-core/src/mcp/mcp-sampling-types.ts` -- MCPSamplingRequest, MCPSamplingResponse types
- **Acceptance Criteria:**
  - [ ] SamplingHandler processes server-initiated LLM requests
  - [ ] Routes sampling requests through ModelRegistry for model selection
  - [ ] Budget constraints from ForgeMessage metadata respected
  - [ ] Tests: sampling request handling, model routing, budget enforcement
  - [ ] Zero TS errors

---

### ECO-026: Protocol Bridge
- **Source:** Doc 02, Feature F7
- **Phase:** 2
- **Priority:** P1
- **Package:** @dzipagent/core
- **Effort:** 6h
- **Dependencies:** ECO-006, ECO-009
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-core/src/protocol/protocol-bridge.ts` -- ProtocolBridge translates between protocols (expose MCP tool as A2A capability and vice versa)
- **Acceptance Criteria:**
  - [ ] ProtocolBridge.bridge(source, target) creates a bidirectional translation layer
  - [ ] MCP tool_call payloads translate to A2A task payloads
  - [ ] A2A task results translate to MCP tool_result payloads
  - [ ] Bridge preserves trace context across protocol boundaries
  - [ ] Tests: MCP-to-A2A bridge, A2A-to-MCP bridge, trace propagation
  - [ ] Zero TS errors

---

### ECO-027: Message Serialization
- **Source:** Doc 02, Feature F8
- **Phase:** 2
- **Priority:** P1
- **Package:** @dzipagent/core
- **Effort:** 3h
- **Dependencies:** ECO-005
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-core/src/protocol/serialization.ts` -- MessageSerializer interface, JSONSerializer (default), optional MessagePack support
- **Acceptance Criteria:**
  - [ ] MessageSerializer interface: serialize(ForgeMessage) -> Uint8Array, deserialize(Uint8Array) -> ForgeMessage
  - [ ] JSONSerializer is the default
  - [ ] Round-trip preserves all ForgeMessage fields including branded types
  - [ ] Tests: JSON round-trip, invalid input handling
  - [ ] Zero TS errors

---

### ECO-028: Delegation Token System -- Types and Store
- **Source:** Doc 01, Feature F4 (types)
- **Phase:** 2
- **Priority:** P1
- **Package:** @dzipagent/core
- **Effort:** 3h
- **Dependencies:** ECO-001, ECO-002
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-core/src/identity/delegation-types.ts` -- DelegationToken, DelegationChain, DelegationConstraint and its 5 specific variants
  - `packages/forgeagent-core/src/identity/delegation-store.ts` -- DelegationTokenStore interface (in-memory implementation)
- **Acceptance Criteria:**
  - [ ] DelegationToken: id, delegator, delegatee, scope, constraints, parentTokenId, depth, issuedAt, expiresAt, signature
  - [ ] DelegationChain: tokens array, effectiveScope (intersection), valid, invalidReason
  - [ ] 5 constraint types: max-cost, max-tokens, max-iterations, allowed-tools, time-window
  - [ ] InMemoryDelegationTokenStore: save, get, getByDelegatee, revoke, isRevoked
  - [ ] Tests: type validation, store CRUD operations
  - [ ] Zero TS errors

---

### ECO-029: Delegation Token System -- Manager
- **Source:** Doc 01, Feature F4 (manager)
- **Phase:** 2
- **Priority:** P1
- **Package:** @dzipagent/core
- **Effort:** 5h
- **Dependencies:** ECO-028
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-core/src/identity/delegation-manager.ts` -- DelegationManager: issue, verify, validateChain, revoke, hasCapabilityInChain; HMAC-SHA256 signing
- **Acceptance Criteria:**
  - [ ] issue() creates signed delegation token with HMAC-SHA256
  - [ ] verify() validates signature using timing-safe comparison
  - [ ] validateChain() walks parentTokenId links, verifies each token, intersects scopes
  - [ ] revoke() cascades to all child tokens
  - [ ] Depth enforcement: rejects if chain exceeds maxDepth (default 3)
  - [ ] Scope narrowing: child scope must be subset of parent scope
  - [ ] Tests: issue/verify, chain validation, depth exceeded, scope violation, expiration, revocation cascade
  - [ ] Zero TS errors

---

### ECO-030: Capability-Based Authorization -- Checker
- **Source:** Doc 01, Feature F5
- **Phase:** 2
- **Priority:** P1
- **Package:** @dzipagent/core
- **Effort:** 3h
- **Dependencies:** ECO-001, ECO-028
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-core/src/identity/capability-checker.ts` -- CapabilityChecker, createCapabilityChecker(), CapabilityCheckResult
- **Acceptance Criteria:**
  - [ ] check() returns CapabilityCheckResult with allowed, reason, grantedBy, matchedCapability
  - [ ] Resolution order: delegation chain scope -> direct capabilities -> RBAC role mapping
  - [ ] Wildcard matching: "code.*" matches "code.generate"
  - [ ] Default roleCapabilityMap: admin->["*"], operator->["runs.*","agents.read","tools.*","approvals.*"], viewer->["*.read"], agent->["runs.*","tools.execute"]
  - [ ] Tests: direct match, wildcard, role fallback, delegation scope restriction
  - [ ] Zero TS errors

---

### ECO-031: Capability Guard Middleware
- **Source:** Doc 01, Feature F5 (server)
- **Phase:** 2
- **Priority:** P1
- **Package:** @dzipagent/server
- **Effort:** 2h
- **Dependencies:** ECO-030, ECO-004
- **Agent:** forgeagent-server-dev
- **Files to create/modify:**
  - `packages/forgeagent-server/src/middleware/capability-guard.ts` -- capabilityGuard() Hono middleware
- **Acceptance Criteria:**
  - [ ] capabilityGuard('runs.create') checks identity for capability
  - [ ] capabilityGuard(['agents.update','runs.create']) checks all capabilities
  - [ ] Returns 403 with CAPABILITY_DENIED error code on failure
  - [ ] Falls through gracefully if no identity middleware configured
  - [ ] Tests: single/multiple capability check, no identity fallback
  - [ ] Zero TS errors

---

### ECO-032: Agent Card Signing
- **Source:** Doc 01, Feature F6
- **Phase:** 2
- **Priority:** P1
- **Package:** @dzipagent/core
- **Effort:** 4h
- **Dependencies:** ECO-001
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-core/src/identity/signing-types.ts` -- SigningKeyPair, SignedDocument, SignedAgentCard
  - `packages/forgeagent-core/src/identity/key-manager.ts` -- KeyManager, KeyStore interfaces, createKeyManager() with Ed25519 support
- **Acceptance Criteria:**
  - [ ] KeyManager.generate() creates Ed25519 key pair
  - [ ] KeyManager.sign() produces Base64URL signature
  - [ ] KeyManager.verify() validates signature
  - [ ] Key rotation: rotate() generates new key, marks old as expiring
  - [ ] SignedAgentCard extends SignedDocument<AgentCard>
  - [ ] Tests: key generation, sign/verify round-trip, rotation, revoked key rejection
  - [ ] Zero TS errors

---

### ECO-033: Cascading Timeouts
- **Source:** Doc 04, Feature F7
- **Phase:** 2
- **Priority:** P1
- **Package:** @dzipagent/agent
- **Effort:** 4h
- **Dependencies:** ECO-014
- **Agent:** forgeagent-agent-dev
- **Files to create/modify:**
  - `packages/forgeagent-agent/src/guardrails/cascading-timeout.ts` -- CascadingTimeout class: deadline propagation via AbortController chain, reserve time for cleanup
- **Acceptance Criteria:**
  - [ ] CascadingTimeout.create(totalMs) creates root timeout
  - [ ] fork(childMs) creates child with min(childMs, remaining) deadline
  - [ ] AbortSignal chain: parent abort cascades to children
  - [ ] Reserve time: children receive (remaining - reserveMs) to allow parent cleanup
  - [ ] Tests: cascade propagation, parent abort, reserve time, nested forks
  - [ ] Zero TS errors

---

### ECO-034: Cost Attribution
- **Source:** Doc 06, Feature F6
- **Phase:** 2
- **Priority:** P1
- **Package:** @dzipagent/otel
- **Effort:** 6h
- **Dependencies:** ECO-017
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-otel/src/cost-attribution.ts` -- CostAttributor: per-agent, per-phase, per-tool cost aggregation; alert thresholds
- **Acceptance Criteria:**
  - [ ] CostAttributor subscribes to DzipEventBus for cost-related events
  - [ ] Aggregates cost by agentId, phase, toolName
  - [ ] Records forge.cost.cents span attribute on LLM spans
  - [ ] Fires cost alert events when thresholds exceeded
  - [ ] getCostReport() returns breakdown by agent/phase/tool
  - [ ] Tests: cost aggregation, threshold alerts, report generation
  - [ ] Zero TS errors

---

### ECO-035: Safety Monitoring
- **Source:** Doc 06, Feature F9
- **Phase:** 2
- **Priority:** P1
- **Package:** @dzipagent/otel
- **Effort:** 6h
- **Dependencies:** ECO-017
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-otel/src/safety-monitor.ts` -- SafetyMonitor: prompt injection detection (input/output), tool misuse detection, memory poisoning detection
- **Acceptance Criteria:**
  - [ ] Detects common prompt injection patterns in agent inputs
  - [ ] Detects prompt injection patterns in agent outputs (exfiltration attempts)
  - [ ] Detects repeated tool failures (configurable threshold, default 3)
  - [ ] Emits safety:* events on DzipEventBus
  - [ ] Records forge_safety_events_total metric
  - [ ] Non-blocking: detection runs async, never stops agent execution
  - [ ] Tests: injection pattern detection, tool failure threshold, metric recording
  - [ ] Zero TS errors

---

### ECO-036: Compliance Audit Trail
- **Source:** Doc 06, Feature F10
- **Phase:** 2
- **Priority:** P1
- **Package:** @dzipagent/otel
- **Effort:** 6h
- **Dependencies:** ECO-017
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-otel/src/audit-trail.ts` -- AuditTrail, AuditEntry, AuditStore interface, AuditCategory, hash chain for tamper detection
- **Acceptance Criteria:**
  - [ ] AuditTrail subscribes to DzipEventBus and records selected events
  - [ ] AuditEntry: id, timestamp, category, agentId, action, details, previousHash, hash
  - [ ] Hash chain: each entry's hash includes previous entry hash (tamper detection)
  - [ ] Configurable categories: agent_lifecycle, tool_execution, memory_mutation, approval_action, safety_event, cost_threshold, config_change
  - [ ] Retention: prune entries older than retentionDays
  - [ ] AuditStore interface for pluggable persistence
  - [ ] Tests: entry recording, hash chain verification, retention pruning, tamper detection
  - [ ] Zero TS errors

---

### ECO-037: Causal Graph -- Types and Core
- **Source:** Doc 05, Feature F3
- **Phase:** 2
- **Priority:** P1
- **Package:** @dzipagent/memory
- **Effort:** 4h
- **Dependencies:** ECO-023
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-memory/src/causal/types.ts` -- CausalRelation, CausalNode, CausalGraphResult, CausalTraversalOptions
  - `packages/forgeagent-memory/src/causal/causal-graph.ts` -- CausalGraph class: addRelation, removeRelation, getRelations
- **Acceptance Criteria:**
  - [ ] CausalRelation: cause, causeNamespace, effect, effectNamespace, confidence, evidence
  - [ ] addRelation() persists in __causal namespace
  - [ ] Idempotent: re-adding same cause-effect updates confidence/evidence
  - [ ] getRelations() returns both causes and effects for a record
  - [ ] Tests: add/remove relation, idempotent update, get causes/effects
  - [ ] Zero TS errors

---

### ECO-038: Causal Graph -- Traversal and Retriever Integration
- **Source:** Doc 05, Feature F3 (traversal)
- **Phase:** 2
- **Priority:** P1
- **Package:** @dzipagent/memory
- **Effort:** 4h
- **Dependencies:** ECO-037
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-memory/src/causal/causal-graph.ts` -- Add traverse(), search(), extractFromConversation()
  - `packages/forgeagent-memory/src/retrieval/adaptive-retriever.ts` -- Add optional causal provider and weight
- **Acceptance Criteria:**
  - [ ] traverse() does BFS with confidence-weighted pruning
  - [ ] Direction: causes (backward), effects (forward), both
  - [ ] maxDepth and minConfidence thresholds
  - [ ] Handles cyclic graphs (visited set prevents infinite loops)
  - [ ] search() compatible with AdaptiveRetriever provider contract
  - [ ] RetrievalWeights gains optional causal field
  - [ ] Tests: forward/backward traversal, depth limit, confidence threshold, cycle handling, diamond pattern
  - [ ] Zero TS errors

---

### ECO-039: Convention Memory -- Types and Extractor
- **Source:** Doc 05, Feature F8
- **Phase:** 2
- **Priority:** P1
- **Package:** @dzipagent/memory
- **Effort:** 4h
- **Dependencies:** None
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-memory/src/convention/types.ts` -- DetectedConvention, ConventionCategory, ConventionCheckResult
  - `packages/forgeagent-memory/src/convention/convention-extractor.ts` -- ConventionExtractor class: analyzeCode(), getConventions()
- **Acceptance Criteria:**
  - [ ] DetectedConvention: id, name, category, description, pattern, examples, confidence, occurrences, techStack
  - [ ] ConventionCategory: naming, structure, imports, error-handling, typing, testing, api, database, styling, general
  - [ ] analyzeCode() uses LLM to detect patterns from code files
  - [ ] Stores detected conventions in memory service
  - [ ] Tests: convention type validation, mock LLM convention detection
  - [ ] Zero TS errors

---

### ECO-040: Convention Memory -- Conformance Checking
- **Source:** Doc 05, Feature F8 (conformance)
- **Phase:** 2
- **Priority:** P1
- **Package:** @dzipagent/memory
- **Effort:** 4h
- **Dependencies:** ECO-039
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-memory/src/convention/convention-extractor.ts` -- Add checkConformance(), setHumanVerdict(), formatForPrompt(), consolidate()
- **Acceptance Criteria:**
  - [ ] checkConformance() returns followed/violated conventions with evidence and suggestions
  - [ ] conformanceScore 0.0-1.0
  - [ ] setHumanVerdict() confirms (confidence=1.0) or rejects (confidence=0) conventions
  - [ ] formatForPrompt() produces markdown suitable for system prompts
  - [ ] consolidate() merges similar conventions and prunes low-confidence ones
  - [ ] Tests: conformance pass/fail, human verdict, consolidation, prompt formatting
  - [ ] Zero TS errors

---

### ECO-041: Memory Encryption -- Types and Key Provider
- **Source:** Doc 05, Feature F6
- **Phase:** 2
- **Priority:** P1
- **Package:** @dzipagent/memory
- **Effort:** 3h
- **Dependencies:** None
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-memory/src/encryption/types.ts` -- EncryptedEnvelope, EncryptionKeyDescriptor, EncryptionKeyProvider interface
  - `packages/forgeagent-memory/src/encryption/env-key-provider.ts` -- EnvKeyProvider reads keys from DZIP_MEMORY_KEY_* env vars
- **Acceptance Criteria:**
  - [ ] EncryptedEnvelope: _encrypted marker, algorithm, keyId, ciphertext, iv, authTag
  - [ ] EncryptionKeyProvider: getKey(), getActiveKey(), listKeys()
  - [ ] EnvKeyProvider reads hex-encoded keys from environment variables
  - [ ] Tests: env var parsing, key lookup, missing key returns null
  - [ ] Zero TS errors

---

### ECO-042: Memory Encryption -- EncryptedMemoryService
- **Source:** Doc 05, Feature F6 (service)
- **Phase:** 2
- **Priority:** P1
- **Package:** @dzipagent/memory
- **Effort:** 4h
- **Dependencies:** ECO-041
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-memory/src/encryption/encrypted-memory-service.ts` -- EncryptedMemoryService wrapping MemoryService with AES-256-GCM
- **Acceptance Criteria:**
  - [ ] put() encrypts record value for configured namespaces using AES-256-GCM
  - [ ] get() transparently decrypts EncryptedEnvelope records
  - [ ] Non-encrypted namespaces pass through unchanged
  - [ ] Plaintext fields preserved outside encryption for searchability
  - [ ] rotateKey() re-encrypts all records with new active key
  - [ ] Missing key during decrypt: non-fatal error (returns empty, logs warning)
  - [ ] Tests: encrypt/decrypt round-trip, non-encrypted passthrough, plaintext fields, key rotation, tampered ciphertext detection
  - [ ] Zero TS errors

---

## Phase 3: Memory Sharing & Discovery (Weeks 5-6)

### ECO-043: Shared Memory Spaces -- Types
- **Source:** Doc 05, Feature F1 (types)
- **Phase:** 3
- **Priority:** P0
- **Package:** @dzipagent/memory
- **Effort:** 3h
- **Dependencies:** ECO-023
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-memory/src/sharing/types.ts` -- SharedMemorySpace, MemoryParticipant, SpacePermission, ConflictStrategy, RetentionPolicy, MemoryShareRequest, PendingShareRequest, SharedMemoryEvent
- **Acceptance Criteria:**
  - [ ] SharedMemorySpace: id, name, owner, participants, schemaKey, retentionPolicy, conflictResolution
  - [ ] SpacePermission: read, read-write, admin
  - [ ] ConflictStrategy: lww, manual, crdt
  - [ ] SharedMemoryEvent discriminated union for all space operations
  - [ ] MemoryShareRequest supports push, pull-request, subscribe modes
  - [ ] Tests: type validation via Zod schemas
  - [ ] Zero TS errors

---

### ECO-044: Shared Memory Spaces -- MemorySpaceManager (Core)
- **Source:** Doc 05, Feature F1 (manager)
- **Phase:** 3
- **Priority:** P0
- **Package:** @dzipagent/memory
- **Effort:** 6h
- **Dependencies:** ECO-043
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-memory/src/sharing/memory-space-manager.ts` -- MemorySpaceManager: create, join, leave, share, query, getSpace, listSpaces
  - `packages/forgeagent-memory/src/memory-service.ts` -- Add addNamespace(), hasNamespace(), removeNamespace()
- **Acceptance Criteria:**
  - [ ] create() persists space in __spaces namespace and registers dynamic namespace
  - [ ] join() adds participant with permission level
  - [ ] leave() removes participant
  - [ ] share(mode:'push') validates permission, injects provenance, writes to shared namespace
  - [ ] share(mode:'pull-request') creates pending request for admin approval
  - [ ] query() checks read permission, supports semantic search
  - [ ] MemoryService gains addNamespace/hasNamespace/removeNamespace
  - [ ] Tests: create/join/leave, push share, permission enforcement, query
  - [ ] Zero TS errors

---

### ECO-045: Shared Memory Spaces -- Events and Subscriptions
- **Source:** Doc 05, Feature F1 (events)
- **Phase:** 3
- **Priority:** P0
- **Package:** @dzipagent/memory
- **Effort:** 3h
- **Dependencies:** ECO-044
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-memory/src/sharing/memory-space-manager.ts` -- Add subscribe(), reviewPullRequest(), listPendingRequests(), enforceRetention(), dispose()
- **Acceptance Criteria:**
  - [ ] subscribe() registers callback via DzipEventBus for space events
  - [ ] memory:space:write events emitted on every push write
  - [ ] reviewPullRequest() approves/rejects pending requests (admin only)
  - [ ] enforceRetention() prunes records exceeding age/count limits
  - [ ] dispose() cleans up all subscriptions and timers
  - [ ] Tests: event emission, subscription delivery, PR flow, retention enforcement
  - [ ] Zero TS errors

---

### ECO-046: Agent File Export
- **Source:** Doc 05, Feature F4 (export)
- **Phase:** 3
- **Priority:** P1
- **Package:** @dzipagent/memory
- **Effort:** 4h
- **Dependencies:** ECO-023
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-memory/src/agent-file/types.ts` -- AgentFile, AgentFileAgentSection, AgentFileMemorySection, AgentFilePromptsSection, AgentFileStateSection, AgentFileMemoryRecord
  - `packages/forgeagent-memory/src/agent-file/exporter.ts` -- AgentFileExporter.export()
- **Acceptance Criteria:**
  - [ ] AgentFile format includes $schema, version, exportedAt, exportedBy, agent, memory, prompts, state sections
  - [ ] export() serializes all namespaces with provenance and temporal metadata
  - [ ] Includes working memory and causal relations if present
  - [ ] Optional SHA-256 signature over content sections
  - [ ] Tests: export with 3 namespaces, provenance preserved, signature generation
  - [ ] Zero TS errors

---

### ECO-047: Agent File Import
- **Source:** Doc 05, Feature F4 (import)
- **Phase:** 3
- **Priority:** P1
- **Package:** @dzipagent/memory
- **Effort:** 4h
- **Dependencies:** ECO-046
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-memory/src/agent-file/importer.ts` -- AgentFileImporter.import(), AgentFileImporter.validate()
- **Acceptance Criteria:**
  - [ ] import() writes records with source:'imported' provenance
  - [ ] Conflict handling: skip (default), overwrite, merge
  - [ ] Signature verification when present
  - [ ] validate() checks structure, version, and signature without importing
  - [ ] ImportResult: imported/skipped/failed counts, warnings
  - [ ] Tests: export/import round-trip, conflict skip/overwrite/merge, signature verify, version validation
  - [ ] Zero TS errors

---

### ECO-048: PostgresRegistry -- Drizzle Schema
- **Source:** Doc 03, Feature F4 (schema)
- **Phase:** 3
- **Priority:** P1
- **Package:** @dzipagent/server
- **Effort:** 3h
- **Dependencies:** ECO-011
- **Agent:** forgeagent-server-dev
- **Files to create/modify:**
  - `packages/forgeagent-server/src/persistence/schema.ts` -- Add forge_registry_agents, forge_registry_health Drizzle tables
- **Acceptance Criteria:**
  - [ ] forge_registry_agents table: id, name, description, endpoint, protocols (jsonb), capabilities (jsonb), authentication (jsonb), version, sla (jsonb), metadata (jsonb), registered_at, last_updated_at, ttl_ms
  - [ ] forge_registry_health table: agent_id (FK), status, last_checked_at, last_success_at, latency_p50/p95/p99, error_rate, consecutive_successes/failures, uptime_ratio, circuit_state
  - [ ] Indexes on capabilities (GIN), protocols (GIN), status
  - [ ] Tests: schema validation, migration generation
  - [ ] Zero TS errors

---

### ECO-049: PostgresRegistry -- Implementation
- **Source:** Doc 03, Feature F4 (impl)
- **Phase:** 3
- **Priority:** P1
- **Package:** @dzipagent/server
- **Effort:** 6h
- **Dependencies:** ECO-048, ECO-013
- **Agent:** forgeagent-server-dev
- **Files to create/modify:**
  - `packages/forgeagent-server/src/persistence/postgres-registry.ts` -- PostgresRegistry implementing AgentRegistry using Drizzle
- **Acceptance Criteria:**
  - [ ] All AgentRegistry methods implemented with Drizzle queries
  - [ ] discover() uses GIN index for capability prefix matching
  - [ ] discover() combines capability, tag, and health scores
  - [ ] evictExpired() deletes agents past TTL
  - [ ] emits registry:* events through DzipEventBus
  - [ ] Tests: register/discover/update/deregister, capability query, TTL eviction
  - [ ] Zero TS errors

---

### ECO-050: Semantic Capability Search
- **Source:** Doc 03, Feature F5
- **Phase:** 3
- **Priority:** P1
- **Package:** @dzipagent/core (interface) + @dzipagent/server (impl)
- **Effort:** 6h
- **Dependencies:** ECO-049
- **Agent:** forgeagent-server-dev
- **Files to create/modify:**
  - `packages/forgeagent-core/src/registry/types.ts` -- Add SemanticSearchProvider interface
  - `packages/forgeagent-server/src/persistence/semantic-search.ts` -- EmbeddingSemanticSearch using pgvector or in-memory cosine similarity
- **Acceptance Criteria:**
  - [ ] SemanticSearchProvider: embedQuery(text) -> number[], search(embedding, limit) -> scored results
  - [ ] discover() with semanticQuery uses embedding similarity
  - [ ] Score fusion: capabilityScore * 0.4 + semanticScore * 0.3 + tagScore * 0.2 + healthAdjustment * 0.1
  - [ ] Fallback to keyword matching if no embedding provider configured
  - [ ] Tests: semantic search with mock embeddings, score fusion, fallback
  - [ ] Zero TS errors

---

### ECO-051: Health Monitoring
- **Source:** Doc 03, Feature F6
- **Phase:** 3
- **Priority:** P1
- **Package:** @dzipagent/server
- **Effort:** 5h
- **Dependencies:** ECO-049
- **Agent:** forgeagent-server-dev
- **Files to create/modify:**
  - `packages/forgeagent-server/src/registry/health-monitor.ts` -- HealthMonitor: periodic HTTP probes, circuit breaker state, latency percentile tracking
- **Acceptance Criteria:**
  - [ ] HealthMonitor probes registered agents on configurable interval (default 30s)
  - [ ] Updates AgentHealth via registry.updateHealth()
  - [ ] Circuit breaker: closed -> open (after N failures), open -> half-open (after cooldown), half-open -> closed (on success)
  - [ ] Latency percentiles (p50, p95, p99) calculated from sliding window
  - [ ] Emits registry:health_changed events on status transitions
  - [ ] Tests: probe success/failure, circuit breaker transitions, percentile calculation
  - [ ] Zero TS errors

---

### ECO-052: Registry REST API
- **Source:** Doc 03, Feature F4 (routes)
- **Phase:** 3
- **Priority:** P1
- **Package:** @dzipagent/server
- **Effort:** 3h
- **Dependencies:** ECO-049
- **Agent:** forgeagent-server-dev
- **Files to create/modify:**
  - `packages/forgeagent-server/src/routes/registry.ts` -- GET/POST/DELETE /api/registry/agents, GET /api/registry/discover, GET /api/registry/stats
- **Acceptance Criteria:**
  - [ ] POST /api/registry/agents registers an agent
  - [ ] GET /api/registry/agents lists agents with pagination
  - [ ] DELETE /api/registry/agents/:id deregisters
  - [ ] GET /api/registry/discover accepts query params, returns DiscoveryResultPage
  - [ ] GET /api/registry/stats returns RegistryStats
  - [ ] All routes require auth via authMiddleware
  - [ ] Tests: CRUD operations, discovery query params, auth enforcement
  - [ ] Zero TS errors

---

### ECO-053: Contract-Net Protocol -- Types and Strategies
- **Source:** Doc 04, Feature F2 (types)
- **Phase:** 3
- **Priority:** P1
- **Package:** @dzipagent/agent
- **Effort:** 4h
- **Dependencies:** ECO-014
- **Agent:** forgeagent-agent-dev
- **Files to create/modify:**
  - `packages/forgeagent-agent/src/orchestration/contract-net/contract-net-types.ts` -- CallForProposals, ContractBid, ContractAward, ContractResult, ContractNetPhase, ContractNetState, BidEvaluationStrategy
  - `packages/forgeagent-agent/src/orchestration/contract-net/bid-strategies.ts` -- lowestCostStrategy, fastestStrategy, highestQualityStrategy, createWeightedStrategy
- **Acceptance Criteria:**
  - [ ] CallForProposals: cfpId, task, requiredCapabilities, maxCostCents, bidDeadline
  - [ ] ContractBid: estimatedCostCents, estimatedDurationMs, qualityEstimate, confidence, approach
  - [ ] BidEvaluationStrategy interface with evaluate() method
  - [ ] 4 built-in strategies: lowest-cost, fastest, highest-quality, weighted
  - [ ] createWeightedStrategy normalizes weights and scores bids
  - [ ] Tests: each strategy sorts bids correctly, weighted scoring math
  - [ ] Zero TS errors

---

### ECO-054: Contract-Net Protocol -- Manager
- **Source:** Doc 04, Feature F2 (manager)
- **Phase:** 3
- **Priority:** P1
- **Package:** @dzipagent/agent
- **Effort:** 6h
- **Dependencies:** ECO-053
- **Agent:** forgeagent-agent-dev
- **Files to create/modify:**
  - `packages/forgeagent-agent/src/orchestration/contract-net/contract-net-manager.ts` -- ContractNetManager.execute(): broadcast CFP, collect bids, evaluate, award, execute
  - `packages/forgeagent-agent/src/orchestration/orchestrator.ts` -- Add static contractNet() method
- **Acceptance Criteria:**
  - [ ] execute() runs full CFP lifecycle: broadcast -> collect -> evaluate -> award -> execute
  - [ ] Bid collection via parallel agent.generate() calls with structured bid prompt
  - [ ] Bid timeout enforced via AbortController
  - [ ] No-bids handling with optional retry
  - [ ] Emits contract-net:* events on DzipEventBus
  - [ ] AgentOrchestrator.contractNet() static convenience method
  - [ ] Tests: successful execution, no bids, timeout, cancellation via signal
  - [ ] Zero TS errors

---

### ECO-055: Dynamic Topology -- Analyzer
- **Source:** Doc 04, Feature F3 (analyzer)
- **Phase:** 3
- **Priority:** P1
- **Package:** @dzipagent/agent
- **Effort:** 4h
- **Dependencies:** ECO-014
- **Agent:** forgeagent-agent-dev
- **Files to create/modify:**
  - `packages/forgeagent-agent/src/orchestration/topology/topology-types.ts` -- TopologyType, TaskCharacteristics, TopologyRecommendation, TopologyMetrics
  - `packages/forgeagent-agent/src/orchestration/topology/topology-analyzer.ts` -- TopologyAnalyzer heuristic scoring
- **Acceptance Criteria:**
  - [ ] TopologyType: hierarchical, pipeline, star, mesh, ring
  - [ ] analyze() scores each topology based on TaskCharacteristics
  - [ ] Returns recommendation with confidence, reason, and ranked alternatives
  - [ ] Scoring rules: hierarchical for complex+coordinated, pipeline for sequential, star for parallel+fast, mesh for interdependent, ring for iterative refinement
  - [ ] Tests: each topology wins for appropriate characteristics, edge cases
  - [ ] Zero TS errors

---

### ECO-056: Dynamic Topology -- Executor
- **Source:** Doc 04, Feature F3 (executor)
- **Phase:** 3
- **Priority:** P1
- **Package:** @dzipagent/agent
- **Effort:** 6h
- **Dependencies:** ECO-055
- **Agent:** forgeagent-agent-dev
- **Files to create/modify:**
  - `packages/forgeagent-agent/src/orchestration/topology/topology-executor.ts` -- TopologyExecutor: executes mesh and ring topologies, auto-switch support
- **Acceptance Criteria:**
  - [ ] executeMesh(): all agents communicate with all others, shared state
  - [ ] executeRing(): circular pass, each agent refines previous output
  - [ ] Auto-switch: monitors error rate and latency, re-evaluates topology mid-execution
  - [ ] TopologyMetrics recorded for analysis
  - [ ] Tests: mesh execution, ring execution, auto-switch on high error rate
  - [ ] Zero TS errors

---

### ECO-057: CRDT Conflict Resolution -- HLC and Types
- **Source:** Doc 05, Feature F5 (types)
- **Phase:** 3
- **Priority:** P2
- **Package:** @dzipagent/memory
- **Effort:** 4h
- **Dependencies:** ECO-044
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-memory/src/crdt/types.ts` -- HLCTimestamp, LWWRegister, ORSet, LWWMap, StateVector, MergeResult
  - `packages/forgeagent-memory/src/crdt/hlc.ts` -- Hybrid Logical Clock: now(), receive(), compare()
- **Acceptance Criteria:**
  - [ ] HLCTimestamp: wallMs, counter, nodeId
  - [ ] HLC.now() returns monotonically increasing timestamps
  - [ ] HLC.receive() advances local clock on remote timestamp
  - [ ] compare() provides total ordering across nodes
  - [ ] Tests: monotonic property, receive from future, tie-breaking by nodeId
  - [ ] Zero TS errors

---

### ECO-058: CRDT Conflict Resolution -- Resolver
- **Source:** Doc 05, Feature F5 (resolver)
- **Phase:** 3
- **Priority:** P2
- **Package:** @dzipagent/memory
- **Effort:** 6h
- **Dependencies:** ECO-057
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-memory/src/crdt/crdt-resolver.ts` -- CRDTResolver: LWW-Register, OR-Set, LWW-Map operations and merge
- **Acceptance Criteria:**
  - [ ] createRegister/updateRegister/mergeRegisters for scalar values
  - [ ] createSet/addToSet/removeFromSet/mergeSets for OR-Set
  - [ ] createMap/updateField/mergeMaps for record objects (per-field LWW)
  - [ ] Commutativity: merge(A,B) === merge(B,A)
  - [ ] Idempotency: merge(A,A) === A
  - [ ] Tests: LWW register merge, tiebreak, OR-Set add/remove, concurrent add-remove, LWW-Map field merge, commutativity, idempotency
  - [ ] Zero TS errors

---

### ECO-059: CRDT Integration with Shared Spaces
- **Source:** Doc 05, Feature F5 (integration)
- **Phase:** 3
- **Priority:** P2
- **Package:** @dzipagent/memory
- **Effort:** 4h
- **Dependencies:** ECO-058, ECO-044
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-memory/src/sharing/memory-space-manager.ts` -- Add CRDT conflict resolution path for spaces with conflictResolution:'crdt'
- **Acceptance Criteria:**
  - [ ] Writes to CRDT spaces wrap values in LWWMap
  - [ ] On conflict (same key, different agent), CRDTResolver.mergeMaps() invoked
  - [ ] Merged result stored with updated _crdt metadata
  - [ ] memory:space:conflict event emitted on merge
  - [ ] Tests: concurrent writes to same key, per-field resolution, merge event
  - [ ] Zero TS errors

---

### ECO-060: Multi-Modal Memory
- **Source:** Doc 05, Feature F7
- **Phase:** 3
- **Priority:** P2
- **Package:** @dzipagent/memory
- **Effort:** 6h
- **Dependencies:** None
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-memory/src/multi-modal/types.ts` -- MemoryAttachment, AttachmentType, AttachmentMetadata, AttachmentStorageProvider
  - `packages/forgeagent-memory/src/multi-modal/multi-modal-memory-service.ts` -- MultiModalMemoryService: putWithAttachment, addAttachment, searchWithAttachments, getAttachments, removeAttachment
- **Acceptance Criteria:**
  - [ ] MemoryAttachment: id, type, uri, mimeType, description, sizeBytes, embedding, thumbnailUri
  - [ ] AttachmentStorageProvider: upload, getDownloadUrl, delete
  - [ ] putWithAttachment stores attachment metadata in _attachments array
  - [ ] searchWithAttachments combines text and description search
  - [ ] Tests: attach to record, add to existing, search by description, remove attachment
  - [ ] Zero TS errors

---

### ECO-061: Trust Scoring
- **Source:** Doc 01, Feature F10
- **Phase:** 3
- **Priority:** P2
- **Package:** @dzipagent/core
- **Effort:** 6h
- **Dependencies:** ECO-001, ECO-002
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-core/src/identity/trust-scorer.ts` -- TrustScorer, TrustSignals, TrustScoreBreakdown, TrustScoreStore, createTrustScorer()
- **Acceptance Criteria:**
  - [ ] calculate() computes score from TrustSignals with 5 weighted components: reliability (0.35), performance (0.20), costPredictability (0.15), delegationCompliance (0.15), recency (0.15)
  - [ ] Minimum sample size: below threshold, score defaults to 0.5
  - [ ] recordOutcome() updates signals and recalculates
  - [ ] getChainTrust() returns min(trust) across delegation chain
  - [ ] Recency decay using half-life formula
  - [ ] Emits identity:trust_updated event on significant score changes
  - [ ] Tests: score calculation, component weights, sample size threshold, recency decay, chain trust
  - [ ] Zero TS errors

---

### ECO-062: Evaluation Framework -- Scorer Interfaces
- **Source:** Doc 06, Feature F5
- **Phase:** 3
- **Priority:** P1
- **Package:** @dzipagent/evals (new)
- **Effort:** 6h
- **Dependencies:** ECO-015
- **Agent:** forgeagent-core-dev
- **Files to create/modify:**
  - `packages/forgeagent-evals/package.json` -- New package setup
  - `packages/forgeagent-evals/src/types.ts` -- EvalScorer, EvalResult, EvalSuite, EvalRun interfaces
  - `packages/forgeagent-evals/src/deterministic-scorer.ts` -- DeterministicScorer: exact match, contains, regex, JSON schema validation
  - `packages/forgeagent-evals/src/llm-judge-scorer.ts` -- LLMJudgeScorer: LLM-as-judge with rubric
  - `packages/forgeagent-evals/src/composite-scorer.ts` -- CompositeScorer: weighted combination of scorers
  - `packages/forgeagent-evals/src/index.ts` -- Barrel exports
- **Acceptance Criteria:**
  - [ ] EvalScorer interface: score(input, output, reference?) -> EvalResult
  - [ ] EvalResult: score (0-1), pass (boolean), reasoning (string)
  - [ ] DeterministicScorer: exactMatch, contains, regex, jsonSchema methods
  - [ ] LLMJudgeScorer: configurable rubric, uses ModelRegistry for LLM calls
  - [ ] CompositeScorer: weighted average of multiple scorers
  - [ ] Tests: deterministic scorer all modes, composite weighting
  - [ ] Zero TS errors

---

## Dependency Graph (Critical Path)

```
ECO-001 (Identity Types) -----> ECO-003 (API-Key Resolver) -----> ECO-004 (Identity Middleware)
    |                                |
    +---> ECO-002 (URI Scheme) -----+---> ECO-028 (Delegation Types)
    |                                      |
    +---> ECO-011 (Registry Interface)     +---> ECO-029 (Delegation Manager)
    |         |
    |         +---> ECO-012 (Taxonomy) ---> ECO-013 (InMemoryRegistry)
    |
    +---> ECO-005 (Message Envelope) ---> ECO-006 (ProtocolAdapter)
              |                               |
              +---> ECO-027 (Serialization)   +---> ECO-007 (InternalAdapter)
                                              |       |
                                              |       +---> ECO-008 (Router)
                                              |
                                              +---> ECO-009 (A2A Adapter) ---> ECO-010 (SSE)

ECO-015 (DzipTracer) ---> ECO-016 (AsyncLocalStorage) ---> ECO-017 (OTel Bridge)
                                                                  |
                                                                  +---> ECO-019 (Prometheus)
                                                                  +---> ECO-022 (OTel Plugin)

ECO-023 (Provenance) ---> ECO-043 (Space Types) ---> ECO-044 (SpaceManager)
                     |                                     |
                     +---> ECO-046 (Agent File Export)     +---> ECO-045 (Events)
                                                           +---> ECO-059 (CRDT Integration)

ECO-014 (Supervisor Fix) ---> ECO-053 (Contract-Net Types) ---> ECO-054 (CNP Manager)
                         |
                         +---> ECO-055 (Topology Analyzer) ---> ECO-056 (Topology Executor)
```

---

## Implementation Notes

1. **New packages to scaffold:** `@dzipagent/otel` (ECO-015), `@dzipagent/evals` (ECO-062). Both follow the same structure: package.json with peer deps on @dzipagent/core, tsconfig.json extending root, tsup.config.ts for ESM build.

2. **Core import boundary:** All identity, protocol, and registry interfaces live in @dzipagent/core. Implementations of ProtocolAdapter, AgentRegistry, and IdentityResolver that require external deps live in @dzipagent/server or dedicated packages.

3. **Test strategy:** All unit tests use InMemoryBaseStore. LLM-dependent tests (convention extraction, LLM judge) use mock chat models. Integration tests requiring real LLM/database are tagged and run separately.

4. **Backward compatibility:** All new features are additive. Existing consumers of @dzipagent/core, @dzipagent/agent, and @dzipagent/server are unaffected. Identity middleware is opt-in. OTel is a plugin.
