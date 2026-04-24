## Findings

### High: Eval orchestration has two active implementations with divergent lifecycle semantics

Impact: The server route layer and the `@dzupagent/evals` package can execute the same eval route contract through different state machines. That is a true maintainability risk because fixes to leasing, retry, cancellation, attempt history, metrics, or persistence can land in one implementation while the other remains behaviorally stale.

Evidence: `packages/evals/src/orchestrator/eval-orchestrator.ts:1` says the full `EvalOrchestrator` moved out of server and into `@dzupagent/evals`. That package implementation owns queue state, active controllers, lease refresh timers, startup reconciliation, concurrency, and counters at `packages/evals/src/orchestrator/eval-orchestrator.ts:60`, starts reconciliation in the constructor at `packages/evals/src/orchestrator/eval-orchestrator.ts:84`, requeues stale persisted runs at `packages/evals/src/orchestrator/eval-orchestrator.ts:257`, and claims runs with ownership checks at `packages/evals/src/orchestrator/eval-orchestrator.ts:508`. The server route file still contains a separate `DefaultEvalOrchestrator` at `packages/server/src/routes/evals.ts:178`, with its own queue stats and execution loop at `packages/server/src/routes/evals.ts:184`, `packages/server/src/routes/evals.ts:199`, and `packages/server/src/routes/evals.ts:222`. It initializes new runs with `attempts: 0` at `packages/server/src/routes/evals.ts:203`, while the package orchestrator initializes attempt history and `attempts: 1` at `packages/evals/src/orchestrator/eval-orchestrator.ts:111`. The strongest server tests inject the package orchestrator explicitly at `packages/server/src/__tests__/eval-routes.test.ts:46` and `packages/server/src/__tests__/eval-lease-recovery.integration.test.ts:94`, so those tests do not prove the default in-route implementation has the same lifecycle behavior.

Remediation: Remove the in-route `DefaultEvalOrchestrator` as an independently maintained executor. Prefer making `createEvalRoutes` require either an injected `EvalOrchestratorLike`, an `orchestratorFactory`, or a small wrapper around the package implementation. If a lightweight in-process fallback is still needed, move it into `@dzupagent/evals`, test it beside `EvalOrchestrator`, and have server import it through the contract seam rather than carrying a second state machine.

### Medium: Subprocess bridges treat partial protocol output as success without checking process exit status

Impact: Child-process integrations become fragile when a subprocess writes stdout and then exits non-zero. Callers may receive parsed output or a streamed result even though the child process failed, which makes later failures harder to diagnose and can hide broken tools behind apparently valid protocol frames.

Evidence: `packages/core/src/mcp/mcp-client.ts:448` resolves the stdio call when `code === 0 || stdout.length > 0`, so any non-zero MCP child that wrote stdout is treated as successful at `packages/core/src/mcp/mcp-client.ts:449`. The compile bridge reads stdout NDJSON and stops on a `result` or `error` line at `packages/server/src/routes/spawn-compiler-bridge.ts:117`, flushes remaining stdout tail at `packages/server/src/routes/spawn-compiler-bridge.ts:147`, then waits for `close` at `packages/server/src/routes/spawn-compiler-bridge.ts:159` without inspecting the close code or stderr.

Remediation: Capture the child `close` code and stderr in both paths. Resolve only when the process exits `0` or when an explicit, documented terminal protocol event is allowed to override exit status. Add focused tests for: non-zero exit with stdout, non-zero exit after a terminal `result`, malformed tail plus non-zero exit, and child spawn error.

### Medium: `EvalOrchestrator` is exported runtime logic without package-local direct tests

Impact: `EvalOrchestrator` is a queue, lease, retry, cancellation, recovery, and metrics coordinator, but the package-local test surface is centered on scorers and runners. Server integration tests exercise some injected behavior, yet package-local regressions in lease refresh, startup reconciliation, attempt history, and concurrency can drift without a direct `@dzupagent/evals` feedback loop.

