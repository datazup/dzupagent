# Wave 22 — Implementation Tracking

> **Start date**: 2026-04-17  
> **Target**: ≥200 new tests, close 5 gaps  
> **Theme**: Self-Correction Deep + WebSocket Bridge Deep + Memory-IPC Deep + Context Compression Deep + Connectors-Documents Deep

---

## Baseline (post-Wave 21)

| Package | Tests passing |
|---------|---------------|
| `@dzupagent/agent` | 2,817 |
| `@dzupagent/server` | 1,824 |
| `@dzupagent/memory-ipc` | 724 |
| `@dzupagent/context` | 440 |
| `@dzupagent/connectors-documents` | 128 |

---

## Gap Assessment (pre-wave)

| Gap | Prior state | Wave 22 action |
|-----|------------|----------------|
| Self-correction module | 22 files × 7,759 LOC total; thin per-file tests (12–37 each), `self-correcting-node.ts` 210 LOC / 12 tests, `iteration-controller.ts` 247 LOC / 23 tests | Deep expand: 70+ tests |
| Server WebSocket bridge | 13 WS test files, but core ws files have 2–5 tests each; `event-bridge.ts` 4 tests | Deep expand: 55+ tests |
| Memory-IPC deep | `schema.ts`, `cache-delta.ts`, `token-budget.ts`, `phase-memory-selection.ts` each ≤8 tests; `memory-ipc.integration.test.ts` only 3 tests | Deep expand: 45+ tests |
| Context compression deep | `auto-compress.ts` (117 LOC), `progressive-compress.ts` (38 tests), `extraction-bridge.ts` (10 tests), `context.integration.test.ts` (2 tests) — shallow | Deep expand: 40+ tests |
| Connectors-Documents deep | `document-connector.integration.test.ts` (3), `parse-document.test.ts` (3), `split-into-chunks.test.ts` (6) — extremely shallow on core paths | Deep expand: 35+ tests |

---

## Task Summary

| ID | Task | Package | Target Tests | Agent | Status |
|----|------|---------|-------------|-------|--------|
| W22-A1 | Self-correction module deep coverage | `agent` | +70 | dzupagent-agent-dev | pending |
| W22-A2 | WebSocket event bridge deep coverage | `server` | +55 | dzupagent-server-dev | pending |
| W22-B1 | Memory-IPC schema + integration deep | `memory-ipc` | +45 | dzupagent-core-dev | pending |
| W22-B2 | Context compression + extraction deep | `context` | +40 | dzupagent-core-dev | pending |
| W22-B3 | Connectors-Documents ingestion deep | `connectors-documents` | +35 | dzupagent-connectors-dev | pending |

---

## Detailed Task Specs

### W22-A1: Self-Correction Module Deep Coverage

**Goal**: 22 source files, 7,759 LOC total. Most test files have 12–37 tests.  
Focus on the thinnest: `self-correcting-node.ts` (210 LOC / 12 tests), `iteration-controller.ts` (247 LOC / 23 tests), `recovery-feedback.ts` (212 LOC / 13 tests), `self-learning-hook.ts` (216 LOC), `reflection-loop.ts` (391 LOC / 16 tests), `strategy-selector.ts` (378 LOC / 15 tests), `trajectory-calibrator.ts` (397 LOC / 16 tests).

**Files to read first**:
- `packages/agent/src/self-correction/self-correcting-node.ts`
- `packages/agent/src/self-correction/iteration-controller.ts`
- `packages/agent/src/self-correction/recovery-feedback.ts`
- `packages/agent/src/self-correction/reflection-loop.ts`
- `packages/agent/src/self-correction/strategy-selector.ts`
- `packages/agent/src/__tests__/self-correcting-node.test.ts` (gap analysis — 12 tests)
- `packages/agent/src/__tests__/iteration-controller.test.ts` (gap analysis — 23 tests)
- `packages/agent/src/__tests__/recovery-feedback-deep.test.ts` (gap analysis — 13 tests)

**Action**: Create `packages/agent/src/__tests__/self-correction-deep.test.ts` with 70+ tests.

Cover across the thinnest modules:
- `SelfCorrectingNode`: correction trigger on failure, max iterations guard, no-op when success
- `IterationController`: max iterations cap, early exit on convergence, step count tracking, reset
- `RecoveryFeedback`: feedback generated on error, structured format, severity levels, propagation
- `ReflectionLoop`: cycle detection, reflection on partial output, LLM call integration, timeout
- `StrategySelector`: strategy ranking, fallback when preferred fails, confidence scores
- `TrajectoryCalibrator`: drift detection, calibration applied, noop when on-track
- Cross-cutting: all modules emit OTel spans; error types correct; no infinite loops

