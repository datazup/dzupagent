# Architecture Quick Fixes

Mechanical, low-risk tasks deliverable in ≤4 hours each. Run sequentially or in parallel; none depend on each other.

---

## QF-ARCH-001: Update codegen layering rule to reflect actual hierarchy

**Files:**
- `packages/codegen/src/guardrails/rules/layering-rule.ts`
- `docs/dzupagent/architecture/LAYERING.md` (new)

**Change:**
Replace `DEFAULT_LAYERS` in `layering-rule.ts` with the verified ordering:

```ts
const DEFAULT_LAYERS: string[][] = [
  ['@dzupagent/runtime-contracts', '@dzupagent/agent-types', '@dzupagent/adapter-types', '@dzupagent/eval-contracts'],
  ['@dzupagent/core'],
  ['@dzupagent/cache', '@dzupagent/memory-ipc', '@dzupagent/otel'],
  ['@dzupagent/context', '@dzupagent/memory', '@dzupagent/security', '@dzupagent/rag', '@dzupagent/connectors', '@dzupagent/connectors-browser', '@dzupagent/connectors-documents', '@dzupagent/scraper'],
  ['@dzupagent/flow-ast'],
  ['@dzupagent/flow-dsl', '@dzupagent/flow-compiler'],
  ['@dzupagent/codegen', '@dzupagent/agent', '@dzupagent/code-edit-kit'],
  ['@dzupagent/agent-adapters', '@dzupagent/adapter-rules'],
  ['@dzupagent/server', '@dzupagent/express', '@dzupagent/evals', '@dzupagent/app-tools', '@dzupagent/hitl-kit', '@dzupagent/testing'],
]
```

Add `docs/dzupagent/architecture/LAYERING.md` with this table and rationale (one line per layer).

**Validation:**
- Add a unit test in `packages/codegen/src/guardrails/__tests__/` verifying the rule fires when, e.g., a synthetic `core` file imports `@dzupagent/agent`.
- `yarn workspace @dzupagent/codegen test` passes.

**Target agent:** `dzupagent-core-dev`
**Effort:** 2-3 hours.

---

## QF-ARCH-002: Add `madge` circular-dependency CI gate

**Files:**
- `package.json` (root)
- `.madgerc` (new, allowlist current 28 cycles)
- `.github/workflows/*.yml` (add the step)

**Change:**

```jsonc
// package.json
{
  "scripts": {
    "check:cycles": "madge --circular --extensions ts packages",
    "verify": "turbo run build typecheck lint test && yarn check:cycles"
  },
  "devDependencies": {
    "madge": "^8.0.0"
  }
}
```

Initial `.madgerc`:
```json
{
  "excludeRegExp": [
    "packages/(adapter-types|server|agent-adapters|agent|core)/.+ — TODO: remove as ARCH-005 cycles are broken"
  ]
}
```

(Or, if `madge` does not honour the regex semantics needed, snapshot the current 28 cycles into `audit/baseline-cycles.txt` and write a wrapper script that diffs against it.)

**Validation:**
- `yarn check:cycles` runs locally.
- Adding a synthetic new cycle fails the gate.
- CI workflow runs the check.

**Target agent:** `dzupagent-core-dev`
**Effort:** 2-3 hours.

---

## QF-ARCH-003: Remove `QdrantAdapter` and other vector-DB symbols from `@dzupagent/core` root barrel

**Files:** `packages/core/src/index.ts`

**Change:**
- Locate the block exporting vector-DB adapters (`QdrantAdapter`, `LanceDBAdapter`, `QdrantAdapterConfig`, `translateQdrantFilter`, etc., approximately lines 780-810).
- Remove those exports from the root barrel.
- They remain available via `import { QdrantAdapter } from '@dzupagent/core/vectordb'` (subpath already exists internally).

Update the only known external consumer:
- `packages/rag/src/qdrant-factory.ts` — switch `from '@dzupagent/core/advanced'` to `from '@dzupagent/core/vectordb'` (or to `@dzupagent/rag` after ARCH-003 is delivered).

**Validation:**
- `grep -rn "from '@dzupagent/core'" packages --include="*.ts" | xargs grep -l "QdrantAdapter\|LanceDBAdapter"` returns no matches.
- `yarn build` and `yarn typecheck` pass.

**Target agent:** `dzupagent-core-dev`
**Effort:** 1-2 hours.

---

## QF-ARCH-004: Stub READMEs for 12 packages without one

**Files:** `packages/<name>/README.md` for each package missing one.

**Discover missing READMEs:**
```bash
for p in packages/*/; do [ ! -f "$p/README.md" ] && echo "$p"; done
```