Evidence: The implementation spans queue state at `packages/evals/src/orchestrator/eval-orchestrator.ts:60`, startup reconciliation at `packages/evals/src/orchestrator/eval-orchestrator.ts:257`, drain scheduling at `packages/evals/src/orchestrator/eval-orchestrator.ts:342`, execution and terminal updates at `packages/evals/src/orchestrator/eval-orchestrator.ts:412`, claiming at `packages/evals/src/orchestrator/eval-orchestrator.ts:508`, and lease refresh at `packages/evals/src/orchestrator/eval-orchestrator.ts:615`. A current static search found no `EvalOrchestrator` references under `packages/evals/src/__tests__`; representative package-local tests import `runEvalSuite` and scorer classes instead at `packages/evals/src/__tests__/eval-runner.test.ts:1` and `packages/evals/src/__tests__/scorers.test.ts:1`. The direct `EvalOrchestrator` usages found in tests are server route/integration tests, for example `packages/server/src/__tests__/eval-routes.test.ts:51` and `packages/server/src/__tests__/eval-lease-recovery.integration.test.ts:95`.

Remediation: Add `packages/evals/src/__tests__/eval-orchestrator.test.ts` with a fake `EvalRunStore`, fake metrics collector, and deterministic `executeTarget`. Cover startup recovery, queued-to-running claiming, concurrent drain limits, cancellation, retry attempt history, lease refresh abort behavior, and metric counters. Keep server tests focused on route mapping and dependency injection.

### Medium: Large runtime hotspots mix orchestration, policy, telemetry, recovery, and persistence in single files

Impact: These files are not merely long; they carry multiple independent invariants in one edit surface. That increases review cost and makes localized fixes risky because retry, stuck detection, calibration, iteration budget, checkpointing, and recovery can interact through shared mutable state.

Evidence: `packages/agent/src/pipeline/pipeline-runtime.ts` is 1,065 lines in the current scan. Its main `executeFromNode` loop handles cancellation, resume skipping, suspend/gate behavior, fork/join, loop nodes, retry, telemetry spans, stuck detection, recovery, calibration, iteration budgets, checkpointing, and edge selection between `packages/agent/src/pipeline/pipeline-runtime.ts:250` and `packages/agent/src/pipeline/pipeline-runtime.ts:604`; recovery copilot integration is still in the same class at `packages/agent/src/pipeline/pipeline-runtime.ts:981`. `packages/agent-adapters/src/recovery/adapter-recovery.ts` is 1,341 lines and contains both `AdapterRecoveryCopilot` and stream-yielding recovery paths; one recovery loop starts at `packages/agent-adapters/src/recovery/adapter-recovery.ts:388`, another stream-oriented loop starts at `packages/agent-adapters/src/recovery/adapter-recovery.ts:846`, and strategy selection/application is in the same file at `packages/agent-adapters/src/recovery/adapter-recovery.ts:1138` and `packages/agent-adapters/src/recovery/adapter-recovery.ts:1171`.

Remediation: Do not refactor these files for style alone. Extract along existing invariants: pipeline node execution policy, checkpoint writer, runtime side-effect hooks, recovery attempt executor, and recovery strategy planner. Preserve current tests and add golden event-order tests before moving logic. Prioritize extractions only when touching these files for functional changes.

### Low: Correlation propagation still uses object mutation and double casts despite typed event support

Impact: This is a maintainability and type-safety smell, not a current correctness failure. The shared event contract already includes optional `correlationId`, but some adapters still mutate emitted event objects after mapping through `as unknown as Record<string, unknown>`. That bypasses discriminated-event construction and can unexpectedly mutate provider-owned event objects if a mapper returns reused objects.

Evidence: The shared `AgentEvent` union includes `correlationId` on event interfaces, for example `AgentStartedEvent` at `packages/adapter-types/src/contracts/events.ts:21`, `AgentMessageEvent` at `packages/adapter-types/src/contracts/events.ts:40`, `AgentToolCallEvent` at `packages/adapter-types/src/contracts/events.ts:50`, and terminal events at `packages/adapter-types/src/contracts/events.ts:71` and `packages/adapter-types/src/contracts/events.ts:83`. `BaseCliAdapter` still injects the field by mutating the mapped event at `packages/agent-adapters/src/base/base-cli-adapter.ts:521`. `CodexAdapter` does the same for mapped provider events at `packages/agent-adapters/src/codex/codex-adapter.ts:756`.

