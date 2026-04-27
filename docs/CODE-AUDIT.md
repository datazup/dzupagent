## Findings

### CODE-001 - High - Server is accumulating product capability surfaces despite the package boundary

Impact: `packages/server` is supposed to remain compatibility, tests, examples, and maintenance-oriented, but it still owns many product-shaped control-plane surfaces. That raises review cost, spreads app concerns across framework server code, and makes future Codev/product behavior harder to isolate from reusable framework primitives.

Evidence: The repository guideline says not to add new product features to `packages/server` or `packages/playground`, and explicitly names workspaces, projects, tasks, personas, prompt templates, workflow DSLs, memory policies, multi-tenant filtering, adapter orchestration, and Codev operator UX as app-owned concerns (`AGENTS.md:8`, `AGENTS.md:11`, `AGENTS.md:15`). Current server composition still mounts prompts, personas, presets, marketplace, learning, deploy, evals, triggers, schedules, mailbox, clusters, A2A, OpenAI compatibility, and memory routes from one optional-route layer (`packages/server/src/composition/optional-routes.ts:66`, `packages/server/src/composition/optional-routes.ts:177`, `packages/server/src/composition/optional-routes.ts:189`, `packages/server/src/composition/optional-routes.ts:219`, `packages/server/src/composition/optional-routes.ts:259`). `createForgeApp` advertises this as one aggregate server entrypoint and starts closed-loop subscribers and schedulers in the same composition path (`packages/server/src/app.ts:69`, `packages/server/src/app.ts:93`, `packages/server/src/app.ts:107`, `packages/server/src/app.ts:110`).

Remediation: Freeze `packages/server` to framework compatibility and maintenance work. For each product-shaped surface, document whether it is a stable framework primitive, a compatibility shim, or a migration candidate to the consuming app. New feature requests for personas, prompts, task orchestration, memory policy, and operator UX should land in the product app or in smaller reusable packages, with server routes acting only as thin adapters.

### CODE-002 - High - Run worker lifecycle logic is concentrated in one large closure with many terminal-state invariants

Impact: The run worker owns security scanning, approval, trace lifecycle, context transfer, executor dispatch, quota accounting, reflection, escalation, outcome analysis, context persistence, metrics, cancellation, and error handling in one callback. This is a maintainability risk because small changes in one concern can affect terminal-state transitions, logs, trace completion, or post-run side effects.

Evidence: `startRunWorker` registers one queue callback at `packages/server/src/runtime/run-worker.ts:242`. Inside that callback it resolves trace context (`packages/server/src/runtime/run-worker.ts:250`), applies input guard rejection/redaction (`packages/server/src/runtime/run-worker.ts:294`), starts traces (`packages/server/src/runtime/run-worker.ts:347`), handles approval waits (`packages/server/src/runtime/run-worker.ts:366`), loads cross-intent context (`packages/server/src/runtime/run-worker.ts:422`), executes the run (`packages/server/src/runtime/run-worker.ts:451`), writes terminal completion or halt state (`packages/server/src/runtime/run-worker.ts:512`), records quota usage (`packages/server/src/runtime/run-worker.ts:527`), appends trace output (`packages/server/src/runtime/run-worker.ts:548`), computes reflection and escalation (`packages/server/src/runtime/run-worker.ts:578`, `packages/server/src/runtime/run-worker.ts:665`), invokes outcome analysis (`packages/server/src/runtime/run-worker.ts:725`), saves context (`packages/server/src/runtime/run-worker.ts:771`), and finally handles cancellation/failure (`packages/server/src/runtime/run-worker.ts:833`). The same file is 909 lines according to the current line-count scan, making it one of the server hotspots.

Remediation: Do not do a broad style rewrite. Extract only around stable invariants: input admission, approval gate, trace writer, post-completion enrichment, and failure finalization. Add focused tests before each extraction that assert terminal-state behavior for completed, halted, rejected, cancelled, and failed runs.

### CODE-003 - Medium - Drizzle run trace step indexing is race-prone

Impact: Concurrent `addStep` calls for the same run can read the same `totalSteps` value, insert duplicate `stepIndex` values, and then both write the same incremented total. That corrupts replay ordering and can make paginated trace consumers miss or duplicate steps.

Evidence: `DrizzleRunTraceStore.addStep` reads the current trace header row and derives `stepIndex` from `trace.totalSteps` (`packages/server/src/persistence/drizzle-run-trace-store.ts:52`, `packages/server/src/persistence/drizzle-run-trace-store.ts:61`). It then inserts the step and separately updates `runTraces.totalSteps` (`packages/server/src/persistence/drizzle-run-trace-store.ts:62`, `packages/server/src/persistence/drizzle-run-trace-store.ts:72`). There is no transaction, row lock, atomic increment, uniqueness constraint enforcement in this method, or retry on conflict. Existing tests cover sequential indexing for in-memory and Drizzle stores, including `packages/server/src/persistence/__tests__/drizzle-run-trace-store.test.ts:311` and `packages/server/src/__tests__/run-trace-lifecycle.test.ts:352`, but the inspected test search did not show concurrent same-run `addStep` coverage.