**Acceptance criteria**: 70+ new tests, all 2817 existing agent tests pass.

---

### W22-A2: WebSocket Event Bridge Deep Coverage

**Goal**: Server WS layer has 13 test files but core files have 2–5 tests each.  
`event-bridge.ts` (4 tests), `ws-node-adapter.ts` (2 tests), `ws-session-manager.ts` (2 tests), `ws-scope-registry.ts` (2 tests), `ws-scoped-control-handler.ts` (2 tests), `ws-control-protocol.ts` (5 tests), `ws-authorization.ts` (5 tests).

**Files to read first**:
- `packages/server/src/ws/` directory — read all WS source files
- `packages/server/src/__tests__/event-bridge.test.ts` (gap — 4 tests)
- `packages/server/src/__tests__/ws-node-adapter.test.ts` (gap — 2 tests)
- `packages/server/src/__tests__/ws-session-manager.test.ts` (gap — 2 tests)
- `packages/server/src/__tests__/ws-authorization.test.ts` (gap — 5 tests)

**Action**: Create `packages/server/src/__tests__/ws-event-bridge-deep.test.ts` with 55+ tests.

Cover:
- EventBridge: DzupEventBus events → WebSocket frame forwarding, event filtering by scope, missed event replay on reconnect, message serialization errors, subscriber cleanup on disconnect
- WsNodeAdapter: upgrade request handling, connection established, ping/pong keepalive, binary frame handling
- WsSessionManager: session creation, session lookup by ID, session expiry, concurrent sessions for same agent
- WsAuthorization: API key validation, unauthorized rejection, scope-based access control, token expiry
- WsControlProtocol: run cancel command, run status query, stream subscribe/unsubscribe
- WsScopedControlHandler: route to correct agent scope, unknown scope → error
- WsScopeRegistry: register/deregister scopes, lookup by scope ID
- Error paths: malformed JSON frame, unknown message type, send on closed socket

**Acceptance criteria**: 55+ new tests, all 1824 existing server tests pass.

---

### W22-B1: Memory-IPC Schema + Integration Deep

**Goal**: `schema.ts` (8 tests), `cache-delta.ts` (7 tests), `token-budget.ts` (8 tests), `phase-memory-selection.ts` (7 tests), `memory-ipc.integration.test.ts` (3 tests) — all extremely thin.

**Files to read first**:
- `packages/memory-ipc/src/schema.ts`
- `packages/memory-ipc/src/cache-delta.ts`
- `packages/memory-ipc/src/token-budget.ts`
- `packages/memory-ipc/src/phase-memory-selection.ts`
- `packages/memory-ipc/src/frames/` directory
- `packages/memory-ipc/src/__tests__/schema.test.ts` (gap — 8 tests)
- `packages/memory-ipc/src/__tests__/memory-ipc.integration.test.ts` (gap — 3 tests)

**Action**: Create `packages/memory-ipc/src/__tests__/memory-ipc-deep.test.ts` with 45+ tests.

Cover:
- Schema: all MemoryFrame fields validated, missing required fields rejected, version field round-trips
- MemoryFrame serialization: Arrow IPC round-trip, large frames, multi-batch
- CacheDelta: delta computed correctly between frames, empty delta when no change, merge two deltas
- TokenBudget: budget exceeded → eviction triggered, budget tracking increments, reset budget
- PhaseMemorySelection: correct memories selected per phase, priority ordering, empty phase
- Integration: write frame → read back → deserialize matches original, multi-agent shared channel
- Error paths: corrupt IPC data, oversized frame, missing schema field

**Acceptance criteria**: 45+ new tests, all 724 existing memory-ipc tests pass.

---

### W22-B2: Context Compression + Extraction Deep

**Goal**: `auto-compress.ts` (117 LOC, shallow), `extraction-bridge.ts` (10 tests), `context.integration.test.ts` (2 tests).

**Files to read first**:
- `packages/context/src/auto-compress.ts` (117 LOC)
- `packages/context/src/extraction-bridge.ts`
- `packages/context/src/progressive-compress.ts`
- `packages/context/src/__tests__/auto-compress-extended.test.ts` (gap — 21 tests)
- `packages/context/src/__tests__/extraction-bridge.test.ts` (gap — 10 tests)
- `packages/context/src/__tests__/context.integration.test.ts` (gap — 2 tests)

