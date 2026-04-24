# Architecture Audit

Date: 2026-04-24

## Findings

### High: Server public API surface guard is currently broken by an unclassified contract re-export

Impact: The repository has a dedicated `@dzupagent/server` public-surface inventory and check, but it no longer completes. That means new root exports can bypass the intended tier classification and stale-doc detection path until the classifier is repaired. This is an architecture governance issue, not just a documentation drift issue, because the guard is supposed to protect the server root API from uncontrolled growth.

Evidence:
- `packages/server/src/index.ts:133` re-exports type contracts directly from `@dzupagent/eval-contracts`.
- `packages/server/package.json:30` declares `@dzupagent/eval-contracts` as a server dependency.
- `scripts/server-api-surface-report.mjs:59` requires every export source to match exactly one tier rule, and `scripts/server-api-surface-report.mjs:66` throws when no rule matches.
- Running `node scripts/server-api-surface-report.mjs --check` failed with: `Expected exactly one tier rule for @dzupagent/eval-contracts, got (none)`.
- `config/server-api-tiers.json` contains many `./...` server-source rules but no rule for the external `@dzupagent/eval-contracts` re-export.

Remediation:
- Add an explicit classifier rule for `@dzupagent/eval-contracts`, or update `scripts/server-api-surface-report.mjs` to classify external package re-exports through a separate `external-contract` tier.
- Regenerate `docs/SERVER_API_SURFACE_INDEX.md` after the classifier can complete.
- Add a focused test or script fixture that includes an external type-only re-export so this failure mode is caught before landing future contract bridges.

### High: `@dzupagent/server` root still exposes internal, experimental, persistence, CLI, runtime, and feature-plane APIs through one default import surface

Impact: Consumers importing from `@dzupagent/server` get a broad and unstable-looking surface where internal implementation details, optional feature planes, concrete stores, CLI helpers, runtime workers, OpenAI compatibility helpers, and core server bootstrapping types all share the same public entrypoint. This increases accidental coupling, makes SemVer harder to reason about, and raises circularity risk because downstream packages can depend on implementation details that should live behind explicit subpaths.

Evidence:
- `docs/SERVER_API_SURFACE_INDEX.md:9` records `126` unique export sources in the root index, with `49` experimental and `18` internal sources at `docs/SERVER_API_SURFACE_INDEX.md:10`.
- `docs/SERVER_API_SURFACE_INDEX.md:11` recommends only `29` root exports, with `79` candidate subpath exports and `18` remove-root exports.
- `packages/server/src/index.ts:59` exports Drizzle table/schema symbols directly from `./persistence/drizzle-schema.js`.
- `packages/server/src/index.ts:302` and `packages/server/src/index.ts:303` export concrete Drizzle stores from the root.
- `packages/server/src/index.ts:361` through `packages/server/src/index.ts:378` keep CLI/doctor/scorecard command APIs on the root surface even though `packages/server/src/ops.ts:1` introduces a dedicated `@dzupagent/server/ops` facade.
- `packages/server/src/index.ts:395` through `packages/server/src/index.ts:420` exports runtime worker and quota APIs from the root.
- `packages/server/package.json:10` exposes only `"."` and `"./ops"` as package subpaths, so runtime/control-plane/persistence/compat planes still lack explicit public homes.

Remediation:
- Treat the existing `@dzupagent/server/ops` facade as the migration pattern, then add explicit subpaths for runtime/control-plane, persistence, compat, and optional extensions.
- Move root aliases behind deprecation notes and a compatibility window, starting with internal and experimental sources already marked `remove-root` or `candidate-subpath`.
- Keep `createForgeApp`, `ForgeServerConfig`, core route plugin types, core middleware, core queues, and platform handlers as the narrow root surface unless a consumer inventory proves otherwise.
- Make `node scripts/server-api-surface-report.mjs --check` a required gate once the classifier failure above is fixed.

### Medium: Package boundary enforcement is useful but still negative-only and covers only selected package pairs

