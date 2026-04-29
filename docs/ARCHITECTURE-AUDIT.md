# Architecture Audit

## Findings

### ARCHITECTURE-001 - Medium - Server root API still exposes a broad experimental and implementation surface

**Impact:** `@dzupagent/server` remains a large semver surface rather than a narrow host-runtime entrypoint. Consumers can import route families, Drizzle schema internals, marketplace/persona/prompt/control-plane features, CLI helpers, deploy helpers, and runtime internals from the root package. That increases compatibility cost, makes product-boundary enforcement harder, and raises the blast radius of internal refactors.

**Evidence:** The server root barrel exports memory, learning, benchmark, eval, playground, workflow, metrics, and persistence routes from `packages/server/src/index.ts:37`, `packages/server/src/index.ts:41`, `packages/server/src/index.ts:43`, `packages/server/src/index.ts:45`, `packages/server/src/index.ts:51`, `packages/server/src/index.ts:55`, and `packages/server/src/index.ts:57`. It also exports Drizzle schema tables directly from `packages/server/src/index.ts:71`, marketplace/config-store route families from `packages/server/src/index.ts:273`, trigger/schedule/persona/prompt/cluster surfaces from `packages/server/src/index.ts:299`, `packages/server/src/index.ts:316`, and `packages/server/src/index.ts:335`, CLI and scorecard helpers from `packages/server/src/index.ts:378` and `packages/server/src/index.ts:408`, runtime internals from `packages/server/src/index.ts:423`, and deploy helpers from `packages/server/src/index.ts:474`. A source-count check of `packages/server/src/index.ts` against `config/server-api-tiers.json` found 231 root export sources: 51 stable, 57 secondary, 92 experimental, and 31 internal/remove-root candidates. The package does have explicit subpaths in `packages/server/package.json:10` through `packages/server/package.json:27`, but the root still re-exports most of the same surface.

**Remediation:** Treat the server root contraction as an active architecture task: keep only the stable host/runtime primitives at `@dzupagent/server`, move candidate surfaces behind `@dzupagent/server/runtime`, `@dzupagent/server/ops`, `@dzupagent/server/compat`, and future feature-specific subpaths, and add migration shims only where current consumers require them. Use the existing tier metadata to fail new root exports that are `candidate-subpath` or `remove-root`, not just document them.

### ARCHITECTURE-002 - Medium - Product-control-plane compatibility has leaked into the server config seam

**Impact:** The repository says new product-control-plane work should live in consuming apps, but `ForgeServerConfig` still contains prompt, persona, preset, marketplace, reflection, mailbox, cluster, learning, benchmark, eval, trigger, schedule, A2A, MCP, workflow, and compile fields. Even if many are compatibility surfaces, keeping them on the aggregate server config makes the path of least resistance adding more product-specific state to `packages/server`.

**Evidence:** The server boundary policy says route files are frozen and new product-control-plane routes belong in consuming apps through route plugins or app-owned Hono composition in `config/architecture-boundaries.json:70` through `config/architecture-boundaries.json:72`. The same package still exposes route-family config groups for evaluation, adapters, automation, and control-plane stores in `packages/server/src/composition/types.ts:244` through `packages/server/src/composition/types.ts:320`, then folds all of them into `ForgeRouteFamiliesConfig` and `ForgeServerConfig` in `packages/server/src/composition/types.ts:322` through `packages/server/src/composition/types.ts:370`. Optional route composition mounts those fields as built-in routes, including learning/evals/playground/A2A/config stores/reflections/mailbox clusters in `packages/server/src/composition/optional-routes.ts:81` through `packages/server/src/composition/optional-routes.ts:126`, with concrete mounts in `packages/server/src/composition/optional-routes.ts:164` through `packages/server/src/composition/optional-routes.ts:268`.

**Remediation:** Freeze `ForgeServerConfig` for compatibility and stop adding new product fields to it. Move future product-specific route options into app-owned plugin configs, and introduce a smaller `ForgeHostRuntimeConfig` for new hosts. Existing optional route families can remain, but they should be marked compatibility-only in types and docs and gradually moved behind route plugins.

### ARCHITECTURE-003 - Medium - Runtime tool resolution bypasses package boundaries with source-path dynamic imports

**Impact:** `packages/server` resolves Git and connector tools by dynamically importing sibling package source files such as `../../../codegen/src/...ts` and `../../../connectors/src/...ts`. That bypasses package `exports`, creates a source-layout dependency across package boundaries, and makes local development behavior differ from packaged runtime behavior. It also concentrates connector, MCP, Git workspace, token-profile, and security-policy logic into one 983-line server module.

