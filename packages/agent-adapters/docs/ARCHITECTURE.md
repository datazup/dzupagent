# @dzupagent/agent-adapters — Package Architecture

This document supplements the root `ARCHITECTURE.md` with package-specific detail.

## Package Export Subpaths

| Subpath             | Purpose                                                                         |
| ------------------- | ------------------------------------------------------------------------------- |
| `.`                 | Root compatibility barrel — broad export surface for legacy consumers           |
| `./providers`       | Provider adapter contracts, concrete adapters, registry primitives, and helpers |
| `./orchestration`   | Multi-agent orchestration, sessions, context routing, and integration bridge    |
| `./workflow`        | Workflow DSL builder, resolver, and validator                                   |
| `./http`            | HTTP handler, request schemas, and rate limiting                                |
| `./persistence`     | Checkpoint, run manager, run log, and run event store helpers                   |
| `./runs`            | Run-log accessors and run-event persistence                                     |
| `./integration`     | Adapter-as-tool bridge, external-tool integration, and MCP helpers              |
| `./dzupagent`       | `.dzupagent`/UCL ingestion helpers, skill projection, and script automation     |
| `./rules`           | Adapter-rule RuntimePlan preparation, governance diagnostics                    |
| `./learning`        | Learning loop, A/B testing, interaction policy, and enrichment pipeline         |
| `./recovery`        | Recovery copilot, policies, escalation, cross-provider handoff, approval gates  |
| `./skills`          | Skill loading, indexing, registry, and prompt assembly helpers                  |
| `./enrichment`      | Task enrichment planning, context enrichment, and execution helpers             |
| `./fleet-executors` | Fleet executor implementations and registry for multi-repo orchestration runs   |
| `./subagents`       | Subagent runtime helpers and integration surface                                |

All subpaths are defined in `package.json` `exports`. New consumers should prefer subpath imports over the root `.` barrel.

## Key Runtime Components

- **ProviderAdapterRegistry** — routes tasks to provider adapters with health/circuit-breaker awareness.
- **OrchestratorFacade** — high-level orchestration API (`run`, `chat`, `parallel`, `race`, `supervisor`, `mapReduce`, `bid`).
- **ParallelExecutor** — concurrent multi-agent execution with result aggregation.
- **SupervisorOrchestrator** — hierarchical supervisor/worker orchestration pattern.
- **MapReduceOrchestrator** — map-then-reduce fan-out over a set of agents.
- **ContractNetOrchestrator** — contract-net bidding protocol for task allocation.
- **TagBasedRouter** — routes tasks by tag matching against registered adapters.
- **CapabilityRouter** — routes by declared adapter capability surface.
- **ContextAwareRouter** — routes using contextual signals (token budget, session state).

## Testing and Observability

- Runner: Vitest (`vitest.config.ts`, `environment: node`).
- Specs follow `src/**/*.test.ts` convention (including `src/__tests__` and module-local tests).
- Integration surfaces are tested via adapter fixture servers.