Remediation: Make trace-step append atomic. Options include a transaction with row-level locking, a database-side increment/returning pattern, or storing steps with a generated sequence and deriving order by insertion metadata. Add a concurrent same-run test that runs `Promise.all` over multiple `addStep` calls and asserts unique contiguous indices.

### CODE-004 - Medium - Compile route has duplicated artifact-persistence logic and hard-coded provider identity

Impact: Compile artifacts are persisted through multiple branches with duplicated payload construction. The hard-coded `providerId: 'claude'` makes compile output look provider-specific even when the compiler route is framework-owned and not necessarily backed by Claude. Future changes to compile artifact metadata can drift between JSON and SSE branches.

Evidence: The in-process SSE branch appends compile artifacts at `packages/server/src/routes/compile.ts:427` and hard-codes `providerId: 'claude'` at `packages/server/src/routes/compile.ts:436`. The JSON branch repeats a similar `appendArtifact` block at `packages/server/src/routes/compile.ts:497` and hard-codes the same provider at `packages/server/src/routes/compile.ts:500`. The tests assert run id, path, action, artifact type, and metadata target in `packages/server/src/routes/__tests__/compile-persistence.test.ts:169` and `packages/server/src/routes/__tests__/compile-persistence.test.ts:290`, but the inspected assertions do not pin or justify provider identity.

Remediation: Extract a single `persistCompileArtifact` helper that accepts `runId`, `CompileSuccess`, and the run event store. Use a neutral provider/source id such as `dzupagent-compiler` unless a real provider id is supplied by config. Cover both JSON and SSE branches through the helper tests so metadata drift is caught once.

### CODE-005 - Medium - Drizzle-backed stores repeatedly erase database type information with `AnyDrizzle`

Impact: Multiple persistence stores accept `any` database clients and then cast rows manually. That weakens the strict TypeScript boundary around schema evolution: renamed columns, nullable changes, and row-shape mismatches will not be caught at compile time in the mapper layer where they matter most.

Evidence: The server composition type exports `AnyDrizzle = any` with a lint suppression (`packages/server/src/composition/types.ts:72`, `packages/server/src/composition/types.ts:75`). The same pattern is repeated in `DrizzleRunTraceStore` (`packages/server/src/persistence/drizzle-run-trace-store.ts:17`, `packages/server/src/persistence/drizzle-run-trace-store.ts:24`), `DrizzleTriggerStore` (`packages/server/src/triggers/trigger-store.ts:87`, `packages/server/src/triggers/trigger-store.ts:106`), and `DrizzleScheduleStore` (`packages/server/src/schedules/schedule-store.ts:86`, `packages/server/src/schedules/schedule-store.ts:103`). The current scan also found the pattern in Drizzle A2A, mailbox, DLQ, cluster, reflection, and deployment history stores.

Remediation: Introduce a narrow typed DB interface per store or a shared generic store DB alias that preserves the table operations used by Drizzle. Where table schema objects exist, use `typeof table.$inferSelect` for row mappers, as `DrizzleRunTraceStore` partially does for selected row types. Keep one explicit escape hatch only at the composition boundary if full Drizzle client typing would overcouple the public server config.

### CODE-006 - Medium - Plugin registration has no lifecycle cleanup and discovery contains a dead source branch

Impact: Plugin event handlers are registered permanently, so a plugin cannot be unloaded, reloaded, or disposed without leaving subscriptions behind. The discovery model also advertises an `npm` source that current discovery never produces, which is a small dead-contract smell for consumers expecting npm discovery behavior.

Evidence: `PluginRegistry.register` subscribes each plugin event handler through `this.eventBus.on(...)` but discards the returned unsubscribe function (`packages/core/src/plugin/plugin-registry.ts:43`, `packages/core/src/plugin/plugin-registry.ts:47`). The registry stores plugins by name but exposes only `has`, `listPlugins`, `getMiddleware`, `getHooks`, and `get`; there is no unregister/dispose path in the class (`packages/core/src/plugin/plugin-registry.ts:55`, `packages/core/src/plugin/plugin-registry.ts:59`, `packages/core/src/plugin/plugin-registry.ts:87`). `DiscoveredPlugin.source` includes `'npm'` (`packages/core/src/plugin/plugin-discovery.ts:21`, `packages/core/src/plugin/plugin-discovery.ts:24`), while `discoverPlugins` only pushes `builtin` and `local` sources (`packages/core/src/plugin/plugin-discovery.ts:98`, `packages/core/src/plugin/plugin-discovery.ts:121`). `resolvePluginOrder` indexes by name in a `Map`, so duplicate discovered names collapse to the last entry before sorting (`packages/core/src/plugin/plugin-discovery.ts:142`, `packages/core/src/plugin/plugin-discovery.ts:143`).