**Evidence:** `resolveGitFactory()` prefers monorepo source files from `packages/codegen` before falling back to `@dzupagent/codegen` in `packages/server/src/runtime/tool-resolver.ts:367` through `packages/server/src/runtime/tool-resolver.ts:400`. `resolveConnectorFactory()` similarly falls back to source files under `packages/connectors/src` in `packages/server/src/runtime/tool-resolver.ts:700` through `packages/server/src/runtime/tool-resolver.ts:715`. The same file defines profile types and security policy handling in `packages/server/src/runtime/tool-resolver.ts:18` through `packages/server/src/runtime/tool-resolver.ts:43`, metadata and connector profile selection in `packages/server/src/runtime/tool-resolver.ts:188` through `packages/server/src/runtime/tool-resolver.ts:336`, MCP metadata policy parsing in `packages/server/src/runtime/tool-resolver.ts:459` through `packages/server/src/runtime/tool-resolver.ts:560`, and all built-in resolver dispatch in `packages/server/src/runtime/tool-resolver.ts:735` through `packages/server/src/runtime/tool-resolver.ts:983`.

**Remediation:** Replace source-path dynamic imports with exported package subpaths or injected factories. For example, expose stable Git tool factories from `@dzupagent/codegen/tools` and connector factories from `@dzupagent/connectors`, then make the server resolver depend only on those contracts. Split resolver policy, MCP resolution, connector resolution, and Git resolution into focused modules with narrow tests.

### ARCHITECTURE-004 - Medium - Public API allowlist governance covers only part of the supported package surface

**Impact:** The strongest API-surface governance applies to `@dzupagent/core`, `@dzupagent/agent`, `@dzupagent/codegen`, and the derived server inventory, but many tier-1 supported packages still expose only a root barrel with no allowlist or subpath migration plan. This leaves public API sprawl in major consumer-facing packages outside the consistency gate.

**Evidence:** `config/package-tiers.json` marks `@dzupagent/agent-adapters` as tier 1 and roadmap-driving in `config/package-tiers.json:74` through `config/package-tiers.json:84`, alongside other tier-1 packages such as memory, context, rag, connectors, otel, runtime-contracts, agent-types, eval-contracts, and cache in `config/package-tiers.json:28` through `config/package-tiers.json:140`. `config/public-api-allowlists.json` only lists `@dzupagent/core`, `@dzupagent/agent`, and `@dzupagent/codegen` in `config/public-api-allowlists.json:2` through `config/public-api-allowlists.json:145`. `@dzupagent/agent-adapters` exports only the root subpath in `packages/agent-adapters/package.json:8` through `packages/agent-adapters/package.json:13`, while its root barrel exports adapters, registry/router, middleware, orchestration, sessions, A/B testing, MCP, approval, recovery, HTTP, persistence, learning, policy compiler, dzupagent sync, interaction, provider catalog, normalization, and enrichment from `packages/agent-adapters/src/index.ts:41` through `packages/agent-adapters/src/index.ts:543`.

**Remediation:** Extend public API allowlists to every tier-1 package, starting with `@dzupagent/agent-adapters`, `@dzupagent/memory`, `@dzupagent/context`, `@dzupagent/rag`, `@dzupagent/connectors`, and `@dzupagent/otel`. Add explicit subpaths for large packages and classify root exports as stable, transitional, or internal-only candidates.

### ARCHITECTURE-005 - Medium - The contract layer mixes type contracts with runtime-heavy primitives

**Impact:** The layer graph describes layer 0 as type-only or zero-runtime-dependency foundations, but it contains packages that export runtime validators, parsers, cache backends, Arrow IPC operations, and Postgres HITL stores. This does not currently create a package cycle, but it makes the layer name misleading and weakens architectural reasoning about what can safely sit at the bottom of the graph.

**Evidence:** The layer graph labels layer 0 as "Type-only / zero-runtime-dep foundations" in `config/architecture-boundaries.json:155` through `config/architecture-boundaries.json:171`. `@dzupagent/flow-ast` describes itself as "pure, runtime-free types" in `packages/flow-ast/package.json:5`, but the package root exports `parse.js` and `validate.js` from `packages/flow-ast/src/index.ts:1` through `packages/flow-ast/src/index.ts:3`; `validate.ts` implements a Zod-compatible runtime validation surface starting at `packages/flow-ast/src/validate.ts:1` through `packages/flow-ast/src/validate.ts:29`. `@dzupagent/cache`, also in layer 0, exports `InMemoryCacheBackend`, `RedisCacheBackend`, and `CacheMiddleware` from `packages/cache/src/index.ts:9` through `packages/cache/src/index.ts:12` and declares optional `ioredis` peer dependency in `packages/cache/package.json:20` through `packages/cache/package.json:27`. `@dzupagent/memory-ipc` declares runtime dependencies on `apache-arrow` and `zod` in `packages/memory-ipc/package.json:22` through `packages/memory-ipc/package.json:25`.

