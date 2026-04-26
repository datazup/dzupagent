# Architecture Audit

Date: 2026-04-26

## Findings

### High: Server API surface governance is blocked by an unclassified external contract re-export

Impact: `@dzupagent/server` has a dedicated public-surface inventory and check, but the current check exits before it can compare generated output with `docs/SERVER_API_SURFACE_INDEX.md`. That leaves the broadest framework package without its intended root-export guardrail, so new root exports can bypass tier classification until the classifier is repaired.

Evidence:
- `packages/server/src/index.ts:128` through `packages/server/src/index.ts:141` re-export neutral eval and benchmark contract types from `@dzupagent/eval-contracts`.
- `packages/server/package.json:30` through `packages/server/package.json:37` declares `@dzupagent/eval-contracts` as a server dependency.
- `scripts/server-api-surface-report.mjs:59` through `scripts/server-api-surface-report.mjs:68` requires every export source to match exactly one rule and throws when no rule matches.
- `scripts/server-api-surface-report.mjs:256` through `scripts/server-api-surface-report.mjs:268` applies that classifier while building the server export inventory.
- `config/server-api-tiers.json:1` through `config/server-api-tiers.json:140` starts the tier rules with server-local `./...` patterns and does not classify the external `@dzupagent/eval-contracts` source.
- Current static command result: `node scripts/server-api-surface-report.mjs --check` failed with `Expected exactly one tier rule for @dzupagent/eval-contracts, got (none)`.

Remediation:
- Add an explicit tier rule for `@dzupagent/eval-contracts`, or teach `scripts/server-api-surface-report.mjs` to classify external contract packages through a separate `external-contract` tier.
- Regenerate `docs/SERVER_API_SURFACE_INDEX.md` after the classifier completes.
- Add a focused fixture or script test that includes an external type-only re-export so future contract bridges cannot break the surface report silently.

### High: `@dzupagent/server` root still exposes multiple architecture planes through one default surface

Impact: The server root mixes app bootstrapping, route factories, persistence schemas, Drizzle stores, OpenAI compatibility helpers, platform adapters, CLI commands, scorecard helpers, runtime workers, quota primitives, and feedback hooks. This is public API sprawl rather than a stylistic export-order issue: consumers can couple to implementation planes that should have explicit subpaths and compatibility policies.

Evidence:
- `packages/server/package.json:10` through `packages/server/package.json:18` exposes only `"."` and `"./ops"` subpaths, so most server planes still share the root.
- `packages/server/src/index.ts:59` exports Drizzle table/schema symbols from `./persistence/drizzle-schema.js` directly from the root.
- `packages/server/src/index.ts:302` and `packages/server/src/index.ts:303` export concrete Drizzle-backed stores from the root.
- `packages/server/src/index.ts:313` through `packages/server/src/index.ts:343` export OpenAI-compatible request/response helpers and route factories from the same root.
- `packages/server/src/index.ts:350` through `packages/server/src/index.ts:378` export CLI, doctor, marketplace, and scorecard command APIs from the root, even though `packages/server/src/ops.ts:9` already provides an ops-specific facade for part of this surface.
- `packages/server/src/index.ts:395` through `packages/server/src/index.ts:429` export runtime scheduler, worker, executor, quota, reflector, and retrieval-feedback APIs from the root.
- A current static export-density scan counted `packages/server/src/index.ts` at 537 lines with 231 `export` statements.

Remediation:
- Keep `createForgeApp`, core server config, route-plugin contracts, core transport/middleware primitives, and platform handlers as the narrow default root.
- Add explicit subpaths for runtime/control-plane, persistence, compat, and optional extension planes, following the existing `@dzupagent/server/ops` pattern.
- Move root aliases behind deprecation comments and a compatibility window, starting with internal persistence, runtime, CLI, and optional feature exports.
- Make `node scripts/server-api-surface-report.mjs --check` a required architecture gate after the classifier finding above is fixed.

### Medium: Package boundary policy is negative-only and covers only selected workspace packages

Impact: The repo has useful static import guardrails, but the package policy currently prevents known forbidden edges rather than defining a complete layer graph. Packages omitted from the config can still become upstream dependencies of core packages without being classified, and circularity risk is only caught when it happens to cross one of the configured forbidden edges.

