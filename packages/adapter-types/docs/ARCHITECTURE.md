# @dzupagent/adapter-types Architecture

## Scope
`@dzupagent/adapter-types` is a TypeScript contract package at `packages/adapter-types`.

This document is grounded in:
- `src/index.ts` as the single exported type surface.
- `src/__tests__/*.test.ts` as contract fixtures.
- `package.json`, `tsconfig.json`, and `tsup.config.ts`.
- Package docs under `docs/`.

`packages/adapter-types/README.md` does not currently exist.

## Responsibilities
- Define the shared adapter interface `AgentCLIAdapter` for provider implementations and consumers.
- Define normalized adapter lifecycle payloads via the `AgentEvent` discriminated union.
- Define request/config/metadata contracts: `AgentInput`, `AdapterConfig`, `EnvFilterConfig`, `HealthStatus`, `SessionInfo`, and `TokenUsage`.
- Define routing contracts: `TaskDescriptor`, `RoutingDecision`, and `TaskRoutingStrategy`.
- Define Unified Capability Layer contracts: `AgentMemoryRecalledEvent`, `AgentSkillsCompiledEvent`, `CapabilityStatus`, `ProviderCapabilityRow`, and `SkillCapabilityMatrix`.
- Define DzupAgent config/path contracts: `CodexMemoryStrategy`, `DzupAgentConfig`, and `DzupAgentPaths`.
- Publish ESM and declaration artifacts from a single entrypoint (`dist/index.js`, `dist/index.d.ts`) without runtime dependencies.

## Structure
- `src/index.ts`: all exported types/interfaces for this package.
- `src/__tests__/adapter-types.test.ts`: baseline public shape assertions for provider IDs, config, input, health, sessions, and usage.
- `src/__tests__/adapter-types.integration.test.ts`: event lifecycle modeling and exhaustive `AgentEvent` switch behavior.
- `src/__tests__/agent-cli-adapter-contract.test.ts`: executable `AgentCLIAdapter` fixture proving required/optional method contract behavior.
- `src/__tests__/adapter-routing-contracts.test.ts`: `TaskRoutingStrategy` and `RoutingDecision` contract fixture.
- `src/__tests__/adapter-config-variants.test.ts`: `sandboxMode` and `EnvFilterConfig` variant coverage.
- `tsup.config.ts`: ESM build (`format: ['esm']`) and declaration generation.
- `tsconfig.json`: strict NodeNext TypeScript compilation settings.
- `docs/ARCHITECTURE.md` and `docs/analyze_codex.md`: package-local architecture and analysis notes.

## Runtime and Control Flow
This package contains contracts only. It does not implement adapter execution logic itself.

Expected control flow represented by the contracts and test fixtures:
1. A caller constructs `AgentInput` (required `prompt`; optional runtime controls like `signal`, `maxTurns`, `maxBudgetUsd`, `resumeSessionId`, `correlationId`, and `outputSchema`).
2. A concrete adapter implementing `AgentCLIAdapter` exposes `execute(input)` and yields `AsyncGenerator<AgentEvent, void, undefined>`.
3. Consumers branch on `event.type` for discriminated handling.
4. Streams terminate with `adapter:completed`, `adapter:failed`, or `recovery:cancelled`.
5. Optional behaviors are discovered through `getCapabilities()` and optional interface methods (`listSessions`, `forkSession`, `warmup`).
6. Session continuation uses `resumeSession(sessionId, input)`.

Common lifecycle shape modeled in tests:
1. `adapter:started`
2. zero or more intermediate events (`adapter:message`, `adapter:progress`, `adapter:tool_call`, `adapter:tool_result`, `adapter:stream_delta`, `adapter:memory_recalled`, `adapter:skills_compiled`)
3. one terminal event (`adapter:completed` or failure terminal)