**Action**: Create `packages/context/src/__tests__/context-compression-deep.test.ts` with 40+ tests.

Cover:
- AutoCompress: trigger threshold (token count), compress called when over budget, no-op under budget, result token count reduced, message ordering preserved post-compress
- Progressive compression: first pass summaries, second pass further reduces, idempotent on already-compressed
- ExtractionBridge: entities extracted from context, extraction result structured, empty context → []
- Context integration: full pipeline (ingest → compress → extract → retrieve), concurrent compression safe
- Error paths: compression LLM call fails → fallback strategy, extraction timeout

**Acceptance criteria**: 40+ new tests, all 440 existing context tests pass.

---

### W22-B3: Connectors-Documents Ingestion Deep

**Goal**: `document-connector.integration.test.ts` (3 tests), `parse-document.test.ts` (3 tests), `split-into-chunks.test.ts` (6 tests) — extremely shallow on critical ingestion paths.

**Files to read first**:
- `packages/connectors-documents/src/document-connector.ts`
- `packages/connectors-documents/src/parse-document.ts`
- `packages/connectors-documents/src/chunking/` directory
- `packages/connectors-documents/src/parsers/` directory
- `packages/connectors-documents/src/__tests__/document-connector.integration.test.ts` (gap — 3 tests)
- `packages/connectors-documents/src/__tests__/parse-document.test.ts` (gap — 3 tests)

**Action**: Create `packages/connectors-documents/src/__tests__/document-ingestion-deep.test.ts` with 35+ tests.

Cover:
- DocumentConnector: PDF ingest, Markdown ingest, plaintext ingest, unknown type → error
- ParseDocument: title extraction, metadata extraction, body extraction, empty doc → empty content
- Chunking: chunk size respected, overlap correct, single chunk when doc fits, empty doc → []
- Parsers: HTML parser strips tags, Markdown parser preserves headings, binary doc → error
- Integration: parse → chunk → emit chunks sequence, chunk metadata includes source
- Error paths: corrupt file, oversized document, unsupported MIME type

**Acceptance criteria**: 35+ new tests, all 128 existing connectors-documents tests pass.

---

## Progress

| ID | Status | Tests Added | Notes |
|----|--------|-------------|-------|
| W22-A1 | ✅ DONE | **87** | `self-correction-deep.test.ts`. 2904 agent tests pass (was 2817). SelfCorrectingNode (15), AdaptiveIterationController (15), RecoveryFeedback (12), ReflectionLoop (12), StrategySelector (13), TrajectoryCalibrator (12), SelfLearningPipelineHook (8). Exceeded 70 target. |
| W22-A2 | ✅ DONE | **71** | `ws-event-bridge-deep.test.ts`. 1894 server tests pass (was 1824). EventBridge forwarding (12), WsNodeAdapter (10), WsSessionManager (7), WsScopeRegistry (7), WsAuthorization (10), WsControlProtocol (15), ScopedControlHandler (5), E2E flows (3). Exceeded 55 target. |
| W22-B1 | ✅ DONE | **60** | `memory-ipc-deep.test.ts`. 784 memory-ipc tests pass (was 724). Schema (10), Arrow IPC round-trip (8), CacheDelta (9), TokenBudget (8), PhaseMemorySelection (8), shared-channel integration (6), error paths (11). |
| W22-B2 | ✅ DONE | **41** | `context-compression-deep.test.ts`. 481 context tests pass (was 440). AutoCompress threshold/ordering (8), progressive compression levels (7), ExtractionBridge multi-turn (5), full pipeline integration (5), MessageManager edge cases (16). |
| W22-B3 | ✅ DONE | **36** | `document-ingestion-deep.test.ts`. 164 connectors-documents tests pass (was 128). DocumentConnector ingestion (7), ParseDocument (5), chunking invariants (5), parsers (4), integration (3), ConnectorContract (4), SupportedTypes (3), chunking guards (5). |
| **Total** | — | **295 / ≥200** | All 5 tasks complete. Exceeded target by 47.5%. |

---

## Wave 23 Candidates (preview)

- `@dzupagent/evals` — LLM-judge scorer deep + benchmark runner deep
- `@dzupagent/codegen` — Multi-edit coherence + AST repo map deep
- `@dzupagent/agent-adapters` — Adapter registry + circuit breaker deep
- `@dzupagent/core` — Plugin lifecycle + MCP client invocation deep
- `@dzupagent/scraper` — HTTP + Puppeteer extraction deep
