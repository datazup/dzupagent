## Findings

### High: Eval execution has two live orchestrators with divergent lifecycle semantics

Impact: The same eval route contract can execute through two different state machines. That is a maintainability risk, not style noise: fixes to leasing, retry, cancellation, attempt history, startup recovery, queue metrics, or ownership checks can land in one orchestrator while the other remains behaviorally stale.

Evidence: `packages/evals/src/orchestrator/eval-orchestrator.ts:1` states that `EvalOrchestrator` moved from server into `@dzupagent/evals`, and that package implementation owns queue state, active controllers, lease refresh timers, startup reconciliation, concurrency, and counters at `packages/evals/src/orchestrator/eval-orchestrator.ts:60`. It starts persisted-run reconciliation in the constructor at `packages/evals/src/orchestrator/eval-orchestrator.ts:84`, initializes attempt history and `attempts: 1` at `packages/evals/src/orchestrator/eval-orchestrator.ts:111`, requeues stale persisted runs at `packages/evals/src/orchestrator/eval-orchestrator.ts:257`, claims runs with ownership checks at `packages/evals/src/orchestrator/eval-orchestrator.ts:508`, and refreshes execution leases at `packages/evals/src/orchestrator/eval-orchestrator.ts:615`. The server route still carries a separate `DefaultEvalOrchestrator` at `packages/server/src/routes/evals.ts:184`, with its own stats object at `packages/server/src/routes/evals.ts:185`, queue method at `packages/server/src/routes/evals.ts:199`, execution loop at `packages/server/src/routes/evals.ts:222`, and different initial `attempts: 0` value at `packages/server/src/routes/evals.ts:210`. That fallback is reachable when `createEvalRoutes` receives `executeTarget` without an injected orchestrator or factory at `packages/server/src/routes/evals.ts:400`. Current server tests mostly inject the package orchestrator explicitly, for example `packages/server/src/__tests__/eval-routes.test.ts:51` and `packages/server/src/__tests__/eval-lease-recovery.integration.test.ts:95`, so those tests do not prove the built-in route fallback has the same lifecycle behavior.

Remediation: Remove `DefaultEvalOrchestrator` as an independently maintained executor. Prefer requiring an injected `EvalOrchestratorLike` or `orchestratorFactory`, or move the lightweight fallback into `@dzupagent/evals` and import it through the existing contract seam. Add regression tests that prove the default route path and injected package path share the same attempt, cancellation, retry, metric, and recovery semantics.

### Medium: Subprocess bridges can treat partial protocol output as success without enforcing exit status

Impact: Child-process integrations are fragile when a subprocess writes stdout and then exits non-zero. Callers can receive parsed output or a streamed terminal event even though the child failed, which hides broken tools behind apparently valid protocol frames and makes later failures harder to diagnose.

Evidence: `packages/core/src/mcp/mcp-client.ts:448` resolves the stdio call when `code === 0 || stdout.length > 0`, so any non-zero MCP child that wrote stdout is treated as successful at `packages/core/src/mcp/mcp-client.ts:449`. The compile bridge reads stdout NDJSON at `packages/server/src/routes/spawn-compiler-bridge.ts:120`, yields parsed lines at `packages/server/src/routes/spawn-compiler-bridge.ts:138`, stops after a `result` or `error` event at `packages/server/src/routes/spawn-compiler-bridge.ts:140`, flushes a remaining tail at `packages/server/src/routes/spawn-compiler-bridge.ts:147`, and then waits for `close` at `packages/server/src/routes/spawn-compiler-bridge.ts:160` without inspecting the close code or stderr. There is a direct bridge test file at `packages/server/src/__tests__/spawn-compiler-bridge.test.ts:88`, but the reviewed implementation still does not gate success on the child exit code.

Remediation: Capture child close code and stderr in both paths. Resolve only when the process exits `0`, unless an explicit and documented terminal protocol event is allowed to override exit status. Add focused tests for non-zero exit with stdout, non-zero exit after terminal `result`, malformed tail plus non-zero exit, and spawn error propagation.

### Medium: Zero-test runtime package gate is currently red for shared contract packages

Impact: `@dzupagent/agent-types` and `@dzupagent/eval-contracts` are contract packages, so they may not need heavy runtime tests. They still encode fragile invariants used across package boundaries: retry-policy aliases, eval run status, attempt history, execution ownership, store update predicates, and orchestrator structural interfaces. With no package-local tests, compatibility drift can pass until a downstream package fails.

Evidence: I ran `node scripts/check-runtime-test-inventory.mjs` during this audit. It reported zero-test runtime packages and exited non-zero for `agent-types` and `eval-contracts`. The gate treats every non-denylisted package with zero tests as failing at `scripts/check-runtime-test-inventory.mjs:128` and prints the failure at `scripts/check-runtime-test-inventory.mjs:139`. `agent-types` is not in the denylist at `scripts/check-runtime-test-inventory.mjs:8`, and `eval-contracts` is not in the denylist either. The current source trees contain no `*.test.ts` or `*.spec.ts` files under `packages/agent-types/src` or `packages/eval-contracts/src`. The affected contracts include retry alias behavior at `packages/agent-types/src/retry.ts:21`, eval orchestrator methods at `packages/eval-contracts/src/orchestrator-contracts.ts:53`, eval execution context fields at `packages/eval-contracts/src/orchestrator-contracts.ts:21`, and persisted attempt/ownership fields at `packages/eval-contracts/src/store-contracts.ts:36` and `packages/eval-contracts/src/store-contracts.ts:42`.

