# @dzupagent/adapter-types Architecture

## Scope
`@dzupagent/adapter-types` is a standalone TypeScript contract package under `packages/adapter-types`. It defines adapter-facing and consumer-facing types used across the DzupAgent workspace, with no runtime adapter implementation.

This refresh is based on current local files:
- `src/index.ts`
- `src/contracts/*.ts`
- `src/utils/correlation.ts`
- `src/__tests__/*.test.ts`
- `package.json`, `tsconfig.json`, `tsup.config.ts`
- `docs/analyze_codex.md`

`packages/adapter-types/README.md` is still not present.

## Responsibilities
- Provide a stable, dependency-light type surface for provider adapters (`AgentCLIAdapter`) and callers (`AgentInput`, `AgentEvent`, routing/config contracts).
- Define normalized event contracts for adapter lifecycle, streaming deltas, interaction prompts/resolution, and enriched signals (memory recall and skill compilation).
- Define side-channel persistence and governance contracts (`RawAgentEvent`, `AgentArtifactEvent`, `GovernanceEvent`, `RunSummary`).
- Define capability matrix contracts used by skill/provider compatibility surfaces.
- Define DzupAgent path/config contracts for `.dzupagent` memory/config wiring.
- Export a small runtime helper (`withCorrelationId`) for safe correlation propagation on typed events.

## Structure
- `src/index.ts`
  Re-export entrypoint for all contract modules and utilities.
- `src/contracts/provider.ts`
  `AdapterProviderId` union: `claude | codex | gemini | gemini-sdk | qwen | crush | goose | openrouter | openai`.
- `src/contracts/interaction.ts`
  Interaction policy model (`InteractionPolicyMode`, `InteractionPolicy`) for mid-execution questions/approvals.
- `src/contracts/execution.ts`
  Core execution contracts: `AdapterCapabilityProfile`, `AgentInput`, `TokenUsage`, `HealthStatus`, `SessionInfo`, `EnvFilterConfig`, `AdapterConfig`, `AgentCLIAdapter`.
- `src/contracts/events.ts`
  Unified stream contracts: `AgentEvent`, event payload interfaces, `ProviderRawStreamEvent`, and `AgentStreamEvent`.
- `src/contracts/routing.ts`
  Task routing contracts: `TaskDescriptor`, `RoutingDecision`, `TaskRoutingStrategy`.
- `src/contracts/capabilities.ts`
  Capability matrix contracts: `CapabilityStatus`, `ProviderCapabilityRow`, `SkillCapabilityMatrix`.
- `src/contracts/dzupagent.ts`
  DzupAgent config/path contracts: `CodexMemoryStrategy`, `AdapterMemoryConfig`, deprecated alias `DzupAgentConfig`, `DzupAgentPaths`.
- `src/contracts/run-store.ts`
  Persistence/governance contracts: `RawAgentEvent`, `AgentArtifactEvent`, `GovernanceEventKind`, `GovernanceEvent`, `RunStatus`, `RunSummary`.
- `src/utils/correlation.ts`
  `withCorrelationId<T extends AgentEvent>(event, correlationId)` helper.
- `src/__tests__/*.test.ts`
  Seven contract suites covering core types, lifecycle events, adapter interface fixture, config variants, routing, run-store fixtures, and correlation helper behavior.
- `tsup.config.ts`
  ESM build from `src/index.ts`, declaration generation, `target: 'node20'`.
- `tsconfig.json`
  Strict NodeNext TypeScript config with declaration/source maps.

## Runtime and Control Flow
This package is mostly declarative types; runtime behavior is intentionally minimal.

Contract-level flow modeled by `execution.ts` and `events.ts`:
1. Caller builds `AgentInput` (`prompt` required; optional controls like `maxTurns`, `maxBudgetUsd`, `resumeSessionId`, `signal`, `outputSchema`, `correlationId`).
2. Adapter implementation executes `AgentCLIAdapter.execute(input)` and yields `AgentEvent` values.
3. Consumers discriminate on `event.type` and handle lifecycle, tool, stream, interaction, and terminal events.
4. Optional raw stream path is `executeWithRaw(input)` yielding `AgentStreamEvent` (`AgentEvent | adapter:provider_raw`).
5. Resume and control hooks are surfaced by `resumeSession`, `interrupt`, `configure`, `healthCheck`, and optional `respondInteraction`, `listSessions`, `forkSession`, `warmup`.

Correlation propagation flow:
1. Caller sets `AgentInput.correlationId`.
2. Adapters propagate that value on emitted events.
3. `withCorrelationId` can stamp normalized events without mutating the original event object.

Persistence-side flow represented in `run-store.ts`:
1. Provider-native output can be persisted as `RawAgentEvent`.
2. File mutations are tracked as `AgentArtifactEvent`.
3. Governance side-channel signals are modeled by `GovernanceEvent`.
4. Terminal aggregation is represented by `RunSummary`.

