# Code Quality Audit - Current Repository Baseline

## Findings

### DOMAIN-001 - High - Flow AST parser rejects node kinds that the public AST type and schema accept

**Impact:** Valid current `FlowNode` variants can fail before semantic validation when they enter the compiler through `parseFlow()`. This is more than style drift: the type layer, schema validator, tests, and compiler parse stage disagree about the contract, so adding or using newer node kinds can create false `UNKNOWN_NODE_TYPE` failures.

**Evidence:**
- `packages/flow-ast/src/types.ts:32` defines `FlowNode` as including `spawn`, `classify`, `emit`, `memory`, `checkpoint`, and `restore`.
- `packages/flow-ast/src/parse.ts:41` keeps a separate `KNOWN_NODE_TYPES` set with only the original ten node kinds, and `packages/flow-ast/src/parse.ts:137` rejects anything outside that set as `UNKNOWN_NODE_TYPE`.
- `packages/flow-ast/src/validate.ts:401` through `packages/flow-ast/src/validate.ts:412` validates the newer node kinds, so schema validation and parsing are not aligned.
- `packages/flow-compiler/src/index.ts:143` uses `parseFlow(input)` as compile stage 1, so this parser drift is on the compile path.
- `packages/flow-ast/test/checkpoint-nodes.test.ts:8` tests `checkpoint` through `flowNodeSchema.safeParse()`, but the parse tests listed under `packages/flow-ast/test/parse.test.ts` do not cover these newer node kinds.

**Remediation:** Replace the duplicated node-kind lists with one table-driven registry shared by `types`, `parse`, and `validate`, or generate parser/schema switch cases from one source. Add parse and compile tests for every `FlowNode['type']`, especially `checkpoint`, `restore`, `spawn`, `classify`, `emit`, and `memory`.

### DOMAIN-002 - Medium - Turbo test cache ignores top-level `test/` suites

**Impact:** Changes to tests under package-level `test/` directories can be missed by the Turbo test cache because the repo-level `test` task only declares `src/**`, `package.json`, `tsconfig.json`, and `vitest.config.*` as inputs. This can produce stale green `yarn test` or `yarn verify` results after editing flow package tests.

**Evidence:**
- `turbo.json:26` through `turbo.json:29` defines the generic `test` task inputs without `test/**`.
- `packages/flow-ast/vitest.config.ts:7` includes `test/**/*.test.ts`.
- `packages/flow-compiler/vitest.config.ts:7` includes `test/**/*.test.ts`.
- Current top-level test directories exist in `packages/flow-ast/test`, `packages/flow-compiler/test`, and `packages/flow-dsl/test`.

**Remediation:** Add `test/**` to the generic Turbo `test.inputs`, or add package-specific `@dzupagent/flow-*#test` task overrides that include those directories. Keep `vitest.config.*` in the input list so test discovery changes still invalidate cache.

### DOMAIN-003 - Medium - Adapter events bypass the core typed event bus contract

**Impact:** Adapter orchestration emits domain events through `DzupEventBus` using casts rather than a shared event contract. Consumers of `DzupEvent`, event-metric maps, and event bridge code can silently miss adapter events because TypeScript does not force the core event union to stay aligned with adapter event types.

**Evidence:**
- `packages/core/src/events/event-types.ts:33` defines the `DzupEvent` union used by `DzupEventBus.emit()` in `packages/core/src/events/event-bus.ts:23`.
- `packages/adapter-types/src/contracts/events.ts:115` defines `AgentProgressEvent` with `type: 'adapter:progress'`, but that event is not part of the core `DzupEvent` union.
- `packages/agent-adapters/src/orchestration/parallel-executor.ts:700` emits `adapter:progress` by casting through `unknown` to `Parameters<DzupEventBus['emit']>[0]`.
- `packages/agent-adapters/src/orchestration/supervisor.ts:514` repeats the same cast for supervisor progress.
- `packages/agent-adapters/src/orchestration/map-reduce.ts:459` states map-reduce events are domain-specific extensions and casts them into the event bus.

**Remediation:** Introduce an explicit adapter-event extension point in the event contract, such as a shared `DzupEvent | AdapterRuntimeEvent` union, a generic event bus, or a narrow bridge that maps adapter events into canonical `DzupEvent` names. Remove event-bus casts from orchestration code once the contract is authoritative.