Evidence:
- The repository currently has 32 package workspaces under `packages/*`.
- `config/architecture-boundaries.json:2` through `config/architecture-boundaries.json:27` defines package boundary rules for only six importers: `core`, `agent`, `codegen`, `connectors`, `agent-adapters`, and `server`.
- The configured package rules are all `forbidden` lists, visible at `config/architecture-boundaries.json:4` through `config/architecture-boundaries.json:25`; the policy does not define allowed layer directions, owner metadata, or cycle handling.
- `packages/testing/src/__tests__/boundary/architecture.test.ts:322` through `packages/testing/src/__tests__/boundary/architecture.test.ts:332` creates enforcement blocks only for configured package rules.
- `packages/testing/src/__tests__/boundary/architecture.test.ts:378` through `packages/testing/src/__tests__/boundary/architecture.test.ts:382` asserts zero forbidden cross-package edges, not zero unclassified dependencies or zero dependency cycles.
- `config/package-tiers.json:257` through `config/package-tiers.json:286` marks packages such as `@dzupagent/app-tools`, `@dzupagent/code-edit-kit`, `@dzupagent/hitl-kit`, `@dzupagent/playground`, and `create-dzupagent` as tier-3 parked packages, but that tier policy is not wired into the boundary test.
- Current static command result: `yarn workspace @dzupagent/testing test src/__tests__/boundary/architecture.test.ts` passed 34 tests, which confirms the configured forbidden edges are clean but does not prove complete layering or acyclic dependencies.

Remediation:
- Convert `config/architecture-boundaries.json` from selected forbidden edges into a complete package layer graph that covers every `packages/*/package.json` workspace or explicitly ignores it.
- Add a policy-completeness assertion that fails when a new package is not classified.
- Add a package dependency cycle check over package manifests and source imports, and report cycles separately from forbidden-edge violations.
- Reuse `config/package-tiers.json` so parked packages cannot become upstream dependencies of tier-1 or tier-2 packages without an explicit policy change.

### Medium: `packages/server/src/app.ts` is an oversized composition root with too many side-effect planes

Impact: `createForgeApp` is the right public composition entrypoint, but the implementation module is now the convergence point for route registration, middleware, auth/RBAC, worker startup, stores, mail delivery, A2A, OpenAI compatibility, metrics, scheduler startup, and self-learning loops. That creates merge-conflict pressure and makes it hard to reason about which feature introduced a startup side effect or dependency.

Evidence:
- `packages/server/src/app.ts:21` through `packages/server/src/app.ts:128` imports core, agent, adapter, hitl, memory, eval-contract, route, runtime, persistence, notification, and control-plane modules into one file.
- `packages/server/src/app.ts:175` through `packages/server/src/app.ts:365` defines a single `ForgeServerConfig` interface spanning stores, auth, queueing, traces, deployment, learning, benchmarks, evals, MCP, workflow, A2A, triggers, schedules, prompts, personas, notifications, OpenAI compatibility, approval stores, safety, and quotas.
- `packages/server/src/app.ts:558` through `packages/server/src/app.ts:607` starts the server composition and also starts queue worker execution.
- `packages/server/src/app.ts:609` through `packages/server/src/app.ts:755` handles middleware, CORS warnings, auth/RBAC, shutdown guards, metrics, error handling, and core route registration.
- `packages/server/src/app.ts:765` through `packages/server/src/app.ts:916` mounts optional benchmark, eval, playground, A2A, trigger, schedule, prompt, persona, preset, marketplace, reflection, mailbox, cluster, and OpenAI-compatible route planes.
- `packages/server/src/app.ts:918` through `packages/server/src/app.ts:1009` auto-registers notification channels from environment variables and starts consolidation, prompt-feedback, and learning processors.
- A current static size scan counted `packages/server/src/app.ts` at 1012 lines.

Remediation:
- Keep `createForgeApp(config)` as the public entrypoint, but split the implementation into internal helpers such as `composeRuntime`, `composeMiddleware`, `composeCoreRoutes`, `composeOptionalRoutes`, and `composeOperationalServices`.
- Split `ForgeServerConfig` into smaller grouped option interfaces and re-export the aggregate type for compatibility.
- Move feature-specific defaults and side effects such as mail delivery, A2A task-store selection, OpenAI compatibility, consolidation, and learning loops into feature-owned composition helpers.
- Add focused tests around the composition helpers so future route additions do not require exercising the entire server factory.