**Remediation:** Either rename the bottom layer to something accurate like "leaf runtime primitives" or split pure contracts from runtime helpers. If the intent is truly type-only contracts, move parse/validate/cache/IPC runtime implementations to layer 1 packages and keep layer 0 export surfaces declaration-only.

### ARCHITECTURE-006 - Low - Internal packages still depend heavily on broad root barrels

**Impact:** Root imports such as `@dzupagent/core`, `@dzupagent/agent`, and `@dzupagent/codegen` are common inside production packages. This makes root-barrel contraction harder, hides the actual subdomain dependencies of individual modules, and increases source-level circularity risk even when the package-level dependency graph is acyclic.

**Evidence:** `flow-compiler` lowers pipeline nodes by importing many pipeline and handle types from the `@dzupagent/core` root in `packages/flow-compiler/src/lower/_shared.ts:26` through `packages/flow-compiler/src/lower/_shared.ts:41`. `server` imports `DzupAgent` from the `@dzupagent/agent` root and cost/tool-event helpers from the `@dzupagent/core` root in `packages/server/src/runtime/dzip-agent-run-executor.ts:1` through `packages/server/src/runtime/dzip-agent-run-executor.ts:9`. `agent-adapters` imports `CircuitBreaker` and `ForgeError` from the `@dzupagent/core` root in `packages/agent-adapters/src/registry/adapter-registry.ts:19` through `packages/agent-adapters/src/registry/adapter-registry.ts:20`. `rag` imports Qdrant and embedding contracts from the `@dzupagent/core` root in `packages/rag/src/qdrant-factory.ts:9` through `packages/rag/src/qdrant-factory.ts:10`.

**Remediation:** Prefer stable subpaths for internal package imports, especially where `public-api-allowlists.json` already defines a target subpath. Add a lint or architecture check that flags root imports from selected packages unless they are explicitly allowlisted during migration.

### ARCHITECTURE-007 - Low - Several responsibility clusters are oversized enough to slow safe change

**Impact:** Large modules are not automatically defects, but several files combine enough distinct responsibilities that future changes will be hard to review and test locally. This is structural because these files sit on core flows: flow validation, adapter recovery, team runtime, pipeline runtime, server tool resolution, run routes, and agent execution.

**Evidence:** A current source line-count pass, excluding tests and generated/dependency paths, found large production modules: `packages/flow-ast/src/validate.ts` at 1522 lines, `packages/agent-adapters/src/recovery/adapter-recovery.ts` at 1281 lines, `packages/agent/src/orchestration/team/team-runtime.ts` at 1057 lines, `packages/agent/src/pipeline/pipeline-runtime.ts` at 1024 lines, `packages/server/src/runtime/tool-resolver.ts` at 983 lines, `packages/server/src/routes/runs.ts` at 920 lines, and `packages/agent/src/agent/run-engine.ts` at 917 lines. The `runs` route file registers the whole run lifecycle surface, streaming, trace, pause/resume/fork/checkpoint handling, and owner/tenant helpers in one route module as shown by `packages/server/src/routes/runs.ts:1` through `packages/server/src/routes/runs.ts:44` and helper/handler setup in `packages/server/src/routes/runs.ts:45` through `packages/server/src/routes/runs.ts:160`.

**Remediation:** Split by stable responsibility boundaries, not by arbitrary line count: route schemas and owner-scope helpers, run lifecycle handlers, SSE/trace handlers, adapter recovery policy vs trace capture, and flow validator schema descriptors vs traversal. Add regression tests around the extracted seams before changing behavior.

### ARCHITECTURE-008 - Low - Server route-boundary enforcement is file-presence based, not endpoint-behavior based

**Impact:** The route boundary check prevents new unclassified route files, which is useful, but it does not prevent product endpoints, new config fields, or broader behavior from being added inside already-classified files. That leaves a governance escape hatch exactly where compatibility route files are already broad.