### DOMAIN-004 - Medium - Persistence DB handles use repeated `any` escape hatches

**Impact:** Several persistence and composition modules hide Drizzle/database shape behind `any`. That keeps the code compiling, but it also hides method-chain contract drift, transaction compatibility issues, and table row mismatch until runtime. The repeated local aliases make the escape hatch hard to audit centrally.

**Evidence:**
- `packages/server/src/composition/types.ts:74` through `packages/server/src/composition/types.ts:77` defines `AnyDrizzle = any` for app composition.
- `packages/server/src/persistence/drizzle-run-trace-store.ts:17` through `packages/server/src/persistence/drizzle-run-trace-store.ts:25` defines and stores an `AnyDrizzle` DB handle in a runtime store.
- `packages/server/src/persistence/drizzle-reflection-store.ts:12` through `packages/server/src/persistence/drizzle-reflection-store.ts:28` repeats the same pattern.
- `packages/server/src/deploy/deployment-history-store.ts:69` through `packages/server/src/deploy/deployment-history-store.ts:77` repeats another local `AnyDrizzleDB = any` alias.

**Remediation:** Define one minimal structural DB interface per store capability or one shared internal Drizzle facade that covers the methods actually used (`select`, `insert`, `delete`, `update`, `transaction`, etc.). Keep external Drizzle generics out of public APIs, but make store internals type-check against a real contract.

### DOMAIN-005 - Medium - Coverage and zero-test guardrails are still package-level and waiver-heavy

**Impact:** The repo has a useful zero-test package gate, but file-level zero-test risk is only tracked for a small critical-source list. Many packages remain under temporary coverage waivers, so maintainability risk in unbaselined files can grow without failing the workspace coverage gate.

**Evidence:**
- `coverage-thresholds.json:8` through `coverage-thresholds.json:15` tracks only six packages in `trackedPackages`.
- `coverage-thresholds.json:16` through `coverage-thresholds.json:97` lists only ten `criticalSourceFiles` with declared coverage.
- Waivers remain for many packages, including `codegen` at `coverage-thresholds.json:167`, `context` at `coverage-thresholds.json:193`, and the flow packages at `coverage-thresholds.json:225` through `coverage-thresholds.json:240`.
- `coverage-thresholds.json:285` through `coverage-thresholds.json:291` keeps `server` at the default 70/60/60/70 thresholds even though it is a large compatibility/runtime surface.
- Current static inventory command `node scripts/check-runtime-test-inventory.mjs` reported zero-test runtime package gate passed, but that does not imply every important source file has direct or declared coverage.

**Remediation:** Convert waivers into dated package coverage baselines, then raise package thresholds in staged increments. Expand `criticalSourceFiles` to include large or contract-heavy files before relying on package-level percentages alone. Add a lightweight file-level inventory report for large files without direct or declared tests.

### DOMAIN-006 - Medium - Several modules combine too many responsibilities in one file

**Impact:** Large multi-responsibility modules make changes hard to review and increase the chance that unrelated concerns are coupled by shared local state. This is a maintainability risk, not a formatting complaint: the biggest files mix contract types, runtime policy, orchestration, I/O, event emission, and cleanup behavior.

**Evidence:**
- `packages/flow-ast/src/validate.ts:102` starts runtime schema validation and the same file continues through canonical ID validation around `packages/flow-ast/src/validate.ts:1397`, making it a 1500-line validator with multiple walkers.
- `packages/server/src/runtime/tool-resolver.ts:9` defines tool profile contracts, then later resolves HTTP connector profiles and MCP/custom tools around `packages/server/src/runtime/tool-resolver.ts:884` through `packages/server/src/runtime/tool-resolver.ts:982`.
- `packages/agent-adapters/src/recovery/adapter-recovery.ts:1` defines recovery strategy contracts and trace capture, and the same file still contains event emission and provider fallback behavior near `packages/agent-adapters/src/recovery/adapter-recovery.ts:1236`.
- `packages/agent-adapters/src/workflow/adapter-workflow.ts:1` owns the adapter workflow DSL, runtime execution, state merge, and adapter event consumption, with execution helpers still present near `packages/agent-adapters/src/workflow/adapter-workflow.ts:1138`.