Remediation: Either add small package-local contract tests or explicitly denylist these packages with a comment explaining that they are type-only and covered elsewhere. Preferred remediation is a small test suite that validates exported runtime-free shapes with compile-time fixtures and representative structural compatibility cases, especially for `RetryPolicy`, `EvalRunRecord`, `EvalOrchestratorLike`, and `EvalRunStore.updateRunIf`.

### Medium: Server persistence and route helpers still bypass type safety with explicit `any`

Impact: The repo has a strict no-explicit-any lint rule, but several server paths suppress it around persistence mapping and Hono route helpers. This is a maintainability risk because schema drift, nullable fields, and route context assumptions are pushed out of TypeScript and into runtime behavior. It is more than style-only noise in the persistence mappers because wrong row shapes can silently produce invalid API records.

Evidence: The root ESLint config sets `@typescript-eslint/no-explicit-any` to `error` at `eslint.config.js:56`. Current non-test source still contains local disables and explicit `any` in server code. `packages/server/src/deploy/deployment-history-store.ts:165` disables the rule and maps `row: any` at `packages/server/src/deploy/deployment-history-store.ts:166`, then casts every field manually through `packages/server/src/deploy/deployment-history-store.ts:178`. `packages/server/src/persistence/drizzle-run-trace-store.ts:104` and `packages/server/src/persistence/drizzle-run-trace-store.ts:134` disable the rule for `steps.map((s: any) => ...)`. `packages/server/src/routes/workflows.ts:350` and `packages/server/src/routes/compile.ts:560` suppress the rule for Hono context values typed as `any`. `packages/server/src/notifications/mail-dlq-worker.ts:181` suppresses the rule and reaches into a private store shape with `{ db: any }` at `packages/server/src/notifications/mail-dlq-worker.ts:182`.

Remediation: Replace Drizzle row `any` with inferred select types from the schema or `typeof table.$inferSelect` where available. Give route helpers a narrow local Hono-context interface containing only the used `json`, `req`, and `streamSSE` members. Expose a typed `remove(id)` or `deleteDlqRow(id)` method on the DLQ store instead of reaching through a private `db` property.

### Medium: Large runtime hotspots concentrate too many independent invariants in single files

Impact: These are not findings because the files are long. They are findings because each file owns several independent runtime invariants in one edit surface, increasing review cost and regression risk when localized changes touch shared mutable state.

Evidence: The current non-test line-count scan shows `packages/agent-adapters/src/recovery/adapter-recovery.ts` at 1,341 lines, `packages/agent-adapters/src/workflow/adapter-workflow.ts` at 1,133 lines, `packages/agent-adapters/src/codex/codex-adapter.ts` at 1,131 lines, `packages/agent/src/agent/tool-loop.ts` at 1,089 lines, `packages/agent/src/pipeline/pipeline-runtime.ts` at 1,078 lines, and `packages/server/src/app.ts` at 1,012 lines. In `PipelineRuntime`, the main loop handles cancellation, resume skipping, suspend/gate behavior, fork/join, execution, retry, telemetry, calibration, iteration budget, checkpointing, and edge selection in one class, with representative control flow beginning at `packages/agent/src/pipeline/pipeline-runtime.ts:263` and budget/checkpoint side effects around `packages/agent/src/pipeline/pipeline-runtime.ts:578` and `packages/agent/src/pipeline/pipeline-runtime.ts:970`. In `AdapterRecoveryCopilot`, non-stream and stream recovery loops both live in `packages/agent-adapters/src/recovery/adapter-recovery.ts`, starting at `packages/agent-adapters/src/recovery/adapter-recovery.ts:388` and `packages/agent-adapters/src/recovery/adapter-recovery.ts:846`, while strategy selection and application remain in the same file at `packages/agent-adapters/src/recovery/adapter-recovery.ts:1138` and `packages/agent-adapters/src/recovery/adapter-recovery.ts:1171`.

Remediation: Do not run a broad style refactor. Extract only when functional work touches these files, and extract along invariant boundaries: pipeline node execution policy, checkpoint persistence, runtime side-effect hooks, recovery attempt execution, and recovery strategy planning. Preserve current event-order behavior with focused tests before moving code.

### Low: Correlation propagation still mutates typed adapter events after mapping

Impact: This is a type-safety and maintainability smell, not a confirmed correctness bug. The shared event contract already includes optional `correlationId`, but adapters still mutate mapped event objects through double casts. That bypasses discriminated-event construction and can mutate mapper-returned objects if they are reused.