**Template:**
```markdown
# @dzupagent/<name>

> One-paragraph purpose.

## Layer
This package is at layer N (see `docs/dzupagent/architecture/LAYERING.md`).
- Depends on: ...
- Consumed by: ...

## Public API
- Subpath `.`: ...
- Subpath `./<sub>`: ...

## Example
```ts
import { ... } from '@dzupagent/<name>'
```

## See also
- ARCHITECTURE.md (if present)
```

**Validation:**
- `find packages -maxdepth 2 -name "README.md" | wc -l` returns 32.

**Target agent:** `dzupagent-codegen-dev` or `dzupagent-core-dev`
**Effort:** 4-6 hours.

---

## QF-ARCH-005: Audit `@dzupagent/agent-adapters` subpath exports for actual usage

**Files:**
- `packages/agent-adapters/package.json`
- `packages/agent-adapters/ARCHITECTURE.md` (update)

**Change:**
For each subpath in agent-adapters' `exports` field (`./providers`, `./orchestration`, `./workflow`, `./http`, `./persistence`, `./runs`, `./integration`, `./rules`, `./learning`, `./recovery`):

```bash
for sub in providers orchestration workflow http persistence runs integration rules learning recovery; do
  count=$(grep -rn "from '@dzupagent/agent-adapters/$sub" packages apps --include="*.ts" 2>/dev/null | grep -v ".test.ts" | wc -l)
  echo "$sub: $count external consumers"
done
```

For each subpath with **zero** external consumers, either:
1. Remove the subpath export from `package.json` (and the corresponding entry file), OR
2. Document its intended consumer in `ARCHITECTURE.md` with a roadmap link.

**Validation:**
- Every remaining subpath has ≥1 external consumer or a documented future use.

**Target agent:** `dzupagent-agent-dev`
**Effort:** 2-3 hours.

---

## QF-ARCH-006: Add memory subpath exports

**Files:**
- `packages/memory/package.json`
- `packages/memory/src/{service,store,consolidation,retrieval,sharing,convention,crdt,provenance}.ts` (new entry barrels — 6-8 files)
- `packages/memory/tsup.config.ts` (add multi-entry build)

**Change:**
Add subpath exports matching the directory structure inside `packages/memory/src/`:

```jsonc
{
  "exports": {
    ".":             { "import": "./dist/index.js",           "types": "./dist/index.d.ts" },
    "./service":     { "import": "./dist/service.js",         "types": "./dist/service.d.ts" },
    "./store":       { "import": "./dist/store.js",           "types": "./dist/store.d.ts" },
    "./consolidation": { "import": "./dist/consolidation.js", "types": "./dist/consolidation.d.ts" },
    "./retrieval":   { "import": "./dist/retrieval.js",       "types": "./dist/retrieval.d.ts" },
    "./sharing":     { "import": "./dist/sharing.js",         "types": "./dist/sharing.d.ts" },
    "./convention":  { "import": "./dist/convention.js",      "types": "./dist/convention.d.ts" },
    "./crdt":        { "import": "./dist/crdt.js",            "types": "./dist/crdt.d.ts" },
    "./provenance":  { "import": "./dist/provenance.js",      "types": "./dist/provenance.d.ts" }
  }
}
```

Each subpath barrel re-exports the public symbols from that subdir.

**Validation:**
- `yarn workspace @dzupagent/memory build` produces all dist files.
- `import { MemorySpaceManager } from '@dzupagent/memory/sharing'` resolves.

**Target agent:** `dzupagent-core-dev`
**Effort:** 4-6 hours.

---

## QF-ARCH-007: Break the two two-file cycles in `core` (template-cache↔resolver, config-loader↔schema)

**Files:**
- `packages/core/src/prompt/template-store.ts` (new)
- `packages/core/src/prompt/template-cache.ts` (edit)
- `packages/core/src/prompt/template-resolver.ts` (edit)
- `packages/core/src/config/config-types.ts` (new)
- `packages/core/src/config/config-loader.ts` (edit)
- `packages/core/src/config/config-schema.ts` (edit)

**Change A — prompt cycle:**
- Move the `PromptStore` interface from `template-resolver.ts` to a new `template-store.ts`.
- `template-cache.ts` imports `PromptStore` from `./template-store.js` (was: `./template-resolver.js`).
- `template-resolver.ts` re-exports `PromptStore` for backward compatibility.