**Remediation:** Split only along existing responsibility boundaries: parser/schema tables from flow validation, profile selection from tool instantiation in `tool-resolver`, trace store/recovery strategy/event emission in adapter recovery, and DSL builder/runtime executor in adapter workflow. Add focused tests around extracted seams before moving behavior.

### DOMAIN-007 - Low - Optional-property strictness is inconsistent across public runtime packages

**Impact:** Several packages compile with `strict` and `noUncheckedIndexedAccess`, but keep `exactOptionalPropertyTypes` disabled. This allows `{ field: undefined }` to satisfy optional contracts in those packages while stricter packages treat absence and explicit `undefined` differently. The result is subtle API boundary drift, especially around emitted event payloads, route config, and generated declaration files.

**Evidence:**
- `packages/agent/tsconfig.json:18` sets `exactOptionalPropertyTypes` to `false`.
- `packages/agent-adapters/tsconfig.json:18` sets `exactOptionalPropertyTypes` to `false`.
- `packages/server/tsconfig.json:18` sets `exactOptionalPropertyTypes` to `false`.
- `packages/codegen/tsconfig.json:19` sets `exactOptionalPropertyTypes` to `false`.
- Other packages in the workspace already use the stricter setting, so the repo does not have one consistent optional-property contract.

**Remediation:** Move package by package toward `exactOptionalPropertyTypes: true`, starting with public contract packages and runtime event/config surfaces. Where explicit `undefined` is intentional, encode it as `field?: T | undefined` and keep that choice visible in the type.

### DOMAIN-008 - Low - Internal Vue playground components are orphaned and outside the quality gates

**Impact:** The agent package contains Vue SFCs that import Vue, but the package explicitly blocks the `./playground/ui` export path and does not publish Vue as a dependency or peer. The SFCs are also ignored by ESLint. That makes them likely historical or internal-dead code unless a consuming build step exists elsewhere.

**Evidence:**
- `packages/agent/package.json:28` and `packages/agent/package.json:29` set `./playground/ui` and `./playground/ui/*` exports to `null`.
- `packages/agent/src/playground/ui/TraceNodeDetail.vue:9` imports from `vue`.
- `packages/agent/package.json:47` through `packages/agent/package.json:50` lists peer dependencies, and Vue is not present.
- `eslint.config.js:16` ignores `**/*.vue`, so these components are not linted by the repo lint gate.
- `packages/agent/src/playground/ui/index.ts:1` through `packages/agent/src/playground/ui/index.ts:14` says the UI module is framework-internal and deprecated for SFC imports.

**Remediation:** Either delete/move the SFCs to a real consuming UI package with Vue build, lint, and tests, or keep only the rendering-independent utilities under `src/playground/ui`. If the SFCs must stay, add Vue lint/type tooling and a package-local test/build path that exercises them.

### DOMAIN-009 - Low - Stale package references remain in root config and onboarding docs

**Impact:** Tooling and onboarding still point at removed or renamed package paths. This does not break the current Turbo scripts directly, but it misleads project-reference users, automation, and new contributors trying to run a package that no longer exists as a workspace.

**Evidence:**
- `README.md:27` through `README.md:31` tells users to run `yarn workspace @dzupagent/playground dev`.
- `packages/playground/docs/ARCHITECTURE.md:6` through `packages/playground/docs/ARCHITECTURE.md:8` states that `packages/playground` has no `src`, `package.json`, or README in this checkout.
- `tsconfig.json:30` still references `packages/playground`.
- `packages/codegen/tsconfig.json:24` through `packages/codegen/tsconfig.json:27` maps `@dzupagent/core` to `../dzupagent-core/dist`, but no `packages/dzupagent-core` directory exists in this checkout.
- A focused `yarn workspace @dzupagent/codegen typecheck` was run during this audit and passed, so the codegen alias is confirmed as stale configuration rather than a currently failing typecheck path.

**Remediation:** Remove the dead playground project reference or replace it with the active server/agent playground surfaces. Update README onboarding to use existing workspaces. Remove the stale `dzupagent-core` path mapping or replace it with the current workspace package path if a local alias is still needed.

### DOMAIN-010 - Low - Connector tool normalization duplicates unsafe casts across packages

