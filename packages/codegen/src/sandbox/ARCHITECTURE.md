# Sandbox Architecture (`@dzupagent/codegen`)

## Scope
This document covers `packages/codegen/src/sandbox` and the direct in-package consumers that depend on sandbox contracts.

The sandbox subsystem provides execution isolation primitives for codegen workflows through:

- Protocol contracts (`sandbox-protocol.ts`, `sandbox-protocol-v2.ts`)
- Provider implementations (`docker`, `e2b`, `fly`, `k8s`, `mock`)
- Operational layers (`audit`, `pool`, `volumes`)
- Security helpers (`permission-tiers.ts`, `security-profile.ts`, `sandbox-hardening.ts`)
- In-process WASM sandbox primitives (`wasm/*`)

## Responsibilities
- Define a backend-agnostic execution contract for command execution and file staging.
- Provide concrete providers for local Docker, cloud sandboxes, Kubernetes pod-backed execution, and test doubles.
- Support preview/session workflows through V2 session and stream APIs.
- Expose security policy helpers for tiered permissions and hardening flag generation.
- Provide optional reliability/compliance helpers: pooling, reset strategies, volume lifecycle metadata, and audit chains.
- Provide WASM-local execution primitives (filesystem, capability checks, resource-limited execution, TS transpilation fallback).

## Structure
- `sandbox-protocol.ts`
  - Base `SandboxProtocol` and `ExecOptions`/`ExecResult`.
- `sandbox-protocol-v2.ts`
  - `SandboxProtocolV2` with `startSession`, `executeStream`, `exposePort`, `stopSession`.
- `sandbox-factory.ts`
  - `createSandbox()` for provider selection across `docker | e2b | fly | mock`.

- Provider implementations:
  - `docker-sandbox.ts`: `DockerSandbox` implementing V1 + V2.
  - `e2b-sandbox.ts`: `E2BSandbox` REST adapter.
  - `fly-sandbox.ts`: `FlySandbox` REST adapter.
  - `k8s/*`: CRD types, K8s REST client, and `K8sPodSandbox`.
  - `mock-sandbox.ts`, `mock-sandbox-v2.ts`: test doubles.

- Security and policy helpers:
  - `permission-tiers.ts`: trust tiers and conversion helpers.
  - `security-profile.ts`: profile model + docker-flag conversion.
  - `sandbox-hardening.ts`: hardening config-to-flags + escape-pattern detector.

- Operational extensions:
  - `pool/*`: `SandboxPool`, metrics, wait-queue behavior, reset strategies.
  - `volumes/*`: `VolumeManager` contract + in-memory implementation.
  - `audit/*`: audit types/store + `AuditedSandbox` decorator.

- WASM subsystem:
  - `wasm/wasi-fs.ts`: in-memory WASI-like filesystem with serialization.
  - `wasm/capability-guard.ts`: capability checks and mutation APIs.
  - `wasm/wasm-sandbox.ts`: optional QuickJS-backed execution path + resource guardrails.
  - `wasm/ts-transpiler.ts`: `esbuild-wasm` path with regex fallback.
  - `wasm/sandbox-errors.ts`: resource/timeout/access error types.

## Runtime and Control Flow
- Base V1 flow:
  1. Consumer acquires provider instance.
  2. Files are staged via `uploadFiles()`.
  3. Commands run via `execute(command, { cwd, timeoutMs })`.
  4. Outputs or modified files are read back via `downloadFiles()`.
  5. Resources are released with `cleanup()`.

- V2 preview flow (currently Docker-backed):
  1. `startSession()` creates long-lived container session.
  2. `executeStream()` yields `stdout`/`stderr`/`exit` events.
  3. `exposePort()` returns preview URL metadata.
  4. `stopSession()` tears down session.

- Kubernetes flow:
  1. `K8sPodSandbox` creates `AgentSandbox` CRD via `K8sClient`.
  2. Polls until status phase is `Ready`.
  3. Runs shell commands via K8s exec API.
  4. Deletes CRD on cleanup.

- Audit decorator flow:
  1. `AuditedSandbox` wraps any `SandboxProtocol`.
  2. `execute`/`upload`/`download`/`cleanup` are appended to a hash-linked store.
  3. Secret-like patterns in command text are redacted before write.
  4. Chain integrity is checked with `verifyChain()`.

- Pooling flow:
  1. `SandboxPool.start()` prewarms up to `minIdle`.
  2. `acquire()` reuses idle instances or creates new up to `maxSize`.
  3. Waiters block until release or timeout (`PoolExhaustedError`).
  4. `drain()` rejects waiters and destroys idle instances.

## Key APIs and Types
- Protocols:
  - `SandboxProtocol`
  - `SandboxProtocolV2`
  - `ExecOptions`, `ExecResult`, `ExecEvent`