### Medium: `@dzupagent/agent-adapters` is a single facade for providers, orchestration, HTTP, recovery, approval, learning, persistence, and workflow DSLs

Impact: The package name and description position it as the provider adapter layer, but the root entrypoint is also the public entrypoint for orchestration frameworks, HTTP request schemas, recovery policy engines, approval primitives, context routing, persistence, learning loops, utilities, skill projection, and workflow DSL support. That is structural coupling risk because optional provider integrations and higher-level orchestration features share one import surface and one compatibility story.

Evidence:
- `packages/agent-adapters/package.json:5` describes the package as AI agent CLI/SDK adapters, while `packages/agent-adapters/package.json:8` through `packages/agent-adapters/package.json:13` exposes only the `"."` entrypoint.
- `packages/agent-adapters/package.json:35` through `packages/agent-adapters/package.json:38` declares optional SDK dependencies for concrete providers.
- `packages/agent-adapters/src/index.ts:41` through `packages/agent-adapters/src/index.ts:51` exports concrete provider adapters from the root.
- `packages/agent-adapters/src/index.ts:97` through `packages/agent-adapters/src/index.ts:133` exports supervisor, parallel, map-reduce, and contract-net orchestration primitives from the same root.
- `packages/agent-adapters/src/index.ts:313` through `packages/agent-adapters/src/index.ts:418` exports recovery, escalation, HTTP handler, request schemas, context routing, structured output, persistence, and learning surfaces from the same root.
- `packages/agent-adapters/src/recovery/adapter-recovery.ts:1` through `packages/agent-adapters/src/recovery/adapter-recovery.ts:10` documents a full recovery strategy and trace-capture subsystem.
- `packages/agent-adapters/src/workflow/adapter-workflow.ts:1` through `packages/agent-adapters/src/workflow/adapter-workflow.ts:22` documents a declarative workflow DSL subsystem.
- A current static export-density scan counted `packages/agent-adapters/src/index.ts` at 542 lines with 155 `export` statements.

Remediation:
- Add subpaths such as `@dzupagent/agent-adapters/providers`, `@dzupagent/agent-adapters/orchestration`, `@dzupagent/agent-adapters/http`, `@dzupagent/agent-adapters/recovery`, `@dzupagent/agent-adapters/workflow`, and `@dzupagent/agent-adapters/learning`.
- Keep root exports for stable provider IDs, adapter contracts, the provider registry, and the most common adapter factories.
- Add an adapter API surface inventory similar to the server surface report, including optional-dependency sensitivity in the tiering.
- Use compatibility re-exports during migration rather than removing root exports immediately.

### Low: Large root facades make API review harder across core framework packages

Impact: Large facade files are not automatically a defect. In this repo, though, several root entrypoints mix stable contracts, convenience helpers, advanced modules, and experimental planes, so API additions are hard to review consistently. This is structural when stability tiers are mixed in one root; it would be stylistic only if the files were generated or governed by complete surface inventories.

Evidence:
- A current static scan counted high-density root facades: `packages/server/src/index.ts` has 231 export statements in 537 lines, `packages/core/src/index.ts` has 206 in 808 lines, `packages/agent/src/index.ts` has 201 in 704 lines, `packages/codegen/src/index.ts` has 168 in 438 lines, `packages/agent-adapters/src/index.ts` has 155 in 542 lines, and `packages/memory/src/index.ts` has 128 in 396 lines.
- `packages/core/package.json:7` through `packages/core/package.json:35` shows a stronger pattern already exists: root plus `./stable`, `./advanced`, `./quick-start`, `./orchestration`, `./security`, and `./facades` subpaths.
- `packages/server/package.json:10` through `packages/server/package.json:18` and `packages/agent-adapters/package.json:8` through `packages/agent-adapters/package.json:13` show that server and agent-adapters have not yet applied an equivalent subpath structure to their largest public surfaces.

Remediation:
- Apply the `@dzupagent/core` subpath pattern to other high-volume packages before adding more root exports.
- Require a generated or reviewed API tier inventory for every high-density package facade.
- Treat facade size as an architecture signal only where stability tiers or feature planes are mixed; avoid low-value reshuffling of comments, alphabetization, or purely cosmetic export movement.