**Impact:** Connector packages repeat the same structural normalization pattern and cast the result back to a domain-specific tool type. Any fix to context propagation, output formatting, schema typing, or LangChain compatibility must be patched in several places, and TypeScript cannot verify the final cast.

**Evidence:**
- `packages/connectors/src/connector-contract.ts:31` through `packages/connectors/src/connector-contract.ts:50` normalizes and casts to `ConnectorTool<Input, Output>`.
- `packages/connectors-browser/src/connector-contract.ts:8` through `packages/connectors-browser/src/connector-contract.ts:21` repeats the same pattern for `BrowserConnectorTool`.
- `packages/connectors-documents/src/connector-contract.ts:8` through `packages/connectors-documents/src/connector-contract.ts:21` repeats it again for `DocumentConnectorTool`.
- `packages/core/src/tools/create-tool.ts:87` through `packages/core/src/tools/create-tool.ts:90` already contains the lower-level LangChain compatibility cast, so the connector packages stack additional casts on top.

**Remediation:** Keep one canonical `normalizeBaseConnectorTool` wrapper in core and expose typed domain aliases as pure type aliases or thin wrappers without restating the invoke/context bridge. Add connector contract tests that assert context signal propagation once at the shared layer.

### DOMAIN-011 - Info - Public barrel files remain broad enough to hide ownership boundaries

**Impact:** Broad root barrels make API review and deprecation management harder because unrelated domains are exported from one entrypoint. This is not a runtime defect, and the repo does have stable/advanced tier docs, but the root surface still carries a high maintenance cost.

**Evidence:**
- `packages/core/src/index.ts:1` through `packages/core/src/index.ts:20` starts a broad root export surface, and the file continues to version export at `packages/core/src/index.ts:820`.
- `packages/codegen/src/index.ts:1` through `packages/codegen/src/index.ts:80` exports many domains from one root file, and the file continues through `packages/codegen/src/index.ts:441`.
- `README.md:79` through `README.md:85` recommends `@dzupagent/core/stable` for new code, which confirms the intended direction is narrower than the legacy root surface.

**Remediation:** Keep root barrels for compatibility, but make API surface checks fail when new exports are added to roots without an explicit allowlist update. Prefer subpath exports for new public APIs and continue documenting stable versus advanced tiers.

### DOMAIN-012 - Info - Full build/test validation was not run for this audit

**Impact:** This audit is a current-code static review with selective command evidence. It should not be read as proof that the whole repo builds or tests green at this timestamp.

**Evidence:**
- The audit did run `node scripts/check-runtime-test-inventory.mjs`; it reported the zero-test runtime package gate passed and listed package test counts.
- The audit did run `node scripts/check-workspace-coverage.mjs --report-only`; it reported 31 checked packages, 10 passed, 21 waived, 0 missing, 0 expired, and 0 failed.
- The audit did run `yarn workspace @dzupagent/codegen typecheck`; it passed.
- The audit did not run `yarn build`, `yarn typecheck`, `yarn lint`, `yarn test`, or `yarn verify`.

**Remediation:** Before converting findings into implementation tasks, run package-focused verification for touched packages. Before closing a cross-package remediation tranche, run the repo gate from `AGENTS.md`: `yarn build && yarn typecheck && yarn lint && yarn test`, or `yarn verify` if the intent is the one-command Turbo lane.

## Scope Reviewed

- Read first: `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-29/run-001/codex-prep/context/repo-snapshot.md`.
- Reviewed current repository source/config under `packages/**`, `scripts/**`, root config, and selected docs that describe current package reality.
- Avoided generated/dependency/old-audit artifacts such as `dist`, `node_modules`, `coverage`, `.turbo`, `audit`, and prior audit outputs as evidence sources.
- Static commands used for triage included `rg`, `find`, `wc`, `node scripts/check-runtime-test-inventory.mjs`, `node scripts/check-workspace-coverage.mjs --report-only`, and one focused `yarn workspace @dzupagent/codegen typecheck`.
- No full repo build, lint, test, or verify run was performed.

## Strengths

