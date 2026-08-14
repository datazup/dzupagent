# @dzupagent/agent-adapters — Package Architecture

This document supplements the root `ARCHITECTURE.md` with package-specific detail.

## Package Export Subpaths

| Subpath             | Purpose                                                                         |
| ------------------- | ------------------------------------------------------------------------------- |
| `.`                 | Root compatibility barrel — broad export surface for legacy consumers           |
| `./codex-goal-control` | Source-observed Codex App Server goal capability and admitted lifecycle companion |
| `./providers`       | Provider adapter contracts, concrete adapters, registry primitives, and helpers |
| `./orchestration`   | Multi-agent orchestration, sessions, context routing, and integration bridge    |
| `./workflow`        | Workflow DSL builder, resolver, and validator                                   |
| `./http`            | HTTP handler, request schemas, and rate limiting                                |
| `./persistence`     | Checkpoint, run manager, run log, and run event store helpers                   |
| `./pipeline`        | Adapter pipeline steps and runtime tool bridge for compiled flows              |
| `./runs`            | Run-log accessors and run-event persistence                                     |
| `./integration`     | Adapter-as-tool bridge, external-tool integration, and MCP helpers              |
| `./dzupagent`       | `.dzupagent`/UCL ingestion helpers, skill projection, and script automation     |
| `./rules`           | Adapter-rule RuntimePlan preparation, governance diagnostics                    |
| `./learning`        | Learning loop, A/B testing, interaction policy, and enrichment pipeline         |
| `./recovery`        | Recovery copilot, policies, escalation, cross-provider handoff, approval gates  |
| `./skills`          | Skill loading, indexing, registry, and prompt assembly helpers                  |
| `./enrichment`      | Task enrichment planning, context enrichment, and execution helpers             |
| `./hard-budget`     | Versioned profiles, exact provider preflight, and usage reconciliation          |
| `./fleet-executors` | Fleet executor implementations and registry for multi-repo orchestration runs   |
| `./subagents`       | Subagent runtime helpers and integration surface                                |
| `./routing`         | Deterministic candidate materialization, selection, transition, and recovery    |
| `./introspection`   | Safe installation probes, live/replayed capability observation, drift, and re-probe policy |
| `./observability/dashboard` | Adapter-monitor dashboard projection and subscriber diagnostics       |

All subpaths are defined in `package.json` `exports`. New consumers should prefer subpath imports over the root `.` barrel. Monitoring implementations import their contracts from the matching `@dzupagent/adapter-types/monitoring/*` plane.

## Strict Provider Input Budgets

The hard-budget subpath keeps enablement explicit. A host supplies model limits,
tokenizer provenance, and a local reservation counter. Profiles that require a
provider preflight also bind an expiring model snapshot, request-format
revision/fingerprint, proof endpoint revision, and maximum proof age.

`OpenAIAdapter` retains Chat Completions as its default transport. The opt-in
`responses` transport can use the OpenAI Responses input-token endpoint through
`createOpenAIResponsesInputTokenProofBinding`. The counter and generation paths
share `buildOpenAIResponsesInputRequest`; generation stays closed when the
snapshot, binding, proof, or final input limit is invalid. Terminal input usage
is reconciled through prompt-free telemetry. No provider/model limits are
pre-filled by the package.

## Codex App Server capability and backend

The goal-control subpath keeps observation separate from execution. A
provider-free observer consumes a canonical executable identity with a bounded
SHA-256 artifact digest, verifies that digest before every probe, reads the installed Codex version, and generates the
version-specific App Server JSON Schema into a bounded temporary directory. It
hashes sorted relative paths plus exact bytes; verifies initialize, base
execution, resume, interrupt, stream, usage, approval/input-request, and goal
RPC shapes; deletes the raw corpus; and returns only a provider-session
capability descriptor. Missing methods, shape drift, version/digest drift,
SDK/CLI backends, timeouts, output limits, and process or schema failures are
all unsupported with emulation forbidden.

The explicit App Server backend requires an admitted exact attempt binding. Its
private stdio client is shared with goal control and bounds request time,
execution time, cleanup, line and aggregate bytes, frames, pending requests,
and queued events. Runtime construction requires the private resolved
executable identity used by observation, including the artifact digest bound to
the durable descriptor without a host path. The client rechecks canonical path,
regular-file type, execute access, and digest before spawning the canonical
path, then rechecks the digest before `initialize`; goal control has no PATH
fallback. The durable descriptor and normalized events never expose the path.
The client validates and discards the complete initialize response. Execution
validates complete thread and turn results/notifications and compares the
admitted CLI version plus requested cwd, model, and sandbox against the
provider's effective response before `turn/start` or terminal authority.

One monotonic deadline begins at execution entry and supplies only its remaining
budget to executable qualification, initialize, thread start/resume, turn start,
and stream observation. Timeout and cancellation are local terminal decisions:
later deltas, interaction requests, usage, or successful terminal frames are
discarded and cannot restore completion. Supplied-signal cancellation and the
adapter-wide emergency interrupt are registered before executable qualification
and cover initialize/initialized, thread start/resume, and turn start. Before an
exact turn identity exists they abort setup and close any created client;
afterward they enter the exact-turn interrupt path, so stalled setup cannot wait
for the execution deadline. Every exact interrupt caller awaits one shared
provider acknowledgement; `accepted: true` means that RPC returned the exact
observed empty-object acknowledgement. Schema-invalid acknowledgements reject
every shared caller.
Interrupt acknowledgement has a separate at-most-250 ms grace. Normal or failed
handshake cleanup shares one idempotent two-stage promise: at most one SIGTERM
wait followed by at most one SIGKILL wait, each one second by default and only
tighten-able. Cleanup failure is reduced to a stable sanitized code.

The client rejects malformed, duplicate, late, overflowing, stale, artifact-
drifted, schema-invalid, and post-death protocol activity. One thread/turn can start or
resume, stream normalized message deltas, report per-turn usage, and interrupt
the exact active turn. Approval and input requests are surfaced without a
response before a local terminal decision; interaction resolution therefore
remains unsupported. SDK remains the default Codex backend, CLI remains an
explicit fallback, and App Server has no production profile.

The descriptor grants no auth, attempt, effect, retry, fallback, repository,
provider-spend, or completion authority. A host such as IO must separately bind
an accepted descriptor to an execution attempt and independently verify all
repository effects.

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