Evidence: The shared `AgentEvent` union includes `correlationId` on event interfaces, including `AgentStartedEvent` at `packages/adapter-types/src/contracts/events.ts:21`, `AgentMessageEvent` at `packages/adapter-types/src/contracts/events.ts:40`, `AgentToolCallEvent` at `packages/adapter-types/src/contracts/events.ts:50`, and terminal events at `packages/adapter-types/src/contracts/events.ts:71` and `packages/adapter-types/src/contracts/events.ts:83`. `BaseCliAdapter` still injects the field by mutating the mapped event through `as unknown as Record<string, unknown>` at `packages/agent-adapters/src/base/base-cli-adapter.ts:521`. `CodexAdapter` does the same for mapped provider events at `packages/agent-adapters/src/codex/codex-adapter.ts:756`.

Remediation: Replace mutation with a typed helper such as `withCorrelationId<T extends AgentEvent>(event: T, correlationId?: string): T` that returns the original event when absent and `{ ...event, correlationId }` when present. Use it in base CLI, Codex, and any other adapter that currently spreads or mutates correlation fields.

## Scope Reviewed

This is a current-code baseline review for the code quality domain only. I reviewed the live repository under `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent`, the April 26 prepared prompt pack at `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-26/run-001/codex-prep`, root quality configuration, package source, and representative tests.

Static and command evidence gathered:

- `all_ts_src=2396`, `test_ts_src=1071`, and `non_test_ts_src=1323` under `packages/*/src`.
- Large-file scan over non-test TypeScript source.
- Static scans for explicit `any`, lint suppressions, TODO/FIXME/stub markers, duplicated implementation names, subprocess exit-code handling, adapter event mutation, and package-local tests.
- `node scripts/check-runtime-test-inventory.mjs` was run and exited non-zero because `agent-types` and `eval-contracts` currently have zero package-local tests.

I did not run `yarn build`, `yarn typecheck`, `yarn lint`, `yarn test`, or `yarn verify` for this audit. No runtime behavior is claimed as validated beyond the explicitly captured inventory script result.

## Strengths

- The repo has real quality gates in root scripts. `package.json:29` defines a strict verification lane, and `package.json:30` defines the normal `verify` lane with runtime inventory, improvement drift, domain-boundary, terminal-tool-event, build, typecheck, lint, and test checks.
- The no-explicit-any policy is codified, not only stylistic guidance. `eslint.config.js:56` sets `@typescript-eslint/no-explicit-any` to `error`, and current production hits are concentrated enough to remediate deliberately.
- Runtime-critical packages generally have substantial tests. The captured inventory reported large package-local test counts for `agent`, `agent-adapters`, `core`, `evals`, `memory`, and `server`; the zero-test issue is concentrated in shared contract packages.
- The codebase already separates many helper modules out of the largest runtime areas. For example, pipeline helpers are tested through files such as `packages/agent/src/__tests__/pipeline-runtime-helpers.test.ts:3` and `packages/agent/src/__tests__/edge-resolution-branches.test.ts:10`, which provides a path for incremental extraction rather than a risky big-bang rewrite.
- Prior duplication and drift concerns are not being treated as automatic findings. Public exports, compatibility files, and type-only contracts were not classified as dead code solely because repo-local runtime references are sparse.

## Open Questions Or Assumptions

- I treated prior audit artifacts as comparison-only context and did not reuse their severity ranking as evidence.
- I assumed `DefaultEvalOrchestrator` remains product-reachable because `createEvalRoutes` instantiates it when `executeTarget` is supplied without `orchestrator` or `orchestratorFactory` at `packages/server/src/routes/evals.ts:400`.
- I did not classify package-local zero tests in `agent-types` and `eval-contracts` as high severity because these appear to be shared contract packages rather than runtime executors. The current gate still fails, so the repo needs either tests or an explicit policy waiver.
- I did not claim dead code from lack of direct imports. This monorepo has public package exports and compatibility subpaths where sparse internal references can be intentional.
- I did not elevate TODO/FIXME/comment markers as findings unless they were attached to a concrete maintainability or invariant risk.

## Recommended Next Actions

1. Resolve eval orchestration duplication first. Make the server route layer delegate to the package implementation or require an injected orchestrator, then add tests for the default route path.
2. Harden subprocess exit-code handling in `MCPClient.spawnWithStdin` and `spawn-compiler-bridge`, with focused tests for stdout-plus-nonzero and terminal-event-plus-nonzero cases.
3. Decide the policy for `agent-types` and `eval-contracts`: add small package-local contract tests or explicitly denylist them as type-only packages with documented external coverage.
4. Remove the remaining server-side `any` suppressions by using inferred Drizzle row types, narrow Hono helper interfaces, and a typed DLQ delete API.
5. Treat the large runtime hotspots as extraction candidates only during functional work. Start with one invariant at a time and preserve current event-order behavior with focused regression tests.
6. Replace adapter event mutation for correlation IDs with a typed helper. This is lower urgency than the runtime-state findings but is a small, contained way to reduce future type drift.
