# DzupAgent Implementation Roadmap

Date: 2026-05-17

## Sequencing Principles

- Keep packages independently reviewable.
- Run package-scoped checks before repo-wide checks.
- Extend existing governance gates rather than bypassing them.
- Do not use `packages/server` or `packages/playground` for new product behavior.

## Packet DZ-P0: Rebaseline Current State

Priority: Required before implementation

### Tasks

1. Capture `git status --short`.
2. Re-run source TODO scan excluding docs/tests/dist.
3. Run fast governance checks.
4. Classify current failures as blockers, unrelated drift, or environment-gated.

### Commands

```bash
git status --short
rg -n --hidden --glob '!**/node_modules/**' --glob '!**/dist/**' --glob '!**/.turbo/**' --glob '!**/.git/**' "TODO|FIXME|XXX|HACK|not implemented|NotImplemented" packages --glob '!**/*.test.ts' --glob '!**/__tests__/**'
yarn check:security-audit-status
yarn check:gitleaks-allowlist
yarn check:package-tiers
yarn check:domain-boundaries
yarn check:server-api-surface
yarn check:terminal-tool-event-guards
```

### Acceptance Criteria

- Baseline is documented before code changes.
- Any unrelated red gates are named and separated from the packet.

## Packet DZ-P1: Memory Transport Contract Completion

Priority: High
Dependencies: DZ-P0
Owner packages: `@dzupagent/memory`, `@dzupagent/memory-ipc`, `@dzupagent/agent-types`

### Tasks

1. Add `docs/memory-transport-protocol.md` or package-local equivalent.
2. Define schemas/types for CRUD, batch, health, and errors.
3. Implement `HttpMemoryClient` with fetch injection, timeout, auth, scope validation, and typed errors.
4. Add a contract test harness that can be reused for future backends.
5. Update `memory-ipc` remote endpoint docs to point at the protocol, but do not implement remote IPC unless frame format is stable.

### Acceptance Criteria

- `HttpMemoryClient.get/put/delete` no longer throw stub errors for normal requests.
- Contract tests prove identical behavior across in-memory and HTTP mock paths.
- IPC endpoint mode remains explicitly unsupported or is implemented with the same contract.

## Packet DZ-P2: MCP Transport Semantics

Priority: High
Dependencies: DZ-P0
Owner package: `@dzupagent/core`

### Tasks

1. Add transport capability types and docs.
2. Make request-spawn stdio explicit.
3. Implement persistent stdio session or fail closed for unsupported persistent mode.
4. Implement real SSE stream handling or typed unsupported errors.
5. Add optional reliability/pool wiring in `MCPClient` config.
6. Add manager persistence interface.

### Acceptance Criteria

- Consumers can determine transport semantics programmatically.
- Unsupported SSE/persistent modes cannot silently behave like HTTP/request-spawn.
- Tests cover process exit, stderr/stdout, timeout, cancellation, and retry/circuit behavior.

## Packet DZ-P3: Plugin Lifecycle Hardening

Priority: High
Dependencies: DZ-P0
Owner package: `@dzupagent/core`

### Tasks

1. Add strict manifest schema.
2. Replace duplicate last-write-wins with conflict errors.
3. Track event subscription disposers.
4. Add unload/dispose APIs.
5. Decide `entryPoint` runtime loading status and implement or remove false promise.

### Acceptance Criteria

- Invalid manifests fail early with diagnostics.
- Plugin unload prevents future event handler calls.
- Duplicate names cannot shadow silently.

## Packet DZ-P4: Events And OTEL Drift Reduction

Priority: Medium-High
Dependencies: DZ-P0
Owner packages: `@dzupagent/core`, `@dzupagent/otel`

### Tasks

1. Add central event registry.
2. Derive event union/docs from registry.
3. Replace event forwarding casts.
4. Add append failure observability to `EventLogSink`.
5. Add OTEL retention controls and real cost attribution integration.
6. Complete audit taxonomy mapping.

### Acceptance Criteria

- Event producers and docs use the same declared event catalog.
- In-memory stores have bounded retention defaults or explicit opt-out.
- Cost/token warning state cannot suppress the other dimension.

