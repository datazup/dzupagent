# Sandbox Architecture (`@dzupagent/codegen`)

## Scope
This document covers the sandbox subsystem under `packages/codegen/src/sandbox` and its direct in-package consumers in `src/tools`, `src/vfs`, and `src/workspace`.

The scope includes:

- Core execution contracts (`sandbox-protocol.ts`, `sandbox-protocol-v2.ts`).
- Provider implementations (`docker-sandbox.ts`, `e2b-sandbox.ts`, `fly-sandbox.ts`, `k8s/k8s-sandbox.ts`, `mock-sandbox.ts`, `mock-sandbox-v2.ts`).
- Security and policy helpers (`permission-tiers.ts`, `security-profile.ts`, `sandbox-hardening.ts`).
- Operational helpers (`audit/*`, `pool/*`, `volumes/*`).
- WASM-local sandboxing primitives (`wasm/*`).
- Governed process-tool-call wiring (`ptc/*`).

## Responsibilities
- Provide a common async command/file contract (`SandboxProtocol`) for isolated execution backends.
- Provide an extended session/stream/preview contract (`SandboxProtocolV2`) for long-lived preview workflows.
- Implement concrete sandbox providers with backend-specific lifecycle handling.
- Offer security control layers (tier defaults, profile-to-flag conversion, hardening flags, escape-pattern detection).
- Offer operational support layers (audit chain, pooling, reset strategy, volume metadata management).
- Provide in-process WASM sandbox capabilities for code execution and file operations.
- Bridge governed code execution (`ptc`) into the same tool-governance pipeline used by agent tools.

## Structure
- Protocols and factory:
  - `sandbox-protocol.ts`: `ExecOptions`, `ExecResult`, `SandboxProtocol`.
  - `sandbox-protocol-v2.ts`: `SessionOptions`, `ExecEvent`, `SandboxProtocolV2`.
  - `sandbox-factory.ts`: `createSandbox(config)` for `docker | e2b | fly | mock`.

- Providers:
  - `docker-sandbox.ts`: `DockerSandbox` implementing `SandboxProtocolV2`.
  - `e2b-sandbox.ts`: `E2BSandbox` REST adapter implementing `SandboxProtocol`.
  - `fly-sandbox.ts`: `FlySandbox` REST adapter implementing `SandboxProtocol`.
  - `k8s/k8s-sandbox.ts`: `K8sPodSandbox` implementing `SandboxProtocol`.
  - `mock-sandbox.ts`: V1 in-memory test sandbox.
  - `mock-sandbox-v2.ts`: V2 in-memory test sandbox with recorded calls/streams.

- Security and policy:
  - `permission-tiers.ts`: core `PermissionTier` re-export, defaults, validation, write-gate assertion.
  - `security-profile.ts`: profile model and conversion to Docker flags.
  - `sandbox-hardening.ts`: hardening config and Docker security flag generation, escape detection.

- Kubernetes support:
  - `k8s/operator-types.ts`: `AgentSandbox` CRD data model and helper.
  - `k8s/k8s-client.ts`: direct REST client for CRD CRUD, phase wait, and pod exec.
  - `k8s/index.ts`: K8s export surface.

- Operational extensions:
  - `audit/audit-types.ts`, `audit/memory-audit-store.ts`, `audit/audited-sandbox.ts`.
  - `pool/sandbox-pool.ts`, `pool/sandbox-reset.ts`.
  - `volumes/volume-manager.ts`, `volumes/memory-volume-manager.ts`.

- WASM subsystem:
  - `wasm/wasi-fs.ts`: in-memory WASI-style filesystem.
  - `wasm/capability-guard.ts`: capability checks (`fs-read`, `fs-write`, etc.).
  - `wasm/wasm-sandbox.ts`: optional QuickJS-backed execution and resource/path/output limits.
  - `wasm/ts-transpiler.ts`: optional `esbuild-wasm` transpile, regex fallback.
  - `wasm/sandbox-errors.ts`: typed error classes.

- Governed PTC:
  - `ptc/ptc-types.ts`: request/result/governance types.
  - `ptc/ptc-governance-adapter.ts`: access check and blocked-result helpers.
  - `ptc/ptc-tool.ts`: LangChain tool factory that runs through governance and `WasmSandbox`.

## Runtime and Control Flow
1. V1 execution contract flow:
   - Caller uploads staged files with `uploadFiles`.
   - Caller executes a command with optional `cwd` and `timeoutMs`.
   - Caller reads selected paths with `downloadFiles`.
   - Caller releases resources with `cleanup`.

2. Factory-based provider selection:
   - `createSandbox({ provider })` instantiates `DockerSandbox`, `E2BSandbox`, `FlySandbox`, or `MockSandbox`.
   - For `e2b` and `fly`, missing provider-specific config throws immediately.

