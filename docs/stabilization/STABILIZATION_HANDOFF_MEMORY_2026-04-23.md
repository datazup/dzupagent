# Stabilization Handoff Memory (2026-04-23)

## Purpose

Store the unfinished, already-analyzed stabilization work in one tracked place so later sessions can resume from concrete evidence instead of reconstructing context from scattered notes, command logs, and partially updated plans.

This file is not a replacement for the tracked rebaseline. It is the detailed memory companion for work that is still open after the current verification and lint recovery wave.

Primary control references:
- [`../STABILIZATION_REBASELINE_2026-04-23.md`](../STABILIZATION_REBASELINE_2026-04-23.md)
- [`STABILIZATION_VERIFICATION_AND_RELEASE_2026-04-23.md`](./STABILIZATION_VERIFICATION_AND_RELEASE_2026-04-23.md)
- [`STABILIZATION_DOCS_AND_SCAFFOLDER_TRUTH_2026-04-23.md`](./STABILIZATION_DOCS_AND_SCAFFOLDER_TRUTH_2026-04-23.md)
- [`STABILIZATION_CONTRACT_CONVERGENCE_2026-04-23.md`](./STABILIZATION_CONTRACT_CONVERGENCE_2026-04-23.md)

## Proven Baseline In This Session

The following are already proven and should not be treated as unknown in follow-up work:

- `yarn verify:strict` completed successfully
- `yarn verify` completed successfully
- `yarn lint` completed successfully across all 30 packages
- root lint participation is workspace-complete; the earlier eight-package blind spot is closed
- warning-only lint debt in `@dzupagent/agent` and `@dzupagent/codegen` was removed
- `create-dzupagent` README and emitted versions now match the real template/preset surface
- high-traffic package README version drift (`0.1.0` references in the targeted packages) was removed

The current repo state is therefore no longer "verification recovery". It is "governance convergence".

## Unfinished Feature And Drift Areas

### 1. Naming Convergence Is Still Open

This is the highest-leverage unfinished feature area because it affects public APIs, docs, environment variables, logs, and future product positioning at once.

Current ambiguity:
- `DzupAgent` appears to be the product/framework name
- `Forge` still appears in server exports, config names, log strings, and some persistence identifiers
- `DZIP` still appears in env/config seams and some runtime terminology

Concrete hotspots:
- [packages/server/src/index.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/index.ts:11)
- [packages/server/src/cli/dev-command.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/cli/dev-command.ts:67)
- [packages/server/src/runtime/tool-resolver.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/runtime/tool-resolver.ts:643)
- `docs/CAPABILITY_MATRIX.md` currently mirrors the mixed names because it is generated from the export surface

Why it matters:
- it obscures what is stable public API versus compatibility alias
- it invites further drift in scaffolder output and downstream apps
- it makes contract reviews slower because identical concepts have multiple active names

Decision needed before broad refactor:
- choose one canonical outward-facing vocabulary for server/operator surfaces
- keep aliases only where compatibility requires them
- document the compatibility layer explicitly instead of leaving it implicit

### 2. Contract Convergence Across Producers And Consumers Is Still Open

This is the second major unfinished area. Verification is green, but ownership of route, envelope, and status semantics is still too distributed.

Active surfaces:
- `packages/server/src/routes/`
- `packages/playground/src/`
- `packages/create-dzupagent/`
- `docs/`

Risk shape:
- one server route changes
- local route tests stay green
- playground, generated apps, or docs continue to encode older payload or status semantics

This is not a current red-test problem. It is an ownership and synchronization problem.

Next tranche should focus on:
- compile/workflow/run payloads
- agent-definition and registry/operator flows
- naming/identity payloads exposed by server helpers and middleware

### 3. Generated Truth Ownership Is Better But Still Not Centralized

Current improvements already landed:
- `docs/CAPABILITY_MATRIX.md` generation/check is now plain Node and reproducible
- `create-dzupagent` emitted version truth is aligned to `0.2.0`
- high-traffic README version drift was cleaned up in the targeted packages

