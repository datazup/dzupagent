# DzupAgent Feature Catalog For Implementation

Date: 2026-05-17
Purpose: name every feature or capability that should be added, changed, removed, or explicitly deferred as part of the TODO/risk closeout.

## Feature Status Legend

- `add`: new behavior or API that does not exist today.
- `change`: existing behavior/API must be corrected or narrowed.
- `document`: behavior exists or is intentionally absent, but docs/contracts must be clarified.
- `defer`: intentionally not implemented now; keep as roadmap-only with explicit boundaries.
- `remove-or-hide`: public-facing shape should be removed, renamed, or hidden until real support exists.

## Feature Catalog

| Feature ID | Action | Feature / Capability | Current Evidence | Target State | Owning Packages | Related Gaps | Validation |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DZ-FEAT-001 | add/change | HTTP memory client CRUD | `HttpMemoryClient.get/put/delete` throw `NotImplementedError`. | Implement CRUD over documented HTTP protocol with typed errors, auth header, timeout, abort, and tenant scope validation. | `@dzupagent/memory`, `@dzupagent/agent-types` | DZ-GAP-001 | memory contract tests |
| DZ-FEAT-002 | document/defer | Remote IPC memory endpoint | `IpcMemoryClient` endpoint mode is future-only; backing service works. | Keep endpoint mode explicitly unsupported until frame protocol exists; document backing-service mode as implemented. | `@dzupagent/memory-ipc` | DZ-GAP-001 | memory-ipc tests |
| DZ-FEAT-003 | change/add | MCP transport capability reporting | MCP stdio request-spawns per operation; SSE routes through HTTP semantics. | Make transport behavior explicit and programmatically inspectable. Unsupported semantics fail with typed errors. | `@dzupagent/core` | DZ-GAP-002 | MCP tests |
| DZ-FEAT-004 | add | Persistent MCP stdio session | No persistent stdio transport is currently wired. | Add lifecycle-managed persistent stdio sessions or keep as unsupported with clear diagnostics. | `@dzupagent/core` | DZ-GAP-002 | stdio lifecycle tests |
| DZ-FEAT-005 | add/change | MCP reliability default composition | Reliability and pool helpers exist but are not auto-wired. | Add optional `MCPClient` config to compose retry/circuit/pool behavior without forcing it globally. | `@dzupagent/core` | DZ-GAP-002 | reliability tests |
| DZ-FEAT-006 | add | MCP persistent manager store | `InMemoryMcpManager` is memory-only/test-focused. | Add storage interface and keep in-memory as local/test implementation. | `@dzupagent/core` | DZ-GAP-002 | manager store contract tests |
| DZ-FEAT-007 | change | Plugin manifest validation | Plugin manifest validation is shallow. | Validate semver, entry point path safety, item arrays, source enum, and required fields. | `@dzupagent/core` | DZ-GAP-003 | plugin parser tests |
| DZ-FEAT-008 | change | Duplicate plugin handling | Duplicate discovered names are last-write-wins. | Fail with conflict diagnostics unless explicit override is configured. | `@dzupagent/core` | DZ-GAP-003 | duplicate manifest tests |
| DZ-FEAT-009 | add | Plugin unload/dispose lifecycle | Event subscriptions are not tracked for unsubscription. | Add disposer tracking, `unregisterPlugin`, and `disposePlugin`. | `@dzupagent/core` | DZ-GAP-003 | event unsubscribe tests |
| DZ-FEAT-010 | document/defer | Plugin `entryPoint` runtime loading | Discovery is manifest-only; `entryPoint` import is not implemented. | Either implement safe loader or rename/document `entryPoint` as metadata-only until loader exists. | `@dzupagent/core` | DZ-GAP-003 | plugin docs/tests |
| DZ-FEAT-011 | add/change | Central event registry | `DzupEvent` is manually expanded and some forwarding casts bypass checking. | Create registry-driven event descriptors and derive event union/docs from them. | `@dzupagent/core`, `@dzupagent/agent`, `@dzupagent/server` | DZ-GAP-004 | event contract tests |
| DZ-FEAT-012 | add | Event-log append failure visibility | `EventLogSink.attach()` swallows append failures. | Add failure callback or error event while preserving fail-soft producer behavior. | `@dzupagent/core` | DZ-GAP-004 | event sink tests |
| DZ-FEAT-013 | change | OTEL in-memory retention | Metric/audit stores can grow in long-lived processes. | Add bounded retention defaults/config and pruning tests. | `@dzupagent/otel` | DZ-GAP-005 | otel tests |
| DZ-FEAT-014 | change | Real cost attribution | `CostAttributor` records zero-cost placeholder entries. | Wire real usage/token sources or mark placeholders as examples only. | `@dzupagent/otel`, `@dzupagent/core` | DZ-GAP-005 | cost attribution tests |
| DZ-FEAT-015 | add/change | Audit category coverage | Audit categories include values not emitted by current mapping. | Map `safety_event` and `config_change`, or remove unsupported categories from public expectation. | `@dzupagent/otel` | DZ-GAP-005 | audit mapping tests |
| DZ-FEAT-016 | add | HITL preference resolver | Human contact tool skips user-profile preferred channel. | Add app-neutral preference resolver injection. | `@dzupagent/agent`, `@dzupagent/core` | DZ-GAP-006 | tools tests |
| DZ-FEAT-017 | change | Server health version source | Health route returns stale version. | Use single source of truth for server version. | `@dzupagent/server` | DZ-GAP-007 | server tests |
| DZ-FEAT-018 | change/document | Server runtime/compat subpaths | Source facades exist but package exports do not expose them. | Either export intentionally with allowlist or mark/remove as internal. | `@dzupagent/server` | DZ-GAP-007 | server API surface check |
| DZ-FEAT-019 | add | Flow-to-planning lowering contract | Flow docs mark planning DAG/team target as future-only. | Define contract and implement one target after fixtures are stable. | `@dzupagent/flow-compiler`, `@dzupagent/agent`, `@dzupagent/runtime-contracts` | DZ-GAP-009 | flow fixtures/tests |
| DZ-FEAT-020 | add/change | Agent capability authorization | `requiredCapabilities` is configured but not enforced. | Enforce capabilities or remove config until supported. | `@dzupagent/agent` | DZ-GAP-010 | agent-auth tests |
| DZ-FEAT-021 | add | Durable replay/key stores | Replay and public keys are process-local/in-memory. | Add optional store interfaces for distributed deployments. | `@dzupagent/agent`, `@dzupagent/core` | DZ-GAP-010 | auth store tests |
| DZ-FEAT-022 | change | Document connector input validation | Invalid chunk options are not explicitly validated. | Reject invalid `maxChunkSize`, `overlap`, MIME, and parser limits at boundary. | `@dzupagent/connectors-documents` | DZ-GAP-011 | connector tests |
| DZ-FEAT-023 | add | Document connector telemetry | No package-level parse/chunk latency/failure telemetry. | Add optional callback/event hooks without heavy dependency. | `@dzupagent/connectors-documents` | DZ-GAP-011 | telemetry tests |
| DZ-FEAT-024 | document/change | Gitleaks allowlist governance | Latest tree adds validator and verify wiring. | Document allowlist rules and keep validator in security/verify lanes. | root scripts/workflows | DZ-GAP-012 | script tests |

## Explicit Deferrals

| Deferred Item | Reason | Required Before Revival |
| --- | --- | --- |
| Dedicated `packages/playground` UI revival | Framework guidance says server/playground are maintenance-only. | Explicit user/product request plus owner app boundary decision. |
| Generic app product workflows inside DzupAgent server | Product behavior belongs in consuming apps first. | Named reusable primitive with consumer evidence. |
| Remote IPC memory transport | Wire protocol not finalized. | Protocol docs and contract fixtures. |
| Full Flow-to-Team runtime lowering | Semantics are not yet proven. | Flow-to-planning contract and fixtures. |
