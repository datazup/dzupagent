# @dzupagent/agent Architecture

## Scope
This document describes the current implementation of `packages/agent` in `dzupagent` from the local codebase:
- `packages/agent/src/**`
- `packages/agent/package.json`
- `packages/agent/README.md`
- `packages/agent/docs/api-tiers.md`

It covers package-owned runtime behavior, exported API surfaces, and internal module boundaries. It does not restate implementation details of sibling packages (`@dzupagent/core`, `@dzupagent/context`, `@dzupagent/memory`, `@dzupagent/security`, etc.) beyond how this package integrates with them.

## Responsibilities
`@dzupagent/agent` is the framework package that assembles agent execution, tool loops, workflow/pipeline runtime, and multi-agent orchestration into a single consumable API.

Current responsibilities include:
- `DzupAgent` lifecycle (`generate`, `generateStructured`, `stream`, `asTool`, `launch`, `consolidate`).
- ReAct-style tool loop execution (`runToolLoop`) with budgeting, stuck detection, permission/gov/safety hooks, and timeout/validation controls.
- Instruction resolution (`static` + optional `AGENTS.md` discovery/merge).
- Memory context loading (standard memory and Arrow frame selection) and optional write-back.
- Guardrails (`IterationBudget`, `StuckDetector`, `CascadingTimeout`) and distributed guardrail primitives.
- Workflow builder/compiler and execution via pipeline runtime.
- Pipeline execution features (validation, retries, checkpoint stores, resume/suspend, analytics).
- Multi-agent orchestration (supervisor/map-reduce/contract-net/delegation/topology/routing/team runtime).
- Structured output generation and capability strategy detection.
- Supporting operational subsystems: approval, tool registry/schema compatibility, snapshots/replay, security signing, mailbox/cluster, token lifecycle hooks, and observability bridges.

## Structure
### Public entrypoints (`package.json` exports)
- `.` -> `src/index.ts` (full barrel)
- `./agent` -> `src/agent.ts`
- `./orchestration` -> `src/orchestration.ts`
- `./self-correction` -> `src/self-correction.ts`
- `./replay` -> `src/replay.ts`
- `./pipeline` -> `src/pipeline.ts`
- `./runtime` -> `src/runtime.ts`
- `./workflow` -> `src/workflow.ts`
- `./tools` -> `src/tools.ts`
- `./compat` -> `src/compat.ts` (explicitly transitional/deprecated facade)

### Source layout (`src/`)
Top-level module groups:
- `agent/` (core runtime, run engine, tool loop, run handles, middleware/instruction/memory resolution)
- `workflow/` (builder + compiler + compiled workflow runtime wrapper)
- `pipeline/` (runtime/executor/validator/checkpoint stores/retry/templates/analytics)
- `orchestration/` (orchestrator patterns, delegation/planning, contract-net, topology, routing, team runtime)
- `guardrails/`, `approval/`, `tools/`, `structured/`, `streaming/`, `snapshot/`, `replay/`, `security/`
- `instructions/` (`AGENTS.md` parser/loader/merge)
- `recovery/`, `reflection/`, `self-correction/`
- `mailbox/`, `cluster/`, `skill-chain-executor/`, `observability/`
- `context/` (compatibility wrappers over `@dzupagent/context`)

Current local footprint:
- Files under `src/`: `554`
- TypeScript files: `535`
- Test/spec files (`*.test.ts`/`*.spec.ts`): `216`
- Module-local architecture docs: `19`

## Runtime and Control Flow
1. `DzupAgent` constructor validates config (`validateConfig`), resolves model/provider/tier (`resolveModel`), wires event-bus-aware subsystems (`installEventBus`), and computes effective tool permission tier.
2. `generate(messages, options)` calls `prepareRunState(...)`:
- builds guardrails/budget defaults,
- resolves instructions + memory context,
- scans/possibly sanitizes human input (`@dzupagent/security` scanner policy),
- injects prompt-cache markers,
- filters tools by permission policy,
- configures model binding and optional stuck detector/learning hook.
3. `executeGenerateRun(...)` runs the loop and result finalization:
- drives `runToolLoop(...)`,
- handles approval suspension (`ApprovalSuspendedError` -> suspended result path),
- records/updates run-state snapshots when configured,
- emits lifecycle telemetry and performs output filtering,
- triggers optional memory write-back on non-failed stop reasons.
4. `runToolLoop(...)` iterates until terminal condition:
- records budget + usage,
- optional token lifecycle compression/halt,
- executes tool calls sequentially or parallel scheduler path,
- applies policy-enabled tool executor (governance/permission/validator/timeout/safety),
- handles stuck escalation and optional checkpoint recovery hook,
- returns terminal `stopReason` (`complete`, `iteration_limit`, `budget_exceeded`, `aborted`, `error`, `stuck`, `token_exhausted`, `approval_pending`).
5. `stream(...)` delegates to `streamRun(...)`:
- reuses `prepareRunState`,
- uses native model streaming when available and middleware constraints allow it,
- otherwise uses explicit non-stream fallback path,
- applies the same tool-execution policy surface through `buildStreamingToolPolicy(...)`.
6. Workflow and orchestration layers build on top of this runtime:
- `WorkflowBuilder` -> `compileWorkflow` -> `CompiledWorkflow.run/resume/stream` -> `PipelineRuntime`.
- Higher-level orchestration (`AgentOrchestrator`, delegation/planning, map-reduce, contract-net, topology, team runtime) coordinates one or many agents using those lower-level execution primitives.