- Provider selection and provider configs:
  - `createSandbox(config: SandboxFactoryConfig)`
  - `SandboxProvider = 'docker' | 'e2b' | 'fly' | 'mock'`
  - `DockerSandboxConfig`, `E2BSandboxConfig`, `FlySandboxConfig`, `K8sSandboxConfig`

- Security/policy:
  - `PermissionTier`, `TierConfig`, `TIER_DEFAULTS`
  - `SecurityProfile`, `SecurityLevel`, `SECURITY_PROFILES`
  - `HardenedSandboxConfig`, `toDockerSecurityFlags()`, `detectEscapeAttempt()`

- Audit/pool/volumes:
  - `AuditedSandbox`, `InMemoryAuditStore`, `SandboxAuditEntry`
  - `SandboxPool`, `PooledSandbox`, `SandboxPoolMetrics`, `PoolExhaustedError`
  - `VolumeManager`, `VolumeDescriptor`, `VolumeInfo`, `InMemoryVolumeManager`

- WASM:
  - `WasmSandbox`, `WasmSandboxConfig`, `WasmExecResult`
  - `WasiFilesystem`, `CapabilityGuard`, `WasmTypeScriptTranspiler`
  - `SandboxResourceError`, `SandboxTimeoutError`, `SandboxAccessDeniedError`

## Dependencies
- Package-level runtime dependencies for `@dzupagent/codegen`:
  - `@dzupagent/core`
  - `@dzupagent/adapter-types`

- Peer dependencies relevant to sandbox usage:
  - `@langchain/core`, `@langchain/langgraph`, `zod`
  - Optional peers in package metadata: `tree-sitter-wasms`, `web-tree-sitter`

- Optional runtime modules loaded dynamically in WASM subsystem:
  - `quickjs-emscripten` for `WasmSandbox.execute()`
  - `esbuild-wasm` for high-fidelity `WasmTypeScriptTranspiler`

- Platform/system expectations by provider:
  - Docker CLI for `DockerSandbox`
  - Networked REST access to E2B/Fly APIs for cloud providers
  - Kubernetes API access and `AgentSandbox` CRD/operator for K8s provider

## Integration Points
- Inside `@dzupagent/codegen`:
  - `src/vfs/workspace-runner.ts` uses `SandboxProtocol` for snapshot execution and sync-back.
  - `src/workspace/sandboxed-workspace.ts` routes writes and command execution through a sandbox.
  - `src/tools/run-tests.tool.ts` and `src/tools/lint-validator.ts` execute commands through V1 protocol.
  - `src/tools/preview-app.tool.ts` requires `SandboxProtocolV2`.

- Cross-package:
  - `packages/evals/src/contracts/suites/sandbox-contract.ts` defines sandbox contract checks against codegen protocol shape.
  - `packages/evals/src/__tests__/sandbox-contracts.test.ts` dynamically exercises `MockSandbox` and (when available) `DockerSandbox`.

- Public exports:
  - `src/index.ts` re-exports sandbox providers, protocols, helpers, k8s modules, audit/pool/volume APIs, and WASM APIs.

## Testing and Observability
- Sandbox-focused tests in `@dzupagent/codegen` include:
  - `sandbox-protocol-and-factory.test.ts`
  - `sandbox-cloud-adapters.test.ts`
  - `sandbox-infrastructure.test.ts`
  - `sandbox-limits.test.ts`
  - `wasm-sandbox.test.ts`
  - `k8s-sandbox.test.ts`
  - `mock-sandbox-v2.test.ts`
  - `docker-sandbox-path-traversal.test.ts`
  - `preview-app-tool.test.ts`
  - `workspace-runner.test.ts`
  - `tools-suite.test.ts`
  - `workspace/__tests__/sandboxed-workspace.test.ts`

- Current observability hooks in this subsystem:
  - Structured operation capture through `AuditedSandbox` + `SandboxAuditStore`.
  - Hash-chain verification with `verifyChain()` for tamper evidence.
  - Pool metrics (`totalCreated`, `totalDestroyed`, active/idle counts, acquire wait samples).
  - Provider health probes through `isAvailable()` methods.

- External contract verification:
  - `packages/evals` sandbox contract suite validates required/recommended behavior across sandbox implementations.

## Risks and TODOs
- `createSandbox()` only returns `SandboxProtocol` and supports `docker|e2b|fly|mock`; it does not factory-create `k8s` or `wasm` backends.
- V2 session APIs are effectively Docker-only in this package; consumers needing `SandboxProtocolV2` must use concrete V2 implementations directly.
- `DockerSandbox.exposePort()` currently returns `http://localhost:<port>` without explicit Docker port-publishing management.
- `E2BSandbox` and `FlySandbox` initialize lazily on `execute()`, while `uploadFiles()`/`downloadFiles()` require readiness; upload-first workflows can fail without an explicit initialization step.
- K8s tests include optional operator-driven scenarios and can be partially skipped when operator modules are not present in the workspace.
- WASM execution path depends on optional `quickjs-emscripten`; many tests validate non-QuickJS paths and guardrails rather than full runtime execution.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