Remediation: Replace mutation with a typed helper such as `withCorrelationId<T extends AgentEvent>(event: T, correlationId?: string): T` that returns `event` unchanged when absent and returns `{ ...event, correlationId }` when present. Use it in base CLI, Codex, Claude, Gemini, and any adapter that currently spreads or mutates correlation fields, then keep the existing correlation tests as regression coverage.

## Scope Reviewed

This is a current-code baseline review for code quality only. I reviewed the live repository under `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent`, the prepared prompt pack at `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-24/run-002/codex-prep`, root quality configuration, package source, and representative test files.

Static review signals gathered:

- Production source/test file counts: 1,321 non-test TS/TSX source files and 1,066 TS/TSX test/spec files under `packages/*/src`.
- Source/test directory spread: 258 production source directories and 82 test-bearing source directories.
- Large-file scan for complexity hotspots.
- Static search for explicit `any`, double casts, TODO/FIXME/stub markers, subprocess exit-code handling, duplicate implementation names, and direct test references.

No runtime validation, typecheck, lint, build, or test command was run for this audit document.

## Strengths

- The production source is largely disciplined on explicit `any`: the focused scan for `as any`, `: any`, `Record<string, any>`, and related forms in non-test `packages/*/src` files returned no production hits. This aligns with the root ESLint `@typescript-eslint/no-explicit-any: error` rule at `eslint.config.js:51`.
- The repo has real guardrail scripts rather than only documentation. `yarn verify` chains runtime inventory, drift, boundary, terminal-event, build, typecheck, lint, and test checks from `package.json:33`.
- Architectural boundary checks are codified. `scripts/check-domain-boundaries.mjs:21` defines forbidden domain imports and fails on production imports under `packages/`, which helps prevent extracted domain logic from creeping back into framework packages.
- The runtime-critical test inventory is explicit. `scripts/check-runtime-test-inventory.mjs:18` names runtime-critical packages, including `agent`, `agent-adapters`, `evals`, `memory`, `rag`, and `server`.
- Many high-risk hotspots already have tests. For example, `PipelineRuntime` has direct tests in `packages/agent/src/__tests__/pipeline-runtime.test.ts:1`, retry/timeout/cancel coverage in `packages/agent/src/__tests__/pipeline-runtime.cancel-timeout-retry.test.ts:1`, and helper/edge coverage in nearby test files. `AdapterRecoveryCopilot` also has focused tests in `packages/agent-adapters/src/__tests__/adapter-recovery.test.ts:351` and `packages/agent-adapters/src/__tests__/recovery-backoff.test.ts:381`.

## Open Questions Or Assumptions

- I treated prior audit artifacts as comparison-only context and did not reuse their severity ranking as evidence.
- I assumed the server in-route `DefaultEvalOrchestrator` remains reachable because `createEvalRoutes` instantiates it when `executeTarget` is supplied without `orchestrator` or `orchestratorFactory` at `packages/server/src/routes/evals.ts:400`.
- I did not classify filename-level duplication such as `index.ts`, `errors.ts`, or compatibility re-export files as findings unless there was a clear behavioral or maintenance risk.
- I did not claim dead code solely from lack of direct imports. Public exports and package subpaths can be valid consumer APIs even when repo-local references are sparse.
- The zero-test observation is static and package-local. It does not mean `EvalOrchestrator` has no indirect coverage; it means direct tests are currently outside the owning package or absent from the package-local test tree.

## Recommended Next Actions

1. Resolve the eval orchestration duplication first. Make the server route layer delegate to the package implementation or require an injected orchestrator, then add package-local tests for the chosen default behavior.
2. Harden subprocess exit-code handling in `MCPClient.spawnWithStdin` and `spawn-compiler-bridge`, with focused tests for stdout-plus-nonzero and terminal-event-plus-nonzero cases.
3. Add direct `@dzupagent/evals` tests for `EvalOrchestrator` before expanding eval features or changing server eval routes.
4. When functional work next touches `PipelineRuntime` or `adapter-recovery`, extract one invariant at a time behind existing tests instead of doing a broad cleanup pass.
5. Replace adapter event mutation for correlation IDs with a typed helper. This is lower urgency than the runtime-state findings but is a cheap way to reduce future type drift.