## Key APIs and Types
- Provider identity: `AdapterProviderId` currently includes `claude`, `codex`, `gemini`, `gemini-sdk`, `qwen`, `crush`, `goose`, and `openrouter`.
- Adapter capability declaration: `AdapterCapabilityProfile`.
- Adapter request contract: `AgentInput`.
- Adapter event union: `AgentEvent`.
- Event payload interfaces: `AgentStartedEvent`, `AgentMessageEvent`, `AgentToolCallEvent`, `AgentToolResultEvent`, `AgentCompletedEvent`, `AgentFailedEvent`, `AgentRecoveryCancelledEvent`, `AgentStreamDeltaEvent`, `AgentProgressEvent`, `AgentMemoryRecalledEvent`, and `AgentSkillsCompiledEvent`.
- Adapter operational metadata: `TokenUsage`, `HealthStatus`, `SessionInfo`.
- Adapter configuration contracts: `EnvFilterConfig`, `AdapterConfig`.
- Core adapter interface: `AgentCLIAdapter`.
- Routing contracts: `TaskDescriptor`, `RoutingDecision`, `TaskRoutingStrategy`.
- Skill capability matrix contracts: `CapabilityStatus`, `ProviderCapabilityRow`, `SkillCapabilityMatrix`.
- DzupAgent configuration/path contracts: `CodexMemoryStrategy`, `DzupAgentConfig`, `DzupAgentPaths`.

## Dependencies
- Runtime dependencies: none declared in `packages/adapter-types/package.json`.
- Declared package dev dependencies: `typescript` and `tsup`.
- Test script uses `vitest` (`vitest run`) and resolves it from workspace-level tooling rather than package-local `devDependencies`.
- Build/export settings: `type: module`, root export map only (`"."`), and Node 20 build target in `tsup.config.ts`.

## Integration Points
- `packages/agent-adapters/src/types.ts` re-exports this package (`export * from '@dzupagent/adapter-types'`) for compatibility.
- `packages/agent/src/orchestration/provider-adapter/provider-execution-port.ts` imports only adapter types to keep dependency inversion between orchestrator and adapter implementations.
- `packages/codegen/src/generation/codegen-run-engine.ts` accepts `AgentCLIAdapter` and consumes adapter event and usage types.
- `packages/agent-adapters/src/skills/skill-capability-matrix.ts` uses `CapabilityStatus`, `ProviderCapabilityRow`, and `SkillCapabilityMatrix`.
- `packages/create-dzupagent/src/bridge.ts` mirrors `DzupAgentPaths` shape in its dynamic bridge layer.

## Testing and Observability
- Contract test files in this package: `adapter-types.test.ts`, `adapter-types.integration.test.ts`, `agent-cli-adapter-contract.test.ts`, `adapter-routing-contracts.test.ts`, and `adapter-config-variants.test.ts`.
- Verified for this refresh: `yarn workspace @dzupagent/adapter-types test` passed with 5 files and 10 tests.
- Verified for this refresh: `yarn workspace @dzupagent/adapter-types typecheck` passed.
- Observability-centric contract fields include `correlationId` on `AgentInput` and all event interfaces.
- Streaming/progress contracts are explicit via `adapter:stream_delta` and `adapter:progress`.
- Completion usage telemetry is represented by `AgentCompletedEvent.usage?: TokenUsage`.
- Adapter health telemetry is represented by `HealthStatus`.

## Risks and TODOs
- Add `packages/adapter-types/README.md` to provide a concise contract guide for external adapter authors.
- Consider splitting `src/index.ts` as the exported surface grows to reduce merge pressure in a single large contract file.
- Strengthen provider-union regression checks; current tests use representative arrays and do not enforce full `AdapterProviderId` exhaustiveness.
- Add compile-time contract regression tests (for example `tsd` or equivalent type fixtures) in addition to runtime fixture tests.
- Consider making test-tool dependency explicit at package level if workspace hoisting assumptions become brittle.

## Changelog
- 2026-04-16: automated refresh via scripts/refresh-architecture-docs.js