**Evidence:** The check requires production files under `packages/server/src/routes/**` to be declared in `serverRouteBoundaries.routeFileClassifications`, as documented in `scripts/check-domain-boundaries.mjs:1` through `scripts/check-domain-boundaries.mjs:28`. The implementation builds a set of route file paths and reports missing, duplicate, stale, or invalid classifications in `scripts/check-domain-boundaries.mjs:625` through `scripts/check-domain-boundaries.mjs:723`. It does not inspect route mounts, path patterns, HTTP methods, handler names, or config-interface growth. The current route policy already classifies 60 production route files, including compatibility-maintenance product-like route files such as clusters, learning, marketplace, personas, prompts, schedules, and triggers in `config/architecture-boundaries.json:101` through `config/architecture-boundaries.json:133`.

**Remediation:** Keep the file classification check, but add a second generated route manifest that records mounted method/path pairs and owning category. Require review when an existing server route file adds a new endpoint or when `ForgeServerConfig` gains a new route-family field.

### ARCHITECTURE-009 - Low - Server API surface freshness is not part of the default verify gate

**Impact:** The repo has a dedicated server API surface freshness check, but `yarn verify` does not run it. As a result, root-surface docs can drift while the preferred PR gate stays green, weakening the synthesis and review automation that depends on those docs.

**Evidence:** The root `verify` script runs inventory, improvements drift, package tiers, domain boundaries, terminal tool event guards, and Turbo build/typecheck/lint/test in `package.json:22` through `package.json:31`. The server API check exists separately as `check:server-api-surface` in `package.json:34`. In this audit, `yarn -s check:server-api-surface` failed with `SERVER_API_SURFACE_INDEX.md is stale. Run: yarn docs:server-api-surface`, while `yarn -s check:domain-boundaries` and `yarn -s check:package-tiers` passed.

**Remediation:** Add `check:server-api-surface` to `verify` and `verify:strict`, or explicitly document why it is intentionally outside the default PR gate. If it remains separate, the audit/synthesis wrapper should run it before trusting server API-surface docs.

### ARCHITECTURE-010 - Info - Some build entry metadata is stale even though the forced core build succeeds

**Impact:** Stale build entries create confusion during architecture review and can hide whether intended subpaths are supported. In this case the forced build succeeded, so this is not a current build failure, but the source of truth is inconsistent.

**Evidence:** `packages/core/tsup.config.ts` still lists `src/memory-ipc.ts` and `src/facades/memory.ts` as entries in `packages/core/tsup.config.ts:4` through `packages/core/tsup.config.ts:14`. Those files are absent from `packages/core/src`; `packages/core/src/facades` currently contains `index.ts`, `orchestration.ts`, `quick-start.ts`, and `security.ts`. `packages/core/package.json` exports `./stable`, `./advanced`, `./quick-start`, `./orchestration`, `./security`, and `./facades`, but no `./memory-ipc` or `./facades/memory`, in `packages/core/package.json:7` through `packages/core/package.json:36`. A forced `yarn -s turbo run build --filter=@dzupagent/core --force` completed successfully and the tsup log built only existing entries, so the stale entries did not fail this run.

**Remediation:** Remove the stale entries from `packages/core/tsup.config.ts` or restore the intended source files and package exports. Add a small build-config consistency check that verifies every configured entry file exists and every exported dist file has a corresponding source entry.

## Scope Reviewed

Reviewed the prepared repo snapshot first: `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-29/run-001/codex-prep/context/repo-snapshot.md`.

Reviewed live source/config selectively for the architecture domain:

- Root workspace scripts and governance config: `package.json`, `config/architecture-boundaries.json`, `config/package-tiers.json`, `config/public-api-allowlists.json`, `config/server-api-tiers.json`.
- Boundary/generation scripts: `scripts/check-domain-boundaries.mjs`, `scripts/server-api-surface-report.mjs`.
- Package manifests and public barrels across `packages/core`, `packages/agent`, `packages/codegen`, `packages/agent-adapters`, `packages/server`, `packages/flow-ast`, `packages/cache`, and `packages/memory-ipc`.
- Server composition and runtime seams: `packages/server/src/index.ts`, `packages/server/src/app.ts`, `packages/server/src/composition/*`, `packages/server/src/runtime.ts`, `packages/server/src/runtime/tool-resolver.ts`, `packages/server/src/runtime/dzip-agent-run-executor.ts`, and representative route modules.
- Representative downstream imports from `flow-compiler`, `server`, `agent-adapters`, and `rag`.