Impact: Current boundary tests can prevent known forbidden edges, but they do not define a complete dependency direction model for all 32 workspaces, do not assert that every package is covered by policy, and do not detect source-level cycles except when a cycle happens to include a configured forbidden edge. This leaves layering drift possible between packages such as `app-tools`, `code-edit-kit`, flow packages, `eval-contracts`, `cache`, and `hitl-kit`.

Evidence:
- The monorepo contains 32 package workspaces, but `config/architecture-boundaries.json:2` defines package boundary rules for only six importers: `core`, `agent`, `codegen`, `connectors`, `agent-adapters`, and `server`.
- The same config is expressed as forbidden targets only at `config/architecture-boundaries.json:4` through `config/architecture-boundaries.json:25`; it does not define allowed dependency directions, package tiers, owner metadata, or cycle rules.
- `packages/testing/src/__tests__/boundary/architecture.test.ts:324` iterates only over configured rules and forbidden targets, so packages omitted from config receive no package-level source import enforcement.
- `packages/testing/src/__tests__/boundary/architecture.test.ts:379` asserts zero forbidden edges, not zero cycles or zero unclassified edges.
- `config/package-tiers.json:257` through `config/package-tiers.json:286` classifies tier-3 parked packages, but that package-tier policy is not wired into the boundary test.

Remediation:
- Extend `config/architecture-boundaries.json` from a forbidden-edge list into an allowed-layer graph that covers every package workspace.
- Add a policy-completeness assertion: every `packages/*/package.json` package must be present in either the layer graph or an explicit ignored list.
- Add a package dependency cycle check over `package.json` dependencies and source imports. This can be a small local script rather than a new runtime dependency.
- Reuse `config/package-tiers.json` so parked or secondary packages cannot accidentally become upstream dependencies of tier-1 packages without explicit policy.

### Medium: `packages/server/src/app.ts` is an oversized composition root that mixes bootstrapping, feature toggles, route registration, worker startup, stores, and operational side effects

Impact: `createForgeApp` is the correct place for final composition, but the current module has become the default integration point for too many optional planes. Changes to memory, evals, mail delivery, OpenAI compatibility, MCP, workflows, A2A, prompts, personas, registry, clusters, approvals, security, and run workers converge in one file. That concentrates merge conflicts and makes it hard to reason about which feature introduced a dependency or startup side effect.

Evidence:
- `packages/server/src/app.ts:21` through `packages/server/src/app.ts:128` imports a broad cross-section of core, agent, adapter, hitl, memory, eval-contract, route, runtime, persistence, notification, and control-plane modules.
- `packages/server/src/app.ts:175` through `packages/server/src/app.ts:360` defines a single `ForgeServerConfig` interface with many unrelated optional feature groups.
- `packages/server/src/app.ts:558` starts `createForgeApp`, and by `packages/server/src/app.ts:588` through `packages/server/src/app.ts:607` it is already performing runtime worker startup.
- The same function handles middleware, auth, RBAC, CORS warnings, metrics, error handling, and core route registration at `packages/server/src/app.ts:609` through `packages/server/src/app.ts:760`.
- A static size scan found `packages/server/src/app.ts` at 1012 lines, making it one of the largest production modules reviewed.

Remediation:
- Keep `createForgeApp` as the public entrypoint, but split implementation into internal composition modules such as `composeRuntime`, `composeMiddleware`, `composeCoreRoutes`, `composeOptionalRoutes`, and `composeOperationalServices`.
- Split `ForgeServerConfig` into smaller grouped option interfaces and re-export the aggregate type for compatibility.
- Move feature-specific defaults such as mail delivery, OpenAI compatibility, workflows, A2A, and registry route wiring into feature-owned route/plugin factories.
- Add focused unit tests around the composition helpers so later route additions do not require exercising the full server factory.

