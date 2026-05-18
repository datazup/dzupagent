# DzupAgent Gap Analysis

Date: 2026-05-17

## Method

This analysis reviewed repository guidance, root package scripts, local package metadata, explicit source TODO/stub markers, package architecture risk sections, and current docs. It did not run full validation because the requested output is planning documentation, not implementation closeout.

## Gap Matrix

| ID | Severity | Area | Current State | Gap | Primary Packages | Validation |
| --- | --- | --- | --- | --- | --- | --- |
| DZ-GAP-001 | High | Remote memory | `HttpMemoryClient` is exported but all CRUD methods throw `NotImplementedError`. `IpcMemoryClient` remote endpoint mode throws unless `backingService` is supplied. | Remote memory is named as a framework primitive but not actually usable outside in-process paths. | `@dzupagent/memory`, `@dzupagent/memory-ipc`, `@dzupagent/agent-types` | package tests, contract matrix, domain-boundary check |
| DZ-GAP-002 | High | MCP transport | Stdio transport is request-spawn based; SSE discovery uses HTTP semantics; reliability/pool helpers are standalone; manager persistence is in-memory only. | Production MCP users lack explicit persistent transport semantics and safe default reliability composition. | `@dzupagent/core`, `@dzupagent/test-utils` | MCP tests, terminal-tool guard, domain-boundary check |
| DZ-GAP-003 | High | Plugin runtime | Manifest validation is shallow; unload/dispose is missing; duplicate names are last-write-wins; `entryPoint` import is not implemented. | Dynamic plugin lifecycle is not safe enough for long-lived processes or untrusted plugin catalogs. | `@dzupagent/core` | plugin tests, typecheck, domain-boundary check |
| DZ-GAP-004 | Medium-High | Events | `DzupEvent` is manually expanded; forwarding uses casts; docs and dispatch semantics disagree; log append failures are swallowed. | Event contracts can drift and observability failures can disappear. | `@dzupagent/core`, `@dzupagent/agent`, `@dzupagent/server` | event tests, package export artifacts |
| DZ-GAP-005 | Medium-High | OTEL/governance | In-memory metric/audit stores can grow; cost attribution has zero-cost placeholders; threshold state is shared across dimensions; audit taxonomy has unmapped categories. | Observability is useful for local/test flows but incomplete for production governance and billing signals. | `@dzupagent/otel`, `@dzupagent/core` | OTEL tests, typecheck, docs refresh |
| DZ-GAP-006 | Medium | Human contact | Channel resolution documents user-profile preference but implementation skips it. | HITL contact routing contract is incomplete and can force app-local workaround logic. | `@dzupagent/agent`, `@dzupagent/core` | tools tests, agent typecheck |
| DZ-GAP-007 | Medium | Server compatibility | Server docs report health version drift and unexported `runtime`/`compat` source facades. | Compatibility surfaces can mislead consumers and weaken public API discipline. | `@dzupagent/server` | server tests, server-api-surface, package-tiers |
| DZ-GAP-008 | Low-Medium | Large hotspots | Large barrels and runtime files concentrate public API and behavior. | Review and drift cost is high, but not every large file is a defect. | `@dzupagent/core`, `@dzupagent/agent`, `@dzupagent/agent-adapters`, `@dzupagent/flow-compiler`, `@dzupagent/server` | package-scoped checks after narrow refactors |
| DZ-GAP-009 | Medium-High | Flow lowering | `flow-document-lowering-contract.md` marks planning DAG/team-runtime targets, phase-level team lowering, and checkpoint-to-resume mapping as future-only. | Flow/orchestration docs can imply broader runtime lowering than exists. | `@dzupagent/flow-compiler`, `@dzupagent/agent`, `@dzupagent/runtime-contracts` | flow compiler tests, workflow/orchestration tests |
| DZ-GAP-010 | High | Agent auth capabilities | `AgentAuthConfig.requiredCapabilities` is documented but not used by `AgentAuth`. Replay and public-key stores are process-local/in-memory. | Capability authorization can look configured while not being enforced. | `@dzupagent/agent`, `@dzupagent/core` | agent-auth tests, typecheck |
| DZ-GAP-011 | Medium | Document connector validation/telemetry | Document connector docs list invalid `maxChunkSize`/`overlap` not explicitly validated and no package-level parse/chunk telemetry. | Bad chunk options can reach implementation paths and operators lack latency/failure telemetry. | `@dzupagent/connectors-documents` | connector tests, typecheck |
| DZ-GAP-012 | Medium | Gitleaks allowlist governance | Latest dirty tree adds anchored allowlist regexes, `check:gitleaks-allowlist`, and security workflow validation. | This is a positive risk reduction, but it must be treated as a release gate and covered in verification docs so future allowlist widening remains constrained. | root `package.json`, `.gitleaks.toml`, `scripts/check-gitleaks-allowlist.mjs`, `.github/workflows/security.yml` | script unit tests, `yarn check:gitleaks-allowlist`, security workflow |

## Gaps That Are Already Mitigated

- Security audit findings around browser navigation SSRF, non-API route rate limiting/RBAC, body-size limits, WebSocket unscoped subscriptions, sandbox local fallback, and SQL tag filtering are documented as resolved in current security audit status.
- Boundary enforcement is not absent; root scripts include package tiers, domain boundaries, server API surface, security audit status, terminal tool event guards, package export artifacts, and strict verification.
- Every current `packages/*` package exposes build/typecheck/test/lint scripts.
- The latest dirty tree adds a gitleaks allowlist validation script and wires it into `verify`, `verify:strict`, and the security workflow. Treat this as an already-started hardening slice, not as missing functionality.

## Challenged / Reclassified TODOs

- `packages/playground` TODOs are maintenance/documentation drift only. Do not turn them into a new UI implementation packet unless the user explicitly asks to revive the dedicated playground package.
- Large barrel files are not defects by themselves. They should only trigger work when they hide public API drift, circular dependencies, or untested runtime behavior.
- Flow lowering gaps are real, but they should be scoped as contract/implementation choices, not patched by ad hoc bridges inside consuming apps.
- Remote memory and capability authorization are higher-impact than most generated architecture TODOs because they expose configured public concepts that currently do not execute the implied behavior.

## Residual Risk Themes

### Contract Visibility Risk

Several public or exported names imply more runtime support than exists. Examples include remote memory clients, SSE MCP behavior, plugin `entryPoint`, and source facades not exported as public subpaths.

### Fail-Soft Runtime Risk

MCP, event logging, and OTEL paths intentionally fail softly in several places. Fail-soft behavior is often correct for framework resilience, but operators need diagnostics and explicit status fields so failures do not become invisible.

### In-Memory Default Risk

In-memory managers and stores are valid test/dev primitives. The risk is documentation or API shape that makes them look like production persistence.

### Drift Across Docs, Exports, And Runtime

DzupAgent has many generated and package-local architecture docs. The current priority is to link runtime behavior, public exports, and docs through checks, not to manually update prose after every change.