Remediation: Track unsubscribe handles per plugin and add an explicit `unregister` or `dispose` method. Decide whether npm discovery is in scope; if not, remove `'npm'` from the current source union until implemented. Detect duplicate discovered plugin names before `resolvePluginOrder` overwrites them.

## Finding Manifest

```json
{
  "domain": "code quality",
  "counts": { "critical": 0, "high": 2, "medium": 4, "low": 0, "info": 0 },
  "findings": [
    { "id": "CODE-001", "severity": "high", "title": "Server is accumulating product capability surfaces despite the package boundary", "file": "packages/server/src/composition/optional-routes.ts" },
    { "id": "CODE-002", "severity": "high", "title": "Run worker lifecycle logic is concentrated in one large closure with many terminal-state invariants", "file": "packages/server/src/runtime/run-worker.ts" },
    { "id": "CODE-003", "severity": "medium", "title": "Drizzle run trace step indexing is race-prone", "file": "packages/server/src/persistence/drizzle-run-trace-store.ts" },
    { "id": "CODE-004", "severity": "medium", "title": "Compile route has duplicated artifact-persistence logic and hard-coded provider identity", "file": "packages/server/src/routes/compile.ts" },
    { "id": "CODE-005", "severity": "medium", "title": "Drizzle-backed stores repeatedly erase database type information with AnyDrizzle", "file": "packages/server/src/composition/types.ts" },
    { "id": "CODE-006", "severity": "medium", "title": "Plugin registration has no lifecycle cleanup and discovery contains a dead source branch", "file": "packages/core/src/plugin/plugin-registry.ts" }
  ]
}
```

## Scope Reviewed

This is a current-code baseline review for the code quality domain, using the prepared snapshot at `../audit/full-dzupagent-2026-04-27/run-001/codex-prep/context/repo-snapshot.md` as the starting point. I then selectively inspected live source under `packages/server`, `packages/core`, `packages/agent-adapters`, and `packages/flow-ast` to verify concrete findings.

The review focused on maintainability risks called out by the domain brief: type-unsafety, duplication, complexity hotspots, zero-test files/packages, dead code, and fragile invariants. I avoided generated output, dependencies, `audit/`, `out/`, `dist/`, and old audit artifacts. I did not run `yarn build`, `yarn typecheck`, `yarn lint`, `yarn test`, or runtime validation commands for this document.

## Strengths

- The repo has explicit guardrails for package-scoped validation and cross-package gates in `AGENTS.md:36`, including package filters, full `yarn verify`, connector-specific checks, and docs regeneration guidance.
- The prepared snapshot shows a broad workspace quality surface: `yarn verify`, `verify:strict`, domain-boundary checks, runtime test inventory, package tier checks, server API surface checks, coverage gates, and terminal tool event guards are all wired as root scripts.
- Server coverage is not shallow. The live tree includes focused tests for route families, WebSocket support, OpenAI compatibility, persistence stores, run lifecycle, compile routes, and service-level behavior under `packages/server/src/__tests__`, `packages/server/src/routes/__tests__`, `packages/server/src/persistence/__tests__`, and adjacent module test folders.
- Several previously risky subprocess paths are already hardened. `packages/server/src/routes/spawn-compiler-bridge.ts:115` captures child exit code and explicitly buffers `result` frames until a clean exit is observed, which is the right invariant for protocol-driven subprocesses.
- `packages/flow-ast` is not a true zero-test package even though its tests live under `packages/flow-ast/test` rather than `src/__tests__`; the current package contains parser/validator tests and checkpoint-node tests.

## Open Questions Or Assumptions

- I treated the product feature boundary as authoritative because it is in the repo-local `AGENTS.md` and was included in the task context.
- I did not classify sparse direct imports as dead code by itself because this monorepo has public package exports, compatibility subpaths, and route/plugin extension surfaces.
- I did not count `packages/flow-ast` as zero-test despite the snapshot-style `src` inventory because live tests exist under `packages/flow-ast/test`.
- I did not run the repo's validation suite, so any test status described here is based on source/test inspection only, not a fresh pass/fail result.

## Recommended Next Actions

1. Start with `CODE-003`: make Drizzle trace step appends atomic and add a concurrent same-run test. This is narrow, high-confidence, and protects replay correctness.
2. Extract compile artifact persistence for `CODE-004`, replacing the hard-coded provider id with a neutral compiler source id and covering JSON/SSE branches through one helper.
3. Define a `packages/server` product-boundary ledger for `CODE-001`: classify each optional route as stable framework primitive, compatibility shim, or product migration candidate.
4. When touching run execution next, extract one bounded concern from `run-worker.ts` with terminal-state tests before and after the change.
5. Replace repeated `AnyDrizzle` aliases incrementally in stores being edited for other work; avoid a cross-repo typing churn pass.
6. Add plugin unregister/dispose handling before any hot-reload or long-lived plugin-host work.