## Packet DZ-P5: HITL Channel Preference Resolver

Priority: Medium
Dependencies: DZ-P0
Owner packages: `@dzupagent/agent`, `@dzupagent/core`

### Tasks

1. Define resolver interface.
2. Inject resolver in agent/run config.
3. Wire documented channel resolution order.
4. Add regression tests.

### Acceptance Criteria

- Resolution order matches documentation.
- No app user model leaks into DzupAgent.

## Packet DZ-P6: Server Compatibility Cleanup

Priority: Medium
Dependencies: DZ-P0
Owner package: `@dzupagent/server`

### Tasks

1. Fix health version source.
2. Decide `runtime` and `compat` subpath status.
3. Update exports/allowlists or internal docs accordingly.
4. Regenerate server API surface docs.

### Acceptance Criteria

- Health/version output has a single source of truth.
- `check:server-api-surface` and `check:package-tiers` are green.

## Packet DZ-P7: Docs And Architecture Refresh

Priority: Medium
Dependencies: packets that change behavior
Owner packages: touched packages

### Tasks

1. Update package architecture docs for changed packages.
2. Update TypeDoc/API docs only for exported API changes.
3. Add changelog or migration notes for public contract changes.

### Acceptance Criteria

- Docs describe implemented behavior, not planned behavior.
- Public API changes have migration notes.

## Packet DZ-P8: Flow-To-Planning Lowering Contract

Priority: Medium-High
Dependencies: DZ-P0
Owner packages: `@dzupagent/flow-compiler`, `@dzupagent/agent`, `@dzupagent/runtime-contracts`

### Tasks

1. Convert the future-only flow lowering notes into a formal contract document.
2. Define the intermediate shape for Flow-to-ExecutionPlan and/or Flow-to-TeamDefinition lowering.
3. Add fixtures for sequence, branch, parallel, memory, checkpoint, and delegation examples.
4. Implement only one target first, preferably planning DAG if the contract is stable.
5. Add explicit unsupported-node diagnostics.

### Acceptance Criteria

- Existing flow lowerers keep passing.
- New target fixtures prove deterministic ID/dependency preservation.
- Unsupported team/checkpoint semantics fail clearly instead of silently degrading.

## Packet DZ-P9: Agent Capability Authorization Enforcement

Priority: High
Dependencies: DZ-P0
Owner package: `@dzupagent/agent`

### Tasks

1. Define signed capability claim semantics.
2. Enforce `requiredCapabilities` in `AgentAuth`.
3. Add a combined signature/replay/capability verification helper.
4. Add optional durable replay/public-key store interfaces.
5. Add regression tests for missing and insufficient capabilities.

### Acceptance Criteria

- `requiredCapabilities` is either enforced or removed from public config.
- Tests prove capability failures cannot pass signature-only verification.

## Packet DZ-P10: Gitleaks Allowlist Governance Closeout

Priority: Medium
Dependencies: DZ-P0
Owner files: `.gitleaks.toml`, `scripts/check-gitleaks-allowlist.mjs`, `.github/workflows/security.yml`, root `package.json`

### Tasks

1. Run the new allowlist validator and its unit tests.
2. Document allowlist rules in security or contribution docs.
3. Consider requiring rationale/owner metadata if allowlists grow.
4. Keep the gate wired into `verify`, `verify:strict`, and security CI.

### Acceptance Criteria

- All allowlist path regexes are anchored.
- Invalid or unanchored entries fail before gitleaks runs.
- The verification docs list `check:gitleaks-allowlist`.

## Packet DZ-P11: Document Connector Validation And Telemetry

Priority: Medium
Dependencies: DZ-P0
Owner package: `@dzupagent/connectors-documents`

### Tasks

1. Add explicit validation for negative/zero/invalid chunk options.
2. Confirm output truncation is documented in returned metadata or warning fields.
3. Add optional parse/chunk latency and failure telemetry callback.
4. Add tests for validation and telemetry behavior.

### Acceptance Criteria

- Invalid chunk settings fail before processing.
- Operators can observe parse/chunk failures without wrapping every call manually.