**Change B — config cycle:**
- Move the `ForgeConfig` (and any other shared types) from `config-loader.ts` to `config-types.ts`.
- `config-schema.ts` imports `ForgeConfig` from `./config-types.js` (was: `./config-loader.js`).
- `config-loader.ts` imports types from `./config-types.js`.

**Validation:**
- `npx madge --circular packages/core/src` no longer reports the two prompt/config cycles.
- `yarn workspace @dzupagent/core build typecheck test` passes.

**Target agent:** `dzupagent-core-dev`
**Effort:** 2-3 hours.

---

## QF-ARCH-008: Break the two-file cycle in `server` (types↔middleware/rbac)

**Files:**
- `packages/server/src/types.ts`
- `packages/server/src/middleware/rbac.ts`
- `packages/server/src/rbac-types.ts` (new)

**Change:**
- Move the `ForgeRole` type (and any other types `rbac.ts` exports) into a new top-level `server/src/rbac-types.ts`.
- `middleware/rbac.ts` imports types from `../rbac-types.js`.
- `types.ts` imports `ForgeRole` from `./rbac-types.js`.

**Validation:**
- `npx madge --circular packages/server/src` no longer reports cycle 22.
- `yarn workspace @dzupagent/server build typecheck` passes.

**Target agent:** `dzupagent-core-dev`
**Effort:** 2 hours.

---

## QF-ARCH-009: Break the two-file cycle in `server` (a2a/task-handler ↔ push-notifications)

**Files:**
- `packages/server/src/a2a/task-handler.ts`
- `packages/server/src/a2a/push-notifications.ts`
- `packages/server/src/a2a/a2a-types.ts` (new or extend existing)

**Change:**
Apply the same shared-types extraction pattern. Identify the type or const that `push-notifications.ts` imports from `task-handler.ts` (or vice-versa), move it to `a2a-types.ts`, and update both files.

**Validation:**
- `npx madge --circular packages/server/src` no longer reports cycle 21.

**Target agent:** `dzupagent-core-dev`
**Effort:** 2 hours.

---

## QF-ARCH-010: Break the two-file cycle in `server` (runtime/tool-resolver ↔ custom-tool-instantiation)

**Files:**
- `packages/server/src/runtime/tool-resolver.ts`
- `packages/server/src/runtime/custom-tool-instantiation.ts`
- `packages/server/src/runtime/tool-types.ts` (new)

**Change:**
Same pattern: shared types/interfaces move to `tool-types.ts`; both files import from there.

**Validation:**
- `npx madge --circular packages/server/src` no longer reports cycle 28.

**Target agent:** `dzupagent-core-dev`
**Effort:** 2 hours.

---

## QF-ARCH-011: Break the agent-adapters two-file cycles (approval, observability)

**Files:**
- `packages/agent-adapters/src/approval/{adapter-approval,approval-audit,approval-types}.ts`
- `packages/agent-adapters/src/observability/{adapter-tracer,tool-span-tracker,observability-types}.ts`

**Change:**
For each of the two cycles (approval, observability), introduce a small `*-types.ts` sibling file with the shared types/interfaces; refactor both files to import from it instead of from each other.

**Validation:**
- `npx madge --circular packages/agent-adapters/src` no longer reports cycles 2 and 3.

**Target agent:** `dzupagent-agent-dev`
**Effort:** 3-4 hours.

---

## QF-ARCH-012: Document the contract-package distinction

**Files:**
- `docs/dzupagent/architecture/CONTRACTS.md` (new)
- `packages/runtime-contracts/README.md`
- `packages/agent-types/README.md`
- `packages/adapter-types/README.md`
- `packages/eval-contracts/README.md`
- `packages/adapter-rules/README.md`

**Change:**
Add `docs/dzupagent/architecture/CONTRACTS.md` with a glossary explaining the responsibility of each contract-tier package:

```markdown
# Contract Packages

| Package | Owns | Examples |
|---------|------|----------|
| @dzupagent/runtime-contracts | Ports invoked by agent kernels at runtime | SkillResolutionContext, ... |
| @dzupagent/agent-types | Configuration and policy shapes | StuckDetectorConfig, RetryPolicy |
| @dzupagent/adapter-types | Provider-adapter SDK ports | AdapterCapabilityProfile, AgentEvent |
| @dzupagent/eval-contracts | Evaluation scorer/benchmark contracts | EvalScorer, EvalSuite |
| @dzupagent/adapter-rules | Rules code (not pure types) | rule compilers, projectors |
```

Add a one-paragraph excerpt to each package's README pointing at this glossary.

**Validation:**
- The doc exists and each contract package's README links to it.

**Target agent:** `dzupagent-codegen-dev`
**Effort:** 2-4 hours.
