# Sandbox Architecture (`@dzupagent/codegen`)

This document describes the architecture of `packages/codegen/src/sandbox`, including:

- features and responsibilities
- execution flows
- usage patterns and examples
- cross-package references
- test coverage and notable gaps

## 1. Scope And Design Goals

The sandbox subsystem provides execution isolation for generated code and validation tasks. It is designed around a small interface (`SandboxProtocol`) plus multiple interchangeable backends:

- local container execution (`DockerSandbox`)
- cloud container/VM execution (`E2BSandbox`, `FlySandbox`)
- Kubernetes pod execution (`K8sPodSandbox`)
- in-memory/test execution (`MockSandbox`)
- in-process WASM execution and FS/capability primitives (`wasm/*`)

Around that core, there are optional operational layers:

- security policies/hardening (`permission-tiers.ts`, `security-profile.ts`, `sandbox-hardening.ts`)
- pooling and reset strategies (`pool/*`)
- volume lifecycle abstraction (`volumes/*`)
- tamper-evident audit trail (`audit/*`)

## 2. Module Map

### 2.1 Core Protocols

- `sandbox-protocol.ts`
  - Base contract: `execute`, `uploadFiles`, `downloadFiles`, `cleanup`, `isAvailable`.
  - Shared by Docker, cloud, K8s, and mock providers.
- `sandbox-protocol-v2.ts`
  - Extends base protocol with long-lived sessions and streaming:
    - `startSession`
    - `executeStream`
    - `exposePort`
    - `stopSession`

### 2.2 Provider Factory

- `sandbox-factory.ts`
  - `createSandbox(config)` selects one provider from:
    - `docker`
    - `e2b`
    - `fly`
    - `mock`
  - Returns `SandboxProtocol` (not `SandboxProtocolV2`).

### 2.3 Providers

- `mock-sandbox.ts`
  - In-memory implementation for tests and deterministic simulations.
  - Supports command-result matching (`string` and `RegExp`).
- `docker-sandbox.ts`
  - Local Docker-backed implementation.
  - Supports one-shot execution and full V2 session APIs.
  - Has secure mode (default) and preview mode.
- `e2b-sandbox.ts`
  - E2B API adapter (REST, no SDK dependency).
  - Lazy sandbox creation on first `execute`.
- `fly-sandbox.ts`
  - Fly Machines adapter (REST, no SDK dependency).
  - Lazy machine creation on first `execute`.
- `k8s/k8s-sandbox.ts`
  - K8s CRD/operator-backed sandbox (`AgentSandbox` custom resource).

### 2.4 Security Controls

- `permission-tiers.ts`
  - High-level trust tiers to Docker flags.
- `security-profile.ts`
  - Multi-domain profile model (network, resources, FS, process limits).
- `sandbox-hardening.ts`
  - Low-level hardening flags (seccomp/caps/pids/fs ACL/network defaults).
  - Escape-attempt command pattern detector.

### 2.5 Operational Extensions

- `pool/*`
  - Generic pool with pre-warm, max-size, waiting queue, idle eviction, optional health checks.
  - Reset strategies:
    - Docker reset (wipe paths)
    - Cloud reset (force recreate)
- `volumes/*`
  - Volume abstraction and in-memory manager for mount argument generation and cleanup policies.
- `audit/*`
  - Decorator (`AuditedSandbox`) that records actions into hash-chained store.
  - In-memory audit store with integrity verification.

### 2.6 WASM Subsystem

- `wasm/wasi-fs.ts`
  - In-memory hierarchical filesystem with serialization.
- `wasm/capability-guard.ts`
  - Capability gating (`fs-read`, `fs-write`, etc.).
- `wasm/wasm-sandbox.ts`
  - QuickJS-based execution path (optional dependency), plus FS upload/download and resource limits.
- `wasm/ts-transpiler.ts`
  - `esbuild-wasm` transpilation (optional) with regex fallback.
- `wasm/sandbox-errors.ts`
  - Typed errors for resource, timeout, and access violations.

## 3. Feature Set

### 3.1 Isolation Backends

- One interface for local, cloud, and K8s execution targets.
- Read/write file staging model via `uploadFiles` and `downloadFiles`.
- Timeout-aware command execution (`timedOut` in `ExecResult`).

### 3.2 Session/Preview Support (V2)

- Long-lived sessions with stream-based process output.
- Port exposure contract for preview tools.
- Current concrete V2 provider: `DockerSandbox`.

### 3.3 Security Layers