Still open:
- capability-matrix truth still depends on same-wave regeneration discipline
- version truth still exists in multiple doc and runtime-facing surfaces rather than one declared source
- naming convergence will require another pass over generated and documented surfaces after the canonical terminology is chosen

Meaning:
- the repo is safer than before, but still vulnerable to "truth drift by omission"
- the right long-term fix is ownership consolidation, not just more scan-and-edit passes

### 4. Release/Integration Control Model Is Still Less Mature Than Local Verification

This is not the immediate blocker, but it remains an unfinished strategic area.

Already true:
- local strict and broad verification are green

Still open:
- no explicit named integration lane with clear trigger rules
- publish/release controls are still weaker than the current proven local trust bar
- migration readiness is not yet clearly modeled as part of release truth

This should not interrupt naming and contract work, but it should stay visible in planning.

## Exact Unfinished Tasks

### Task A. Canonicalize Server Naming

Goal:
- reduce `DzupAgent` / `Forge` / `DZIP` ambiguity to one explicit public vocabulary with compatibility notes for remaining aliases

Suggested order:
1. inventory the live surface
2. decide canonical names
3. refactor the smallest public layer first
4. update docs/examples/generated truth in the same wave
5. rerun focused validation

Inventory command:
```bash
rg -n "createForgeApp|ForgeServerConfig|forge-|DZIP_|dzip-agent|getForgeIdentity|ForgeRole" packages/server packages/create-dzupagent docs
```

Minimum proof:
- focused server tests for touched files
- scaffolder tests if generated docs or examples move
- updated docs for any renamed or aliased public term

Exit rule:
- do not close while one user-facing server/operator surface still uses overlapping names without an explicit compatibility reason

### Task B. Converge Server Contract Ownership

Goal:
- make route/status/envelope behavior co-owned by server, its primary consumers, and their docs/examples

Suggested first targets:
- compile/workflow routes
- run and run-trace payload/status semantics
- registry / agent-definition routes if naming work touches them

Minimum proof:
- touched server route tests
- smallest consumer-facing proof for the changed contract
- docs/examples updated in the same execution wave

Exit rule:
- no contract-affecting change closes with server-only proof

### Task C. Preserve Generated Truth Discipline

Goal:
- prevent future regressions in docs/scaffolder truth after naming and contract work

Required checks:
```bash
yarn docs:capability-matrix
yarn check:capability-matrix
yarn workspace create-dzupagent test
rg -n "five built-in templates|0\\.1\\.0|\\^0\\.1\\.0" packages/create-dzupagent packages/*/README.md
```

Exit rule:
- if naming or exports change, generated and documented truth must land in the same wave

### Task D. Keep Lint And Verification Baselines From Regressing

Goal:
- preserve the now-clean baseline while higher-level refactors land

Required checks:
```bash
yarn lint
yarn verify
yarn verify:strict
```

If any fail:
- record the exact first failing package/check
- fix only that blocker
- rerun the narrowest proving command first
- then widen back out

## Recommended Order For The Next Session

1. run the naming inventory and choose canonical terms before editing code
2. apply the smallest naming tranche to the server public surface
3. update docs/scaffolder/examples in the same wave
4. rerun focused server and scaffolder proof
5. only then move into wider contract-convergence work

This order minimizes drift because it avoids changing producer/consumer contracts under unstable naming.

## Resume Checklist

When resuming from this memory note:

1. assume `verify`, `verify:strict`, and `lint` were green at the end of this session
2. do not spend another tranche rediscovering the old lint blind spot or README version drift; those are already closed
3. start with naming inventory, not generic repo scans
4. if a new failure appears, treat it as a regression from a known-good baseline and record it precisely

## Explicitly Finished So It Is Not Reworked

These items should not be re-opened unless a new regression appears:

- `@dzupagent/agent-adapters` coverage restoration
- capability-matrix generator/check tooling rewrite
- `create-dzupagent` emitted version alignment to `0.2.0`
- `create-dzupagent` README template/preset truth update
- root lint participation for the previously skipped eight packages
- warning-only lint cleanup in `@dzupagent/agent` and `@dzupagent/codegen`
- targeted high-traffic package README `0.1.0` cleanup