3. Docker V1/V2 flow:
   - V1 `execute` runs one-shot `docker run` with secure defaults unless `previewMode` is enabled.
   - V2 `startSession` launches a detached container, `executeStream` yields `stdout`/`stderr`/`exit`, `exposePort` returns `http://localhost:<port>`, and `stopSession` stops/removes the container.
   - `uploadFiles`/`downloadFiles` stage files in a temp directory guarded by path-traversal checks.

4. Cloud sandbox flow (E2B/Fly):
   - `execute` lazily initializes backend runtime (`sandboxId`/`machineId`) on first call.
   - `uploadFiles`/`downloadFiles` require a ready backend and will throw if called before initialization.
   - `cleanup` is best-effort and clears local runtime IDs.

5. Kubernetes flow:
   - `K8sPodSandbox.ensurePod()` creates an `AgentSandbox` CRD using `K8sClient`.
   - It waits for phase `Ready`, resolves `podName`, then executes via `K8sClient.exec`.
   - `cleanup` deletes the CRD resource.

6. Auditing flow:
   - `AuditedSandbox` decorates any `SandboxProtocol` implementation.
   - On each operation, it appends a hash-linked entry to `SandboxAuditStore`.
   - `execute` records redacted command text and summarized result metadata.
   - Consumers can query trail entries and verify chain integrity.

7. Pooling flow:
   - `SandboxPool.start()` prewarms to `minIdle`.
   - `acquire()` takes idle, creates new up to `maxSize`, or waits up to `maxWaitMs`.
   - `release()` either hands directly to a waiter or returns to idle.
   - `drain()` rejects pending waiters and destroys idle instances.

8. WASM and governed PTC flow:
   - `createPtcTool` performs governance checks (`checkPtcAccess`) before any execution.
   - Optional TypeScript transpilation is attempted via `WasmTypeScriptTranspiler`.
   - `WasmSandbox.execute` dynamically loads `quickjs-emscripten`; if unavailable, it throws a descriptive error.
   - Result auditing is reported through `ToolGovernance.auditResult`.

## Key APIs and Types
- Core protocols:
  - `SandboxProtocol`, `ExecOptions`, `ExecResult`.
  - `SandboxProtocolV2`, `SessionOptions`, `ExecEvent`.

- Provider APIs:
  - `DockerSandbox`, `DockerSandboxConfig`.
  - `E2BSandbox`, `E2BSandboxConfig`.
  - `FlySandbox`, `FlySandboxConfig`.
  - `K8sPodSandbox`, `K8sSandboxConfig`, `K8sClient`, `K8sClientConfig`.
  - `MockSandbox`, `MockSandboxV2`.
  - `createSandbox`, `SandboxProvider`, `SandboxFactoryConfig`.

- Security/policy APIs:
  - `PermissionTier` (re-export from `@dzupagent/core/tools`), `TierConfig`, `TIER_DEFAULTS`.
  - `validateTierConfig`, `mergeTierConfig`, `tierToDockerFlags`, `tierToE2bConfig`.
  - `assertTierAllowsWrite`, `PermissionTierViolationError`.
  - `SecurityProfile`, `SecurityLevel`, `SECURITY_PROFILES`, `toDockerFlags`.
  - `HardenedSandboxConfig`, `toDockerSecurityFlags`, `detectEscapeAttempt`.

- Audit/pool/volumes:
  - `SandboxAuditEntry`, `SandboxAuditStore`, `InMemoryAuditStore`, `AuditedSandbox`, `redactSecrets`.
  - `SandboxPool`, `PooledSandbox`, `SandboxPoolConfig`, `SandboxPoolMetrics`, `PoolExhaustedError`.
  - `DockerResetStrategy`, `CloudResetStrategy`, `SandboxResetStrategy`.
  - `VolumeManager`, `VolumeDescriptor`, `VolumeInfo`, `InMemoryVolumeManager`.

- WASM and PTC:
  - `WasiFilesystem`, `CapabilityGuard`, `CapabilityDeniedError`.
  - `WasmSandbox`, `WasmSandboxConfig`, `WasmExecResult`, `SandboxResourceLimits`.
  - `WasmTypeScriptTranspiler`, `TranspileResult`.
  - `SandboxResourceError`, `SandboxTimeoutError`, `SandboxAccessDeniedError`.
  - `createPtcTool`, `checkPtcAccess`, `buildBlockedPtcResult`, `PtcRequest`, `PtcResult`, `PtcGovernanceConfig`.

## Dependencies
- Direct package dependencies (`packages/codegen/package.json`):
  - `@dzupagent/core`
  - `@dzupagent/adapter-types`