## Scope Reviewed

- Current repository and workspace metadata:
  - `package.json`
  - `packages/*/package.json`
  - `config/architecture-boundaries.json`
  - `config/package-tiers.json`
  - `config/server-api-tiers.json`
- Current architecture guardrails:
  - `scripts/check-domain-boundaries.mjs`
  - `scripts/server-api-surface-report.mjs`
  - `packages/testing/src/__tests__/boundary/architecture.test.ts`
- Current public API and layering hotspots:
  - `packages/server/package.json`
  - `packages/server/src/index.ts`
  - `packages/server/src/ops.ts`
  - `packages/server/src/app.ts`
  - `packages/agent-adapters/package.json`
  - `packages/agent-adapters/src/index.ts`
  - `packages/agent-adapters/src/recovery/adapter-recovery.ts`
  - `packages/agent-adapters/src/workflow/adapter-workflow.ts`
  - `packages/core/package.json`
- Current oversized-module and facade scans across `packages/*/src`.
- Prepared audit prompt pack:
  - `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-26/run-001/codex-prep/prompts/04-architecture.md`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-26/run-001/codex-prep/manifest.json`

Validation actually run:
- `node scripts/check-domain-boundaries.mjs` passed.
- `yarn workspace @dzupagent/testing test src/__tests__/boundary/architecture.test.ts` passed: 34 tests.
- `node scripts/server-api-surface-report.mjs --check` failed before stale-doc comparison because `@dzupagent/eval-contracts` had no matching tier rule.

No broad `yarn verify`, package builds, full test suite, runtime server startup, or browser validation was run for this architecture audit.

## Strengths

- Architecture checks are not documentation-only. `scripts/check-domain-boundaries.mjs` passed, and `packages/testing/src/__tests__/boundary/architecture.test.ts` passed the configured import-boundary suite.
- The repo has current package-tier and boundary config files, which gives the architecture work a policy home instead of relying only on reviewer memory.
- `@dzupagent/core` already demonstrates a healthier public API segmentation pattern with explicit `stable`, `advanced`, `quick-start`, `orchestration`, `security`, and `facades` subpaths.
- `@dzupagent/server/ops` is a real subpath facade, not just a plan, and can be used as the migration template for runtime, persistence, compat, and control-plane surfaces.
- The server no longer imports concrete eval orchestrators just to type injected orchestrators; the re-export from `@dzupagent/eval-contracts` is directionally correct even though the surface classifier has not caught up.
- The boundary test suite separates package-to-package and app-to-app import enforcement, which is a useful foundation for broader layering and cycle checks.

## Open Questions Or Assumptions

- I treated prior audit and stabilization docs as comparison context only; all findings above are based on current files or commands inspected in this pass.
- I assume `@dzupagent/eval-contracts` is intended to be a neutral contract package and should be classified as such, not removed from server immediately.
- I did not run a complete dependency cycle detector, so circularity risk is based on policy shape, dependency exposure, and source-import guardrail gaps rather than a proven current cycle.
- I did not inspect every implementation module in every package. The oversized-module findings focus on public facades and composition hotspots because those are the architecture surfaces most likely to lock in downstream coupling.
- I assume backward compatibility matters for root exports because workspace packages are versioned and sibling consumers may still import root symbols directly.

## Recommended Next Actions

1. Fix `scripts/server-api-surface-report.mjs --check` by classifying `@dzupagent/eval-contracts`, then regenerate `docs/SERVER_API_SURFACE_INDEX.md`.
2. Continue server root reduction with one narrow tranche: introduce a runtime/control-plane subpath and move worker, executor, quota, registry/control-plane, and feedback exports behind it while preserving temporary root aliases.
3. Expand `config/architecture-boundaries.json` into a complete package layer graph and add a completeness check for every `packages/*/package.json` workspace.
4. Add a lightweight package dependency cycle check and report cycles separately from forbidden-edge violations.
5. Split `packages/server/src/app.ts` internally without changing `createForgeApp(config)`: start with middleware setup, runtime worker boot, optional route mounting, and operational side effects.
6. Add an `@dzupagent/agent-adapters` API surface inventory and subpath plan before adding more provider, orchestration, HTTP, recovery, workflow, or learning exports to the root.