### Medium: `@dzupagent/agent-adapters` is a single facade for provider adapters, orchestration, HTTP, recovery, approval, learning, persistence, and optional SDK-backed integrations

Impact: The package describes itself as the provider adapter layer, but the root entrypoint exposes provider adapters, orchestration primitives, workflow DSL, HTTP request schemas, recovery policy engines, approval stores, learning loops, persistence stores, MCP bridges, observability, and context routing. That makes the public API difficult to segment and encourages consumers to import unrelated adapter internals from the root.

Evidence:
- `packages/agent-adapters/package.json:8` exposes only the `"."` package entrypoint.
- Optional provider SDKs are declared at `packages/agent-adapters/package.json:35` through `packages/agent-adapters/package.json:37`, while concrete provider adapters are exported from the root at `packages/agent-adapters/src/index.ts:42` through `packages/agent-adapters/src/index.ts:50`.
- Orchestration primitives are exported from the same root at `packages/agent-adapters/src/index.ts:105` through `packages/agent-adapters/src/index.ts:141`.
- Recovery, escalation, HTTP handler, request schemas, structured output, persistence, and learning surfaces are exported from the same root at `packages/agent-adapters/src/index.ts:321` through `packages/agent-adapters/src/index.ts:426`.
- Large implementation modules reinforce the same hotspot: `packages/agent-adapters/src/recovery/adapter-recovery.ts:1` documents a recovery strategy and trace-capture subsystem, and `packages/agent-adapters/src/workflow/adapter-workflow.ts:1` documents a workflow DSL subsystem.

Remediation:
- Add subpaths such as `@dzupagent/agent-adapters/providers`, `@dzupagent/agent-adapters/orchestration`, `@dzupagent/agent-adapters/http`, `@dzupagent/agent-adapters/recovery`, and `@dzupagent/agent-adapters/workflow`.
- Keep root exports for the stable provider registry and the most common adapter contracts, then migrate heavy or optional planes to subpaths.
- Classify adapter root exports similarly to `config/server-api-tiers.json`, but include optional-dependency sensitivity as part of the tiering.
- Prefer compatibility re-export windows over immediate removal.

### Low: Oversized root facades make API review harder across core packages even where boundaries are improving

Impact: Large `index.ts` files are not automatically wrong, especially in package facades, but several root entrypoints are large enough that API additions become easy to miss during review. This is structural when a facade mixes stable contracts with convenience helpers and experimental subsystems; it is stylistic only when the file is a generated or deliberate export list with a strict tier policy.

Evidence:
- A source scan counted `packages/core/src/index.ts` at 807 lines, `packages/agent/src/index.ts` at 699 lines, `packages/agent-adapters/src/index.ts` at 549 lines, `packages/server/src/index.ts` at 536 lines, and `packages/codegen/src/index.ts` at 437 lines.
- A separate export-line scan found high export density in the same roots: `packages/server/src/index.ts` with 231 export statements, `packages/core/src/index.ts` with 206, `packages/agent/src/index.ts` with 200, `packages/codegen/src/index.ts` with 168, and `packages/agent-adapters/src/index.ts` with 157.
- `packages/core/package.json:7` through `packages/core/package.json:35` shows a stronger pattern already exists for `core`: root plus `stable`, `advanced`, `quick-start`, `orchestration`, `security`, and `facades` subpaths.

Remediation:
- Apply the `@dzupagent/core` subpath pattern to other high-volume packages before removing root compatibility exports.
- Require every high-volume package root to have a generated or reviewed API tier inventory.
- Treat facade size as an architectural signal only when it mixes stability tiers or feature planes; do not spend time on purely alphabetic or comment-only reshuffling.

## Scope Reviewed

- Repository root and workspace metadata:
  - `package.json`
  - `config/architecture-boundaries.json`
  - `config/package-tiers.json`
  - `config/server-api-tiers.json`