- The repo has a real workspace quality ladder in `package.json`, including `verify`, runtime test inventory, package tier checks, domain boundary checks, and terminal tool event guard checks.
- The runtime test inventory currently detects zero-test runtime packages and correctly accounts for top-level flow package `test/` directories.
- High-risk runtime files have a declared critical-source coverage inventory, including run engine, approval gate, pipeline runtime, adapter base/Codex adapter, MCP client, policy evaluator, browser/document connectors, and scraper.
- Core TypeScript settings are generally strict: packages use `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, and `noUnusedParameters` in most runtime `tsconfig.json` files.
- The repository already distinguishes compatibility surfaces from forward product boundaries in `AGENTS.md`, and current package docs identify decommissioned or compatibility-only areas such as `packages/playground`.

## Open Questions Or Assumptions

- I treated `packages/server` and `packages/playground` as maintenance/compatibility surfaces per `AGENTS.md`, not as places to expand product behavior.
- I treated top-level `test/` directories as intentional because the flow package Vitest configs include them and the runtime inventory script explicitly supports sibling test directories.
- I did not classify every source file without a same-name test as a finding. In this repo, many files are legitimately covered through integration, contract, or package-level tests; the actionable gap is the narrow file-level inventory, not the absence of one-test-per-file.
- I did not use previous audit artifacts as baseline truth. Prior memory only informed caution around severity drift; findings above are grounded in current source/config evidence.

## Recommended Next Actions

1. Fix `DOMAIN-001` first: align the flow AST parser with the `FlowNode` union and schema, then add parser/compiler coverage for every node kind.
2. Patch `turbo.json` test inputs to include `test/**`, then run a focused flow package test lane to confirm cache behavior is no longer stale.
3. Define an authoritative adapter event contract so `agent-adapters` can emit progress/map-reduce/supervisor events without `unknown` casts into `DzupEventBus`.
4. Replace repeated Drizzle `any` aliases with minimal structural DB facades in the server persistence layer.
5. Convert the largest coverage waivers into package baselines and expand `criticalSourceFiles` for large or contract-heavy modules.
6. Clean stale playground/codegen config references and decide whether the Vue playground SFCs are deleted, moved, or wired into a real quality-gated build.

## Finding Manifest

```json
{
  "domain": "code quality",
  "counts": { "critical": 0, "high": 1, "medium": 5, "low": 4, "info": 2 },
  "findings": [
    { "id": "DOMAIN-001", "severity": "high", "title": "Flow AST parser rejects node kinds that the public AST type and schema accept", "file": "packages/flow-ast/src/parse.ts" },
    { "id": "DOMAIN-002", "severity": "medium", "title": "Turbo test cache ignores top-level test suites", "file": "turbo.json" },
    { "id": "DOMAIN-003", "severity": "medium", "title": "Adapter events bypass the core typed event bus contract", "file": "packages/agent-adapters/src/orchestration/parallel-executor.ts" },
    { "id": "DOMAIN-004", "severity": "medium", "title": "Persistence DB handles use repeated any escape hatches", "file": "packages/server/src/composition/types.ts" },
    { "id": "DOMAIN-005", "severity": "medium", "title": "Coverage and zero-test guardrails are still package-level and waiver-heavy", "file": "coverage-thresholds.json" },
    { "id": "DOMAIN-006", "severity": "medium", "title": "Several modules combine too many responsibilities in one file", "file": "packages/flow-ast/src/validate.ts" },
    { "id": "DOMAIN-007", "severity": "low", "title": "Optional-property strictness is inconsistent across public runtime packages", "file": "packages/agent/tsconfig.json" },
    { "id": "DOMAIN-008", "severity": "low", "title": "Internal Vue playground components are orphaned and outside the quality gates", "file": "packages/agent/src/playground/ui/TraceNodeDetail.vue" },
    { "id": "DOMAIN-009", "severity": "low", "title": "Stale package references remain in root config and onboarding docs", "file": "README.md" },
    { "id": "DOMAIN-010", "severity": "low", "title": "Connector tool normalization duplicates unsafe casts across packages", "file": "packages/connectors/src/connector-contract.ts" },
    { "id": "DOMAIN-011", "severity": "info", "title": "Public barrel files remain broad enough to hide ownership boundaries", "file": "packages/core/src/index.ts" },
    { "id": "DOMAIN-012", "severity": "info", "title": "Full build/test validation was not run for this audit", "file": "package.json" }
  ]
}
```