- Peer dependencies relevant to this subsystem:
  - `@langchain/core` (tool factory usage)
  - `@langchain/langgraph` (upstream package workflows that consume tools)
  - `zod` (tool input schemas)
  - Optional: `tree-sitter-wasms`, `web-tree-sitter` (package-wide optional peers, not sandbox-specific runtime requirements)

- Optional/dynamic sandbox dependencies:
  - `quickjs-emscripten` (loaded dynamically by `WasmSandbox.execute`)
  - `esbuild-wasm` (loaded dynamically by `WasmTypeScriptTranspiler`)

- Environment prerequisites by backend:
  - Docker CLI for `DockerSandbox`.
  - Network access and credentials for E2B/Fly control-plane APIs.
  - Kubernetes API connectivity and `AgentSandbox` CRD/operator for K8s flows.

## Integration Points
- In-package integrations:
  - `src/vfs/workspace-runner.ts` runs VFS snapshots through `SandboxProtocol`.
  - `src/workspace/sandboxed-workspace.ts` routes writes/commands to `SandboxProtocol`.
  - `src/workspace/workspace-factory.ts` requires explicit sandbox backend for sandbox-enabled mode unless local fallback is allowed.
  - `src/tools/run-tests.tool.ts` and `src/tools/lint-validator.ts` execute through `SandboxProtocol`.
  - `src/tools/preview-app.tool.ts` depends on `SandboxProtocolV2`.
  - `src/tools/write-file.tool.ts` and `src/tools/edit-file.tool.ts` enforce permission-tier write gating via `assertTierAllowsWrite`.

- Cross-package integrations in `dzupagent`:
  - `packages/evals/src/__tests__/sandbox-contracts.test.ts` validates sandbox adapters, including conditional use of `@dzupagent/codegen` `MockSandbox`.
  - `packages/agent/src/agent/production-tool-governance-preset.ts` documents the expected `createPtcTool(...)` integration path for governed PTC tools.

- Export surfaces:
  - Root: `src/index.ts` exports sandbox providers/helpers plus K8s, WASM, audit, pool, volumes, and PTC APIs.
  - Facades: `src/runtime.ts` and `src/tools.ts` expose sandbox subsets for runtime/tool consumers.

## Testing and Observability
- Sandbox-focused test coverage in `packages/codegen/src/__tests__` includes:
  - `sandbox-protocol-and-factory.test.ts`
  - `sandbox-cloud-adapters.test.ts`
  - `docker-sandbox-path-traversal.test.ts`
  - `mock-sandbox-v2.test.ts`
  - `sandbox-infrastructure.test.ts`
  - `sandbox-limits.test.ts`
  - `k8s-sandbox.test.ts`
  - `wasm-sandbox.test.ts`
  - `preview-app-tool.test.ts`
  - `workspace-runner.test.ts`
  - `workspace/__tests__/sandboxed-workspace.test.ts`
  - `sandbox/permission-tiers.test.ts`

- Observability and diagnostics in this subsystem:
  - `AuditedSandbox` records operation metadata with redaction and chain verification.
  - `SandboxPool.metrics()` exposes lifecycle and wait-time metrics.
  - All providers expose `isAvailable()` health probes.
  - PTC integrates with governance audit hooks (`audit`, `auditResult`) and optional `approval:requested` event emission.

## Risks and TODOs
- Factory coverage mismatch:
  - `createSandbox` returns `SandboxProtocol` and supports only `docker | e2b | fly | mock`; K8s and WASM are constructed separately.

- V2 availability mismatch:
  - V2 protocol support is implemented by Docker and Mock V2 classes; factory output is typed and returned as V1.

- Docker preview exposure gap:
  - `exposePort` returns `http://localhost:<port>` without explicit port-publishing orchestration in `startSession`.

- Cloud readiness sequencing:
  - `E2BSandbox` and `FlySandbox` lazily initialize on `execute`; `uploadFiles`/`downloadFiles` before first execute throw readiness errors.

- WASM optional runtime:
  - Without `quickjs-emscripten`, `WasmSandbox.execute` is unavailable even though file/capability operations still work.

- Governance default ambiguity:
  - `PtcGovernanceConfig` docs describe `transpileTypeScript` as default false, while `createPtcTool` currently treats it as enabled by default (`?? true`).

- Hardening portability:
  - Flag generation in `security-profile.ts`/`sandbox-hardening.ts` assumes Docker flag support for seccomp-related options; runtime compatibility depends on Docker environment.

- Audit chain strength:
  - `InMemoryAuditStore` uses a deterministic non-cryptographic hash (`simpleHash`), appropriate for tamper-evidence in dev/test but not a cryptographic ledger.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js

