# DzupAgent Architecture Change Inventory

Date: 2026-05-17
Purpose: enumerate architecture decisions, code boundaries, exports, docs, and validation gates that must be updated to close the risk plan.

## Architecture Decision Inventory

| Decision ID | Status | Decision | Update Type | Files / Surfaces To Update | Validation |
| --- | --- | --- | --- | --- | --- |
| DZ-ADR-001 | Proposed | Remote memory protocol before transport implementation. | Add protocol doc, contract tests, HTTP client implementation. | `packages/memory`, `packages/memory-ipc`, `packages/agent-types`, package docs. | memory tests, domain boundaries |
| DZ-ADR-002 | Proposed | MCP transport semantics must be explicit. | Change transport types/docs and unsupported behavior. | `packages/core/src/mcp/*`, MCP docs/tests. | core MCP tests |
| DZ-ADR-003 | Proposed | Plugin discovery must be safe before dynamic loading. | Add manifest schema, lifecycle, conflict behavior. | `packages/core/src/plugin/*`, plugin docs/tests. | core plugin tests |
| DZ-ADR-004 | Proposed | Events need a central registry. | Add event descriptor registry and generation/derivation. | `packages/core/src/events/*`, event producers in agent/server. | event tests, typecheck |
| DZ-ADR-005 | Proposed | OTEL in-memory sinks need retention and truthful cost semantics. | Add retention config and real cost source integration. | `packages/otel`, core usage events. | otel tests |
| DZ-ADR-006 | Proposed | HITL preference resolution is a framework extension point. | Add resolver interface, not app user models. | `packages/agent/src/tools/*`, core tool types. | agent tools tests |
| DZ-ADR-007 | Proposed | Server compatibility facades need explicit public API status. | Decide export-map status or mark internal. | `packages/server/package.json`, `config/public-api-allowlists.json`, server docs. | server API surface, package tiers |
| DZ-ADR-008 | Proposed | Flow-to-planning lowering needs explicit contract. | Add contract and target fixtures before runtime lowering. | `packages/flow-compiler`, `packages/agent`, `packages/runtime-contracts`. | flow tests |
| DZ-ADR-009 | Proposed | Agent capability authorization must be enforced or removed. | Add enforcement and combined verification helper. | `packages/agent/src/security/*`. | agent-auth tests |
| DZ-ADR-010 | Proposed | Gitleaks allowlist governance is a first-class verification gate. | Document and preserve verify/security wiring. | `.gitleaks.toml`, `scripts/check-gitleaks-allowlist.mjs`, `.github/workflows/security.yml`, docs. | script tests |
| DZ-ADR-011 | Proposed | Document connector inputs need validation and telemetry. | Add connector validation and optional telemetry. | `packages/connectors-documents`. | connector tests |

## Public API / Export Updates To Decide

| Surface | Current Risk | Decision Needed | Default Recommendation |
| --- | --- | --- | --- |
| `@dzupagent/memory` root export of `HttpMemoryClient` | Exported class throws for all CRUD operations. | Implement, deprecate, or mark transitional in docs. | Implement HTTP client after protocol doc. |
| `@dzupagent/memory-ipc` endpoint mode | Config suggests endpoint, but remote mode throws. | Keep as future-only or implement. | Keep future-only until protocol exists. |
| `@dzupagent/server/runtime` and `@dzupagent/server/compat` | Source facades exist but not package exports. | Public subpath or internal implementation detail. | Prefer internal unless consumers exist. |
| MCP SSE transport | Name can imply stream semantics. | Implement stream or unsupported error. | Fail closed until true SSE exists. |
| Plugin `entryPoint` | Can imply runtime loading. | Safe loader or metadata-only. | Metadata-only until loading policy exists. |
| `AgentAuthConfig.requiredCapabilities` | Config exists but not enforced. | Enforce or remove. | Enforce with tests. |

## Documentation Updates Required

- Add package-local remote memory protocol documentation.
- Update MCP architecture docs with transport capability matrix.
- Update plugin docs with lifecycle and manifest validation rules.
- Generate or add event catalog documentation after registry work.
- Update OTEL docs with retention and cost semantics.
- Update HITL tool docs with resolver injection and channel order.
- Update server API surface docs after runtime/compat decision.
- Update flow lowering contract after ADR and fixtures.
- Add gitleaks allowlist rules to security/contribution docs.
- Update connectors-documents docs for validation and telemetry hooks.

## Validation Gate Updates

- Keep `check:gitleaks-allowlist` in `verify`, `verify:strict`, and security workflow.
- Add memory contract tests to the relevant package test suites.
- Add MCP transport capability tests under `@dzupagent/core`.
- Add plugin manifest/lifecycle tests under `@dzupagent/core`.
- Add capability auth tests under `@dzupagent/agent`.
- Add flow lowering fixtures under `@dzupagent/flow-compiler` or a shared fixture folder.
- Add connector validation/telemetry tests under `@dzupagent/connectors-documents`.
