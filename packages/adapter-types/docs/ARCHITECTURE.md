# @dzupagent/adapter-types Architecture

## Scope
`@dzupagent/adapter-types` is a layer-0 TypeScript contract package in `packages/adapter-types`.
It ships shared types and minimal helper utilities for provider adapters, routing, workflow execution ports, and run-store telemetry.

This package is intentionally implementation-light:
- No concrete adapter/provider runtime implementation.
- No external runtime dependencies in `package.json`.
- Single public export entrypoint (`src/index.ts` -> `dist/index.js` / `dist/index.d.ts`).

Primary source files:
- `src/contracts/*.ts`
- `src/provider-execution-port.ts`
- `src/pipeline-executor-port.ts`
- `src/utils/correlation.ts`

## Responsibilities
- Define provider-neutral adapter contracts (`AgentCLIAdapter`, `AgentInput`, `AdapterConfig`, `HealthStatus`, `SessionInfo`).
- Define normalized adapter event contracts (`AgentEvent`, `AgentStreamEvent`, event payload types, cache stats).
- Define policy and interaction contracts for pre-execution/run-time controls (`InteractionPolicy`, policy context/guardrail hints).
- Define routing contracts (`TaskDescriptor`, `RoutingDecision`, `TaskRoutingStrategy`).
- Define capability matrix contracts used by skill/provider compatibility logic.
- Define DzupAgent memory/path contracts (`AdapterMemoryConfig`, `DzupAgentPaths`).
- Define persistence/governance side-channel contracts (`RawAgentEvent`, `AgentArtifactEvent`, `GovernanceEvent`, `RunSummary`).
- Define pre-flight validation contracts and combinators (`ValidationContract`, `composeValidators`, `passingResult`, `failingResult`).
- Provide dependency-inverted port interfaces for orchestration integration (`ProviderExecutionPort`, `PipelineExecutorPort` and factory/config types).
- Provide a single runtime helper for immutable correlation propagation (`withCorrelationId`).

## Structure
- `src/index.ts`
  Re-exports all public contracts and helpers.
- `src/contracts/provider.ts`
  Defines `AdapterProviderId` union: `claude`, `codex`, `gemini`, `gemini-sdk`, `qwen`, `crush`, `goose`, `openrouter`, `openai`.
- `src/contracts/interaction.ts`
  Defines interaction policy modes (`auto-approve`, `auto-deny`, `default-answers`, `ai-autonomous`, `ask-caller`) and per-mode options.
- `src/contracts/token-usage.ts`
  Defines normalized token/cost accounting shape.
- `src/contracts/execution.ts`
  Defines execution input, policy transport types, adapter capability profile, monitor health shape, adapter config, and `AgentCLIAdapter` interface.
- `src/contracts/events.ts`
  Defines unified adapter event union, map-reduce runtime event union, provider raw stream wrapper, and cache stats event.
- `src/contracts/routing.ts`
  Defines task routing descriptor/decision/strategy contracts.
- `src/contracts/capabilities.ts`
  Defines provider capability matrix contracts.
- `src/contracts/dzupagent.ts`
  Defines adapter memory config/path contracts and deprecated alias `DzupAgentConfig`.
- `src/contracts/run-store.ts`
  Defines raw event/artifact/governance/run-summary contracts.
- `src/contracts/validation.ts`
  Defines pre-flight validation contract types and validator composition/result helpers.
- `src/provider-execution-port.ts`
  Defines provider execution DI port (`stream`, `run`) and result type.
- `src/pipeline-executor-port.ts`
  Defines pipeline runtime DI port/factory and structural execution/result/event/context contracts.
- `src/utils/correlation.ts`
  Defines `withCorrelationId` helper.
- `src/__tests__/*.test.ts`
  Contract-focused coverage for public surface, event lifecycle, routing, run-store fixtures, adapter interface fixture, correlation helper, and pipeline executor port.

## Runtime and Control Flow
This package is mostly declarative; runtime behavior is limited to helper/composition utilities.

Core execution flow modeled by contracts:
1. Caller constructs `AgentInput` (prompt required; optional budget/turn/policy/correlation/schema fields).
2. Adapter implementation executes `AgentCLIAdapter.execute(input)` and emits normalized `AgentEvent` items.
3. Consumers branch on discriminated `event.type` to process lifecycle, streaming, tool, progress, interaction, memory/skills, and terminal events.
4. Raw-capable adapters may additionally emit `AgentStreamEvent` via `executeWithRaw`, where `adapter:provider_raw` wraps `RawAgentEvent`.
5. Resume/control hooks (`resumeSession`, `interrupt`, `configure`, `healthCheck`) are standardized on the adapter interface.

Run-store and governance side-channel flow modeled by contracts:
1. Provider-native output can be persisted as `RawAgentEvent`.
2. Artifact mutations are modeled as `AgentArtifactEvent`.
3. Governance-plane signals are modeled as `GovernanceEvent`.
4. Terminal aggregate state is modeled as `RunSummary` with `RunStatus`.

Validation flow modeled by `validation.ts`:
1. One or more `ValidationContract` implementations inspect `AgentInput` plus `ValidationContext`.
2. `composeValidators` runs all validators and merges issues.
3. `ok: false` indicates error-severity issues and should gate adapter execution before side effects.