- Tiered trust presets (`read-only`, `workspace-write`, `full-access`).
- Security profiles (`minimal`, `standard`, `strict`, `paranoid`).
- Hardening helpers for Docker flags:
  - no-new-privileges
  - seccomp syscall deny flags
  - cap-drop/cap-add
  - pid limits
  - network lockdown default when no egress rules are defined

### 3.4 Operational Reliability

- Reusable pool with contention handling (`PoolExhaustedError`).
- Idle eviction and min-idle pre-warm.
- Audit trail with chain verification (`verifyChain`).
- Secret redaction in command logs (`redactSecrets`).

### 3.5 WASM Runtime Guardrails

- Capability-based FS access.
- Path allowlist and traversal normalization checks.
- Output truncation limits.
- Explicit resource-limit configuration and error types.

## 4. Execution Flows

### 4.1 Standard Command Flow (Protocol V1)

1. Caller creates provider (`createSandbox(...)` or direct constructor).
2. `uploadFiles(snapshot)` materializes workspace.
3. `execute(command, { cwd, timeoutMs })` runs command.
4. `downloadFiles(paths)` optionally syncs results.
5. `cleanup()` tears down ephemeral resources.

Primary in-package orchestrator: `vfs/workspace-runner.ts`.

### 4.2 Preview Session Flow (Protocol V2)

1. `startSession(...)` creates/reuses long-lived runtime.
2. `exposePort(sessionId, port)` prepares external URL.
3. `executeStream(sessionId, command)` streams `stdout`/`stderr`/`exit`.
4. Caller reports health based on first stream signals.
5. `stopSession(sessionId)` ends container session.

Primary in-package consumer: `tools/preview-app.tool.ts`.

### 4.3 K8s Operator Flow

1. `K8sPodSandbox` creates `AgentSandbox` CRD.
2. Waits for `Ready` phase via `K8sClient.waitForPhase(...)`.
3. Executes commands in provisioned pod via K8s exec API.
4. Deletes CRD during cleanup.

### 4.4 Audited Decorator Flow

1. Wrap any `SandboxProtocol` with `AuditedSandbox`.
2. Every action appends hash-chained entry (`execute/upload/download/cleanup`).
3. Command strings are redacted before persistence.
4. Consumers can retrieve trail and verify chain integrity.

## 5. Usage Patterns And Examples

### 5.1 Basic Provider Selection

```ts
import { createSandbox } from '@dzupagent/codegen'

const sandbox = createSandbox({
  provider: 'docker',
  docker: { timeoutMs: 60_000, previewMode: false },
})
```

### 5.2 Workspace Execution + Sync Back

```ts
import { VirtualFS, WorkspaceRunner, MockSandbox } from '@dzupagent/codegen'

const vfs = new VirtualFS({ 'src/index.ts': 'export const x = 1' })
const runner = new WorkspaceRunner(new MockSandbox())

const result = await runner.run(vfs, {
  command: 'npm test',
  timeoutMs: 30_000,
  syncBack: true,
})
```

### 5.3 Preview App Tool (V2)

```ts
import { DockerSandbox, createPreviewAppTool } from '@dzupagent/codegen'

const sandbox = new DockerSandbox({ previewMode: true, timeoutMs: 60_000 })
const tool = createPreviewAppTool(sandbox)

const raw = await tool.invoke({ command: 'npm run dev', port: 3000 })
const preview = JSON.parse(raw)
```

### 5.4 Audited Execution

```ts
import { MockSandbox, AuditedSandbox, InMemoryAuditStore } from '@dzupagent/codegen'

const store = new InMemoryAuditStore()
const sandbox = new AuditedSandbox({
  sandbox: new MockSandbox(),
  store,
  sandboxId: 'sb-1',
  runId: 'run-42',
})

await sandbox.execute('echo hello')
const trail = await sandbox.getAuditTrail()
```

### 5.5 WASM Filesystem + Guardrails

```ts
import { WasmSandbox } from '@dzupagent/codegen'

const wasm = new WasmSandbox({
  capabilities: ['fs-read', 'fs-write', 'stdout', 'stderr'],
  resourceLimits: {
    allowedPaths: ['/work'],
    maxOutputBytes: 2048,
  },
})

await wasm.uploadFiles({ '/work/main.ts': 'console.log("ok")' })
```

## 6. Practical Use Cases

- Safe validation loops for generated code (lint/test/typecheck) without mutating host FS directly.
- Preview environments for generated apps using long-lived session + exposed ports.
- Deterministic unit/integration tests with `MockSandbox`.
- Multi-tenant or policy-driven execution with explicit trust levels/hardening profiles.
- Auditable execution trails for compliance/debugging.
- Lightweight local execution for constrained scenarios via WASM FS/capability model.

## 7. References In Other Packages