Generated/dependency paths and prior/old audit artifacts were not used as evidence. Existing generated API docs were not relied on as source of truth; the stale-doc result came from the current checker output.

Validation actually run during this audit:

- `yarn -s check:domain-boundaries` - passed.
- `yarn -s check:package-tiers` - passed.
- `yarn -s check:server-api-surface` - failed because `SERVER_API_SURFACE_INDEX.md` is stale.
- `yarn -s turbo run build --filter=@dzupagent/core --force` - passed.

No runtime behavior tests were run.

## Strengths

- The repository has explicit package-tier and layer-graph governance, and the current package-level graph check passed without forbidden imports, missing classifications, package-pair violations, or runtime dependency cycles.
- `packages/server` now has real subpaths (`./ops`, `./runtime`, `./compat`) and route plugin seams, which are the right direction for reducing root API pressure.
- Server route files are at least classified by architecture category, so new unclassified route files cannot silently appear under `packages/server/src/routes/**`.
- `@dzupagent/core`, `@dzupagent/agent`, and `@dzupagent/codegen` already have public API allowlist metadata and migration windows, which provides a concrete pattern to extend to other supported packages.
- The product boundary is documented in both repository guidance and source comments, and `createForgeApp` composition is split across focused helper files rather than a single monolithic app factory.

## Open Questions Or Assumptions

- I treated root export sprawl as a compatibility and architecture risk, not as a current runtime bug.
- I assumed `packages/server` should remain maintenance/compatibility-oriented per the provided AGENTS instructions and the current `serverRouteBoundaries` policy.
- I did not classify existing generated docs as authoritative; where generated docs were stale, I treated the live source/config/check output as authoritative.
- I did not run full `yarn verify`; the audit only used the focused static checks and one forced package build listed above.

## Recommended Next Actions

1. Add `check:server-api-surface` to the default verification gate or make the audit wrapper run it before synthesis.
2. Start a server-root contraction slice: move `remove-root` and experimental exports off `@dzupagent/server` root behind existing or new subpaths, and document migration aliases.
3. Extend public API allowlists to all tier-1 packages, beginning with `@dzupagent/agent-adapters`.
4. Replace server source-path dynamic imports with package subpath imports or injected factories for codegen and connectors.
5. Decide whether layer 0 means true type-only contracts or leaf runtime primitives, then rename/split packages accordingly.
6. Add route-manifest drift detection for endpoint additions inside already-classified server route files.
7. Clean stale `@dzupagent/core` tsup entries or restore the intended source/subpath files.

```json
{
  "domain": "architecture",
  "counts": { "critical": 0, "high": 0, "medium": 5, "low": 4, "info": 1 },
  "findings": [
    { "id": "ARCHITECTURE-001", "severity": "medium", "title": "Server root API still exposes a broad experimental and implementation surface", "file": "packages/server/src/index.ts" },
    { "id": "ARCHITECTURE-002", "severity": "medium", "title": "Product-control-plane compatibility has leaked into the server config seam", "file": "packages/server/src/composition/types.ts" },
    { "id": "ARCHITECTURE-003", "severity": "medium", "title": "Runtime tool resolution bypasses package boundaries with source-path dynamic imports", "file": "packages/server/src/runtime/tool-resolver.ts" },
    { "id": "ARCHITECTURE-004", "severity": "medium", "title": "Public API allowlist governance covers only part of the supported package surface", "file": "config/public-api-allowlists.json" },
    { "id": "ARCHITECTURE-005", "severity": "medium", "title": "The contract layer mixes type contracts with runtime-heavy primitives", "file": "config/architecture-boundaries.json" },
    { "id": "ARCHITECTURE-006", "severity": "low", "title": "Internal packages still depend heavily on broad root barrels", "file": "packages/flow-compiler/src/lower/_shared.ts" },
    { "id": "ARCHITECTURE-007", "severity": "low", "title": "Several responsibility clusters are oversized enough to slow safe change", "file": "packages/server/src/runtime/tool-resolver.ts" },
    { "id": "ARCHITECTURE-008", "severity": "low", "title": "Server route-boundary enforcement is file-presence based, not endpoint-behavior based", "file": "scripts/check-domain-boundaries.mjs" },
    { "id": "ARCHITECTURE-009", "severity": "low", "title": "Server API surface freshness is not part of the default verify gate", "file": "package.json" },
    { "id": "ARCHITECTURE-010", "severity": "info", "title": "Some build entry metadata is stale even though the forced core build succeeds", "file": "packages/core/tsup.config.ts" }
  ]
}
```
