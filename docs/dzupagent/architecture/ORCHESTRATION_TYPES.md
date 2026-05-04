# Orchestration Config Types

This document describes how multi-agent orchestration configuration types are
shared across the framework. The goal is a single source of truth for the
conceptual shape of each pattern, with each consuming package free to layer
its own runtime-specific fields on top.

> Audit reference: A-03 (Architecture / High) — `SupervisorConfig`,
> `MapReduceConfig`, and `ContractNetConfig` were defined independently in
> `@dzupagent/agent` and `@dzupagent/agent-adapters` and had drifted over
> time. The base contracts below establish the shared structural skeleton.

## Base Contracts (in `@dzupagent/agent-types`)

All base contracts live in `packages/agent-types/src/orchestration-contracts.ts`
and are re-exported from the package root. `@dzupagent/agent-types` sits at
Layer 0 of the dependency graph and has no runtime imports — base contracts
therefore reference only the `TAgent` type parameter (and never Layer 1+
runtime symbols such as `DzupEventBus` or `ProviderAdapterRegistry`).

| Base Contract | Purpose |
|---------------|---------|
| `BaseSupervisorContract<TAgent>` | Supervisor pattern: one coordinator + N specialists. Provides `specialists?`, `selectionStrategy?`, `maxDelegations?`. |
| `BaseMapReduceContract<TAgent, TChunk, TResult>` | Map-reduce: parallel mappers + optional reducer. Provides `mappers?`, `reducer?`, `maxConcurrency?`, `chunkSize?`, `mergeFn?`. |
| `BaseContractNetContract<TAgent>` | Contract-Net: bidding mechanism for task allocation. Provides `bidders?`, `evaluator?`, `bidTimeoutMs?`. |

The fields on each base are deliberately optional. This allows the two
specializations (agent-centric vs. registry-centric) to inherit from the
same skeleton without forcing a required field that one side cannot supply.
Each specialization is free to *tighten* the optionality of any field it
genuinely requires (e.g. the agent-side `SupervisorConfig` declares
`specialists: DzupAgent[]` as required even though the base has it
optional — required is a valid subtype refinement of optional).

## Specializations

| Package | Collaborator (`TAgent`) | `SupervisorConfig` | `MapReduceConfig` | `ContractNetConfig` |
|---------|-------------------------|--------------------|-------------------|---------------------|
| `@dzupagent/agent` | `DzupAgent` | `extends BaseSupervisorContract<DzupAgent>` | `extends BaseMapReduceContract<DzupAgent, string, string>` | `extends BaseContractNetContract<DzupAgent>` |
| `@dzupagent/agent-adapters` | `AgentCLIAdapter` | `extends BaseSupervisorContract<AgentCLIAdapter>` | `extends BaseMapReduceContract<AgentCLIAdapter>` | `extends BaseContractNetContract<AgentCLIAdapter>` |

### Where the specializations live

- Agent package
  - `packages/agent/src/orchestration/orchestrator.ts` — `SupervisorConfig`
  - `packages/agent/src/orchestration/map-reduce.ts` — `MapReduceConfig`
  - `packages/agent/src/orchestration/contract-net/contract-net-types.ts` — `ContractNetConfig`
- Adapter package
  - `packages/agent-adapters/src/orchestration/supervisor.ts` — `SupervisorConfig`
  - `packages/agent-adapters/src/orchestration/map-reduce.ts` — `MapReduceConfig`
  - `packages/agent-adapters/src/orchestration/contract-net.ts` — `ContractNetConfig`

### Specialization-only fields

Agent-side specializations add agent-centric collaborators and policy hooks
(`manager`, `task`, `routingPolicy`, `mergeStrategy`, `circuitBreaker`,
`bidDeadlineMs`, `requiredCapabilities`, `retryOnNoBids`, `signal`,
`eventBus`, `executionMode`, `providerPort`, etc.).

Adapter-side specializations add registry-centric coordination
(`registry: ProviderAdapterRegistry`, `decomposer`, `bidStrategy`,
`maxConcurrentDelegations`, `maxConcurrency`) plus the shared `eventBus`.

These fields remain in their owning package because they reference Layer 1+
runtime types (`DzupAgent`, `ProviderAdapterRegistry`, `DzupEventBus`)
that cannot be hoisted into Layer 0 without violating the dependency graph.

## Adding a new orchestration pattern

1. Define `BaseXxxContract<TAgent>` in `packages/agent-types/src/orchestration-contracts.ts`. Keep all fields optional and reference only `TAgent` (no runtime imports).
2. Re-export the new base type from `packages/agent-types/src/index.ts`.
3. Create or update the specialization in `@dzupagent/agent` so the local config interface `extends BaseXxxContract<DzupAgent>`.
4. Create or update the specialization in `@dzupagent/agent-adapters` so the local config interface `extends BaseXxxContract<AgentCLIAdapter>`.
5. Update the specialization table in this document.
6. Run `yarn workspace @dzupagent/agent-types typecheck`, then the same for `@dzupagent/agent` and `@dzupagent/agent-adapters`, plus the relevant orchestration tests.

## Why optional, why intersection

The two existing implementations are close in concept but very different in
runtime mechanics. The agent flavour passes around concrete `DzupAgent`
instances; the adapter flavour delegates to a `ProviderAdapterRegistry`.
Forcing them to share required fields would either break one side or
require synthetic adapters at every call site. Optional base fields plus
specialization via `extends` give us:

- A single place to evolve the conceptual contract.
- Compile-time guarantees that specializations remain structurally
  compatible with the base (TypeScript will reject any specialization that
  contradicts a base field's type).
- Zero runtime overhead — these are purely type-level constructs.