Direct cross-package consumption of this sandbox stack is currently concentrated in `@dzupagent/evals`:

- `packages/evals/src/contracts/suites/sandbox-contract.ts`
  - Defines a contract suite using the `SandboxProtocol` shape.
  - Verifies protocol compliance for any adapter.
- `packages/evals/src/__tests__/sandbox-contracts.test.ts`
  - Dynamically imports `MockSandbox` and `DockerSandbox` from `@dzupagent/codegen`.
  - Runs required/recommended sandbox conformance checks.
  - Skips Docker-specific checks when Docker is unavailable.

Inside `@dzupagent/codegen`, sandbox is also consumed by:

- `vfs/workspace-runner.ts` (`SandboxProtocol`)
- `tools/run-tests.tool.ts` (`SandboxProtocol`)
- `tools/lint-validator.ts` (`SandboxProtocol`)
- `tools/preview-app.tool.ts` (`SandboxProtocolV2`)

## 8. Test Coverage

### 8.1 Executed Test Runs (April 4, 2026)

Command:

```bash
yarn workspace @dzupagent/codegen test \
  src/__tests__/sandbox-protocol-and-factory.test.ts \
  src/__tests__/sandbox-cloud-adapters.test.ts \
  src/__tests__/sandbox-infrastructure.test.ts \
  src/__tests__/sandbox-limits.test.ts \
  src/__tests__/wasm-sandbox.test.ts \
  src/__tests__/k8s-sandbox.test.ts \
  src/__tests__/workspace-runner.test.ts \
  src/__tests__/preview-app-tool.test.ts \
  src/__tests__/tools-suite.test.ts
```

Result:

- test files: 9 passed
- tests: 308 passed, 27 skipped

Additional cross-package run:

```bash
yarn workspace @dzupagent/evals test src/__tests__/sandbox-contracts.test.ts
```

Result:

- test files: 1 passed
- tests: 24 passed

### 8.2 Sandbox Coverage Snapshot (V8)

From `yarn workspace @dzupagent/codegen test:coverage` with sandbox-focused tests:

- `sandbox/*` aggregate: `86.49%` lines
- `sandbox/audit/*`: `97.65%` lines
- `sandbox/pool/*`: `93.12%` lines
- `sandbox/volumes/*`: `98.42%` lines
- `sandbox/wasm/*`: `84.34%` lines
- `sandbox/k8s/*`: `75.30%` lines

Notable lower-coverage files:

- `sandbox/docker-sandbox.ts`: `55.01%` lines
- `sandbox/k8s/k8s-client.ts`: `64.48%` lines
- `sandbox/k8s/k8s-sandbox.ts`: `70.52%` lines
- `sandbox/wasm/wasm-sandbox.ts`: `75.16%` lines

Note: the coverage command returns non-zero because package-wide global thresholds apply to non-sandbox modules too. Sandbox-specific metrics above were still produced and are valid.

### 8.3 What Is Well Covered

- protocol contracts and factory behavior
- permission/security flag generation
- cloud adapter API behaviors and error paths
- pool lifecycle and waiter behavior
- audit chain append/verify and redaction
- WASI filesystem operations and TypeScript transpiler fallback behaviors
- preview tool behavior against V2 interface via mocks

### 8.4 Gaps And Residual Risk

- Real Docker session lifecycle/streaming is mostly mock-level tested; deeper integration tests are limited.
- K8s adapter coverage is lower and partly depends on optional operator modules; many operator tests are intentionally skippable.
- WASM execute path that depends on installed `quickjs-emscripten` is not deeply exercised in CI-like environments where dependency is absent.
- In `@dzupagent/evals` contract runs, `MockSandbox` shows recommended (non-required) gaps for timeout enforcement and invalid-command behavior unless explicitly configured for those cases.
- Lifecycle mismatch risk for cloud adapters:
  - `E2BSandbox` and `FlySandbox` require initialization before `uploadFiles`/`downloadFiles`; they initialize lazily on `execute`.
  - Consumers that upload first (for example workspace-style flows) must handle this provider-specific behavior.
- `createSandbox(...)` does not include `wasm`/`k8s` providers and returns `SandboxProtocol` (V1), so V2 methods are not visible from factory output.

## 9. Implementation Notes For Extenders

- New backend providers should implement `SandboxProtocol` first, then optionally `SandboxProtocolV2` for preview/session features.
- Prefer adding conformance tests via `@dzupagent/evals` sandbox contract suite for any new adapter.
- If introducing a provider that requires explicit creation before file upload, either:
  - expose a clear `init` step, or
  - make `uploadFiles` trigger lazy init to preserve common VFS workflow compatibility.