## Key APIs and Types
- Adapter provider and execution contracts:
  `AdapterProviderId`, `AgentCLIAdapter`, `AgentInput`, `AdapterConfig`, `AdapterCapabilityProfile`, `HealthStatus`, `SessionInfo`, `TokenUsage`.
- Policy and interaction contracts:
  `AgentInputPolicy`, `AgentPolicyExecutionContext`, `AgentPolicyGuardrailHints`, `AgentPolicyConformanceMode`, `InteractionPolicy`, `InteractionPolicyMode`.
- Event contracts:
  `AgentEvent`, `AgentStreamEvent`, `ProviderRawStreamEvent`, `AgentCacheStatsEvent`, `AdapterRuntimeEventBusEvent`, `MapReduceRuntimeEvent`.
- Routing contracts:
  `TaskDescriptor`, `RoutingDecision`, `TaskRoutingStrategy`.
- Capability contracts:
  `CapabilityStatus`, `ProviderCapabilityRow`, `SkillCapabilityMatrix`.
- DzupAgent config/path contracts:
  `CodexMemoryStrategy`, `AdapterMemoryConfig`, `DzupAgentConfig` (deprecated alias), `DzupAgentPaths`.
- Run-store and governance contracts:
  `RawAgentEvent`, `AgentArtifactEvent`, `GovernanceEventKind`, `GovernanceEvent`, `RunStatus`, `RunSummary`.
- Validation contracts/utilities:
  `ValidationSeverity`, `ValidationIssue`, `ValidationResult`, `ValidationContext`, `ValidationContract`, `composeValidators`, `passingResult`, `failingResult`.
- Port contracts:
  `ProviderExecutionPort`, `ProviderExecutionResult`, `PipelineExecutorPort`, `PipelineExecutorFactory`, `PipelineExecutorConfig`, `PipelineExecutorRunResult`, `PipelineExecutorNodeContext`, `PipelineExecutorNodeResult`, `PipelineExecutorState`.
- Utility:
  `withCorrelationId`.

## Dependencies
`package.json` dependencies:
- Runtime dependencies: none.
- Dev dependencies: `tsup`, `typescript`.

Build and packaging:
- ESM package (`"type": "module"`).
- Entry: `src/index.ts`.
- Build output: `dist/` with JS + declarations (`tsup`, `dts: true`).
- Export map exposes only `"."` (`dist/index.js`, `dist/index.d.ts`).

Tooling scripts:
- `build`: `tsup`
- `lint`: `eslint src/`
- `test`: `vitest run`
- `typecheck`: `tsc --noEmit`

TypeScript configuration highlights (`tsconfig.json`):
- `module`/`moduleResolution`: `NodeNext`
- `target`: `ES2022`
- `strict` enabled
- `noUncheckedIndexedAccess` enabled

## Integration Points
Current package consumers in the monorepo include:
- `packages/agent-adapters`
  Uses adapter/event/run-store/capability contracts, validation contracts, and pipeline/provider execution port contracts.
- `packages/agent`
  Imports provider execution port contracts in orchestration boundary (`provider-adapter` integration seam).
- `packages/codegen`
  Uses adapter execution/event contracts in generation engine and tests.
- `packages/adapter-rules`
  Uses `AdapterProviderId` in compiler/projector/type contracts.
- `packages/runtime-contracts`
  Mirrors pipeline execution contract shapes to keep runtime boundaries stable.
- `packages/create-dzupagent`
  Mirrors/consumes DzupAgent path contract shape (`DzupAgentPaths`) for bridge wiring.

The package is used as a dependency-inversion anchor so higher-level runtime packages can share contract types without importing concrete adapter implementations.

## Testing and Observability
Tests under `src/__tests__`:
- `adapter-types.test.ts`
- `adapter-types.integration.test.ts`
- `agent-cli-adapter-contract.test.ts`
- `adapter-config-variants.test.ts`
- `adapter-routing-contracts.test.ts`
- `adapter-run-store-contracts.test.ts`
- `correlation.test.ts`
- `pipeline-executor-port.test.ts`

Coverage intent:
- Preserve discriminated-union behavior for `AgentEvent`.
- Validate adapter interface fixture semantics.
- Validate routing/run-store contract shape and fixture compatibility.
- Validate correlation helper behavior.
- Validate pipeline executor port structural implementability without `@dzupagent/agent` dependency.

Observability-relevant contract fields:
- `correlationId` on input/events/run-store entities.
- Explicit progress/interaction/memory/skills/cache event types.
- Side-channel raw provider event and governance event contracts.

## Risks and TODOs
- `README.md` usage sample depends on root exports staying current (for example `ProviderExecutionPort`); keep README examples synchronized when public exports change.
- Provider-ID union includes `gemini-sdk` and `openai`; baseline contract tests use a subset list. Keep tests aligned if provider set changes.
- `DzupAgentConfig` is deprecated alias of `AdapterMemoryConfig`; downstream packages should migrate to the non-deprecated name.
- The package currently exports a broad barrel from `src/index.ts`; accidental breaking API changes are possible without explicit API snapshot tests.
- Validation and port contracts are interface-only; runtime conformance depends on downstream implementation discipline.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js