## Key APIs and Types
### Primary class and core execution
- `DzupAgent`
- `runToolLoop`
- `ConcreteRunHandle`, `RunHandle`, `RunResult`, `LaunchOptions`
- `executeToolsParallel`

### Config and runtime contracts
- `DzupAgentConfig`
- `GenerateOptions`, `GenerateResult`, `AgentStreamEvent`
- `ToolExecutionConfig` and production governance preset helpers (`createProductionToolGovernancePreset`, `withProductionToolGovernancePreset`)

### Subpath-oriented API surface
- `@dzupagent/agent/agent`: core agent runtime + guardrails + approval + loop errors.
- `@dzupagent/agent/runtime`: runtime-focused facade (agent + loop + pipeline + observability).
- `@dzupagent/agent/workflow`: workflow/orchestration/skill-chain facade.
- `@dzupagent/agent/orchestration`: orchestration and team-runtime patterns.
- `@dzupagent/agent/pipeline`: runtime/checkpoint/retry/templates/analytics.
- `@dzupagent/agent/tools`: tool factories, registry, guardrail/approval helpers.
- `@dzupagent/agent/replay`: trace capture/replay/inspection surface.
- `@dzupagent/agent/self-correction`: reflection/learning/correction bundle.
- `@dzupagent/agent/compat`: transitional compatibility exports.

### Additional notable exported primitives
- Guardrails: `IterationBudget`, `StuckDetector`, `CascadingTimeout`, distributed limiter/budget.
- Structured: `generateStructuredOutput`, `detectStrategy`.
- Workflow: `WorkflowBuilder`, `CompiledWorkflow`, `createWorkflow`.
- Pipeline: `PipelineRuntime`, `validatePipeline`, `executeLoop`, checkpoint stores, `PipelineAnalytics`.
- Orchestration: `AgentOrchestrator`, `DelegatingSupervisor`, `PlanningAgent`, `ContractNetManager`, topology/routing/merge policies, `TeamRuntime`.
- Operations: `ApprovalGate`, `AgentAuth`, `ToolSchemaRegistry`, `StreamActionParser`, snapshot/replay serializers, run metrics bridge.

## Dependencies
### Declared runtime dependencies (`package.json`)
- `@dzupagent/adapter-types`
- `@dzupagent/agent-types`
- `@dzupagent/context`
- `@dzupagent/core`
- `@dzupagent/memory`
- `@dzupagent/memory-ipc`
- `@dzupagent/runtime-contracts`
- `@dzupagent/security`

### Peer dependencies
- `@langchain/core >=1.0.0`
- `@langchain/langgraph >=1.0.0`
- `zod >=4.0.0`

### Build/test toolchain
- TypeScript (`strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, NodeNext)
- `tsup` multi-entry ESM build (root + subpath entry files)
- Vitest (`node` env, v8 coverage, tests from `src/**/*.test.ts` and `src/**/*.spec.ts`)

## Integration Points
- `@dzupagent/core`:
- model registry/fallback and provider failover wiring
- event bus contracts and lifecycle emissions
- pipeline and persistence primitives
- shared tool governance/security abstractions
- `@dzupagent/context`:
- context compression (`autoCompress`) and token lifecycle manager integration
- prompt cache marker helpers
- `@dzupagent/memory` + `@dzupagent/memory-ipc`:
- memory read/write and Arrow-budgeted retrieval pipeline
- `@dzupagent/security`:
- prompt-injection/PII scanning and sanitization/blocking in input preparation
- LangChain:
- chat model/message/tool interfaces used as host contracts
- `@dzupagent/runtime-contracts`:
- pipeline runtime type re-exports/shims for compatibility boundaries

## Testing and Observability
### Testing
- Runner/config: `vitest run` with package-local config in `vitest.config.ts`.
- Coverage provider: v8 with explicit exclusions for tests/fixtures/index barrels.
- Test footprint is broad (216 test/spec files) and includes:
- agent loop/runtime (`dzip-agent`, run engine, tool loop, policy/timeout/permission)
- streaming and stream parser/handle paths
- orchestration (orchestrator, delegation, planning, topology, contract-net, team runtime)
- pipeline runtime/retry/checkpoint/analytics
- self-correction/recovery/reflection/learning
- mailbox/cluster/skill-chain/instructions/snapshot/replay

### Observability
- Event bus is first-class across runtime and orchestration flows (`agent:*`, `tool:*`, `llm:*`, `run:*`, `checkpoint:*` surfaces).
- `RunMetricsAggregator` + `attachRunMetricsBridge(...)` provide in-process run dashboards from bus events.
- `InMemoryAuditStore` captures LLM call audit entries (`LlmCallAuditEntry`) for development/testing.
- Pipeline runtime emits typed lifecycle events and supports optional tracer hooks (`PipelineTracer`, OTel-like span contract).

## Risks and TODOs
- README example drift: `README.md` quick-start still uses older config/call patterns (`systemPrompt`, string message inputs, `asTool` options) while current runtime expects `instructions` and `BaseMessage[]` shapes.
- Root barrel scale: `src/index.ts` is large and mixes stable + advanced + experimental exports; drift risk is managed but still high.
- Compatibility surface debt: `./compat` remains intentionally transitional and marked for future removal; consumers still depending on it delay cleanup.
- API governance consistency: `docs/api-tiers.md` is present and useful, but it must remain in lockstep with root export changes to avoid contract ambiguity.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