## Key APIs and Types
- Adapter interface:
  `AgentCLIAdapter`.
- Execution input/config:
  `AgentInput`, `AdapterConfig`, `EnvFilterConfig`, `InteractionPolicy`, `InteractionPolicyMode`.
- Capability and health:
  `AdapterCapabilityProfile`, `HealthStatus`, `SessionInfo`, `TokenUsage`.
- Event model:
  `AgentEvent`, `AgentStreamEvent`, `ProviderRawStreamEvent`.
- Event payload types:
  `AgentStartedEvent`, `AgentMessageEvent`, `AgentToolCallEvent`, `AgentToolResultEvent`, `AgentCompletedEvent`, `AgentFailedEvent`, `AgentRecoveryCancelledEvent`, `AgentStreamDeltaEvent`, `AgentProgressEvent`, `AgentMemoryRecalledEvent`, `AgentSkillsCompiledEvent`, `AgentInteractionRequiredEvent`, `AgentInteractionResolvedEvent`.
- Routing:
  `TaskDescriptor`, `RoutingDecision`, `TaskRoutingStrategy`.
- Skill capability matrix:
  `CapabilityStatus`, `ProviderCapabilityRow`, `SkillCapabilityMatrix`.
- DzupAgent config/path:
  `CodexMemoryStrategy`, `AdapterMemoryConfig`, `DzupAgentConfig` (deprecated alias), `DzupAgentPaths`.
- Run-store/governance:
  `RawAgentEvent`, `AgentArtifactEvent`, `GovernanceEventKind`, `GovernanceEvent`, `RunStatus`, `RunSummary`.
- Utility:
  `withCorrelationId`.

## Dependencies
- Runtime dependencies:
  none in `package.json`.
- Dev dependencies:
  `tsup`, `typescript`.
- Scripts:
  `build` (`tsup`), `lint` (`eslint src/`), `test` (`vitest run`), `typecheck` (`tsc --noEmit`).
- Build/export surface:
  ESM-only export map at `"."` -> `dist/index.js` with types at `dist/index.d.ts`.

## Integration Points
- `packages/agent-adapters/src/types.ts`
  Re-exports the full surface from `@dzupagent/adapter-types`.
- `packages/agent/src/orchestration/provider-adapter/provider-execution-port.ts`
  Imports only adapter-types contracts to preserve dependency inversion between `agent` and `agent-adapters`.
- `packages/codegen/src/generation/codegen-run-engine.ts`
  Uses `AgentCLIAdapter`, `AgentInput`, `AgentEvent`, and terminal event types to drive adapter-based codegen flow.
- `packages/agent-adapters/src/providers.ts`
  Re-exports adapter contract types (including governance types) for provider-focused consumers.
- `packages/agent-adapters/src/persistence.ts`
  Re-exports `RawAgentEvent`, `ProviderRawStreamEvent`, `AgentArtifactEvent`, and `RunSummary`.
- `packages/agent-adapters/src/skills/skill-capability-matrix.ts`
  Uses capability matrix contracts and `AdapterProviderId`.
- `packages/adapter-rules/src/types.ts` and `packages/adapter-rules/src/compiler.ts`
  Use `AdapterProviderId` in compile-time/runtime plan types and matching logic.
- `packages/create-dzupagent/src/bridge.ts`
  Mirrors `DzupAgentPaths` shape for optional dynamic wiring.

## Testing and Observability
- Package test suites:
  - `adapter-types.test.ts`
  - `adapter-types.integration.test.ts`
  - `agent-cli-adapter-contract.test.ts`
  - `adapter-config-variants.test.ts`
  - `adapter-routing-contracts.test.ts`
  - `adapter-run-store-contracts.test.ts`
  - `correlation.test.ts`
- Verified on this refresh:
  - `yarn workspace @dzupagent/adapter-types test` passed (`7` files, `20` tests).
  - `yarn workspace @dzupagent/adapter-types typecheck` passed.
- Observability-related contract features:
  - `correlationId` available on `AgentInput`, all `AgentEvent` payloads, and run-store entities.
  - Explicit stream/progress/interaction events (`adapter:stream_delta`, `adapter:progress`, `adapter:interaction_required`, `adapter:interaction_resolved`).
  - Raw provider side-channel modeled by `adapter:provider_raw` and `RawAgentEvent`.
  - Governance telemetry plane modeled by `GovernanceEvent`.

## Risks and TODOs
- Add a package-level `README.md` to document public contracts for external adapter authors.
- Keep provider-id checks aligned with the current union: some tests still use representative provider subsets and do not assert all union members (`gemini-sdk`, `openai` are not covered in the baseline provider list test).
- Consider adding compile-time API lock tests (for example `tsd`-style assertions) alongside runtime fixture tests to catch accidental type drift.
- `DzupAgentConfig` is a deprecated alias of `AdapterMemoryConfig`; consumers should migrate to the non-deprecated name.
- `src/index.ts` is a broad barrel; monitor merge pressure as contract count grows.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