- Architecture guardrails and reports:
  - `scripts/check-domain-boundaries.mjs`
  - `scripts/server-api-surface-report.mjs`
  - `packages/testing/src/__tests__/boundary/architecture.test.ts`
  - `docs/SERVER_API_SURFACE_INDEX.md`
  - `docs/ARCHITECTURE_REFACTOR_ROADMAP_2026-04-23.md`
- Public API and layering hotspots:
  - `packages/server/package.json`
  - `packages/server/src/index.ts`
  - `packages/server/src/ops.ts`
  - `packages/server/src/app.ts`
  - `packages/agent-adapters/package.json`
  - `packages/agent-adapters/src/index.ts`
  - `packages/core/package.json`
  - `packages/core/src/index.ts`
- Oversized module and root-facade scans across `packages/*/src`.

Validation actually run:
- `node scripts/check-domain-boundaries.mjs` passed.
- `yarn workspace @dzupagent/testing test src/__tests__/boundary/architecture.test.ts` passed: 34 tests.
- `node scripts/server-api-surface-report.mjs --check` failed before stale-doc comparison because `@dzupagent/eval-contracts` had no matching tier rule.

No broad `yarn verify`, package builds, or runtime server exercises were run for this audit.

## Strengths

- Package boundary checks exist and are not only documentation. `packages/testing/src/__tests__/boundary/architecture.test.ts` statically scans production source imports, and the focused boundary test passed in this audit.
- Domain-specific package reintroduction is guarded by a standalone script. `scripts/check-domain-boundaries.mjs` passed and prevents universal packages from importing previously extracted domain packages.
- `@dzupagent/core` already demonstrates a healthier public API pattern with explicit subpaths in `packages/core/package.json:7` through `packages/core/package.json:35`.
- `@dzupagent/server/ops` is a real subpath facade in `packages/server/src/ops.ts:1` through `packages/server/src/ops.ts:36`, so the server API reduction effort has an implementation pattern rather than only a plan.
- The server root API has a machine-readable tiering concept and a generated inventory. Even though the check currently fails, the architecture direction is correct and repairable.
- Several recent refactors reduced direct coupling, for example `packages/server/src/index.ts:128` through `packages/server/src/index.ts:141` moves eval orchestration contracts to `@dzupagent/eval-contracts` instead of concrete `@dzupagent/evals` runtime classes.

## Open Questions Or Assumptions

- I assume the `docs/SERVER_API_SURFACE_INDEX.md` counts are baseline review context, not current generated truth, because the current generator fails before it can regenerate.
- I assume `@dzupagent/eval-contracts` is intended as a neutral contract package and should not be treated as a server implementation leak, but it still needs explicit public-surface classification.
- I did not run a full source import cycle detector, so circularity risk is based on current policy coverage and dependency graph shape, not on a complete cycle report.
- I did not inspect every implementation module under the largest packages; the oversized-module findings focus on architecture hotspots visible from root facades, config composition, and package metadata.
- I assume backward compatibility matters for root exports because package versions are still `0.2.0` but current docs and sibling apps import from package roots.

## Recommended Next Actions

1. Repair `scripts/server-api-surface-report.mjs --check` by classifying `@dzupagent/eval-contracts`, then regenerate `docs/SERVER_API_SURFACE_INDEX.md`.
2. Continue the server root reduction with one narrow tranche: move runtime/control-plane exports behind `@dzupagent/server/runtime` or `@dzupagent/server/control-plane`, while keeping temporary root aliases.
3. Upgrade `config/architecture-boundaries.json` from selected forbidden edges to a complete package layer graph, and add a completeness check that every workspace package is classified.
4. Split `packages/server/src/app.ts` internally without changing the public `createForgeApp` entrypoint: route registration, middleware setup, runtime worker boot, and optional feature wiring should become separate internal modules.
5. Add an `agent-adapters` API surface inventory and subpath plan before adding more provider, orchestration, HTTP, or recovery exports to the root.
6. Add a lightweight package dependency cycle check to the existing architecture guardrail suite, and report cycles separately from forbidden-edge violations.
