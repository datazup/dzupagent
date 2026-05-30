# Quick Fixes (P1 — under 2h each)

Each prompt is self-contained. Run `yarn verify` after each.

---

## QF-01: Fix `DzupEvent` union to dissolve unsafe casts
**Finding:** C-01, C-02 (Code/Critical)
**Agent:** `dzupagent-core-dev`

Add missing optional fields to `DzupEvent` discriminated union in `@dzupagent/core`:

1. Open `packages/core/src/event-bus.ts` (or wherever `DzupEvent` is defined)
2. Find which union members are missing `output?: unknown`, `errorMessage?: string`, `status?: 'success' | 'failed' | 'running'`
3. Add the missing fields to the relevant members
4. Open `packages/agent/src/agent/dzip-agent.ts` and `packages/agent/src/orchestration/orchestrator.ts`
5. Remove all `as never` and `as unknown as X` casts at `eventBus.emit()` call sites

**Acceptance:** `grep -r "as never\|as unknown as" packages/agent/src/ --include="*.ts"` returns 0. `yarn typecheck --filter=@dzupagent/agent` passes.

---

## QF-02: Fix floating Promise in agent-finalizers
**Finding:** C-05 (Code/Critical)
**Agent:** `dzupagent-agent-dev`

In `packages/agent/src/agent/agent-finalizers.ts`:

1. Find the `maybeWriteBackMemory` function
2. Find any unawaited `journal.write(...)` calls
3. Add `await` and chain `.catch(err => this.eventBus?.emit('agent:error', { runId, error: err }))`
4. Add a test in the nearest test file asserting that write failures are surfaced via the event bus

**Acceptance:** No floating promises in `agent-finalizers.ts`. Test for error propagation passes.

---

## QF-03: Fix `approval:requested` event missing `runId`
**Finding:** M-05 (Code/Critical behavioral)
**Agent:** `dzupagent-agent-dev`

In `packages/agent/src/approval/approval-gate.ts` around line 147:

1. Find the `eventBus.emit('approval:requested', ...)` call
2. Add `runId` (from the surrounding context) and `requestedAt: Date.now()` to the payload object
3. Update any test stubs that mock the `approval:requested` event shape

**Acceptance:** `AdapterApprovalHandler` receives `runId` in event. Approval gate tests pass.

---

## QF-04: Delete UCL duplicate directory
**Finding:** A-04 (Architecture/High)
**Agent:** `dzupagent-connectors-dev`

1. Run: `grep -r "from.*['\"].*ucl/" packages/ apps/ --include="*.ts" | grep -v "node_modules\|dist"` — confirm 0 production imports
2. If 0 results: delete `packages/agent-adapters/src/ucl/` entirely
3. Check `packages/agent-adapters/src/index.ts` and all barrel files — remove any `ucl/` re-exports
4. Run `yarn build --filter=@dzupagent/agent-adapters`

**Acceptance:** Build passes. No references to `ucl/` in production code.

---

## QF-05: Flip `scanFailureMode` default to `fail-closed`
**Finding:** AG-23 (Agent/Low-High security)
**Agent:** `dzupagent-agent-dev`

In `packages/agent/src/agent/tool-loop.ts` around line 255:

1. Find the `scanFailureMode` config resolution — change the fallback from `'fail-open'` to `'fail-closed'`
2. In `policy-enabled-tool-executor.ts:217-288`, same change wherever the default is applied
3. Create `packages/agent/src/presets/dev.ts` exporting `devToolLoopPreset = { scanFailureMode: 'fail-open' as const }`
4. Update `__tests__/stream-tool-guardrail-parity.test.ts` — tests that assume fail-open should use the dev preset
5. Add CHANGELOG entry under `### Breaking` for the next version

**Acceptance:** Safety scanner crash triggers `tool:blocked`. Dev preset restores old behaviour. Tests pass.

---

## QF-06: Fix `IterationBudget` config mutation
**Finding:** AG-22 (Agent/Low)
**Agent:** `dzupagent-agent-dev`

In `packages/agent/src/guardrails/iteration-budget.ts`:

1. Add `private readonly dynamicBlocks: Set<string> = new Set()`
2. Change `blockTool(name)` to `this.dynamicBlocks.add(name)` (remove the cast + in-place mutation)
3. Change `isToolBlocked(name)` to `return (this.config.blockedTools?.includes(name) ?? false) || this.dynamicBlocks.has(name)`
4. Change `fork()` to pass the same `dynamicBlocks` reference to the child instance
5. Add test: pass `Object.freeze({...})` config — `blockTool` must not throw

**Acceptance:** Frozen config does not throw. `yarn test --filter=@dzupagent/agent -- iteration-budget` passes.

---

## QF-07: Fix `IterationBudget` in `iteration-budget.ts` — already covered by QF-06

---

## QF-08: Deprecate `TeamCoordinator` in favour of `TeamRuntime`
**Finding:** H-02 (Code/P2)
**Agent:** `dzupagent-agent-dev`

In `packages/agent/src/playground/team-coordinator.ts`:

1. Add `/** @deprecated Use TeamRuntime from @dzupagent/agent/orchestration instead. */` to the class JSDoc
2. In `packages/agent/src/index.ts`, find the `TeamCoordinator` export line
3. Change to: `/** @deprecated Use TeamRuntime */ export { TeamCoordinator } from './playground/team-coordinator.js'`
4. Verify the package still builds: `yarn build --filter=@dzupagent/agent`

**Acceptance:** `TeamCoordinator` shows as deprecated in IDE autocomplete. Build passes.

---

## QF-09: Extract shared `extractTokenUsage` utility
**Finding:** H-04 (Code/P2)
**Agent:** `dzupagent-connectors-dev`

1. Create `packages/agent-adapters/src/base/extract-token-usage.ts` with a single function:
   ```ts
   export function extractTokenUsage(usage: unknown): TokenUsage { ... }
   ```
   Handling `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`.
2. Replace the duplicated logic in:
   - `packages/agent-adapters/src/claude/claude-adapter.ts`
   - `packages/agent-adapters/src/codex/codex-adapter.ts`
3. Run `yarn test --filter=@dzupagent/agent-adapters`

**Acceptance:** Single implementation. Both adapters import from shared util. Tests pass.

---

## QF-10: Extract shared `validateSkillConfig` utility
**Finding:** H-03 (Code/P2)
**Agent:** `dzupagent-connectors-dev`

1. Create `packages/agent-adapters/src/base/validate-skill-config.ts`
2. Move the 20-30 LOC skill validation block from `claude-adapter.ts`, `codex-adapter.ts`, `gemini-adapter.ts` into it
3. Each adapter calls the imported function
4. Run `yarn build --filter=@dzupagent/agent-adapters`

**Acceptance:** Single implementation used by all three adapters. Build passes.

---

## QF-11: Delete dead `playground/ui/` module
**Finding:** H-05 (Code/P2)
**Agent:** `dzupagent-agent-dev`

1. Run: `grep -r "playground/ui\|from.*playground.*ui" packages/ apps/ --include="*.ts" | grep -v "node_modules\|dist"` — confirm 0 imports
2. If 0: delete the `ui/` subdirectory inside `packages/agent/src/playground/`
3. Remove any barrel re-exports of UI components from `packages/agent/src/playground/index.ts`
4. Run `yarn build --filter=@dzupagent/agent`

**Acceptance:** Build passes. No broken imports.

---

## QF-12: Canonicalize `ApprovalMode` + `ApprovalResult` in `@dzupagent/agent-types`
**Finding:** A-16 (Architecture/Medium)
**Agent:** `dzupagent-core-dev`

1. In `packages/agent-types/src/index.ts` (or appropriate file), add:
   ```ts
   export type ApprovalMode = 'auto' | 'required' | 'conditional'
   export type ApprovalResult = 'approved' | 'rejected' | 'timeout'
   ```
2. In `packages/agent/src/approval/approval-types.ts`, replace definitions with re-exports from `@dzupagent/agent-types`
3. In `packages/agent-adapters/src/approval/adapter-approval.ts:52`, same change
4. Run `yarn typecheck`

**Acceptance:** Only one definition of each type. Typecheck passes.

---

## QF-13: Remove static Postgres/Redis imports from `pipeline-runtime.ts`
**Finding:** A-14 (Architecture/Medium)
**Agent:** `dzupagent-agent-dev`

In `packages/agent/src/pipeline/pipeline-runtime.ts:19-20`:

1. Remove `import { PostgresPipelineCheckpointStore }` and `import { RedisPipelineCheckpointStore }`
2. Find the constructor logic that conditionally creates these stores — remove it; the runtime must use only `config.checkpointStore` passed by the caller
3. Keep the classes exported from `packages/agent/src/pipeline/index.ts` for consumers
4. Run `yarn build --filter=@dzupagent/agent`

**Acceptance:** `pipeline-runtime.ts` has no direct imports of `pg` or `ioredis` related code. Build passes.

---

## QF-14: Add `./pipeline` subpath to `@dzupagent/agent` + fix `adapter-workflow.ts` import
**Finding:** A-18 (Architecture/Low)
**Agent:** `dzupagent-agent-dev`

1. In `packages/agent/package.json`, add to the `exports` map:
   ```json
   "./pipeline": { "import": "./dist/pipeline.js", "require": "./dist/pipeline.cjs", "types": "./dist/pipeline.d.ts" }
   ```
2. In `packages/agent/src/`, ensure there is a `pipeline.ts` barrel that exports `PipelineRuntime` and related types
3. In `packages/agent-adapters/src/workflow/adapter-workflow.ts:42`, change `from '@dzupagent/agent'` to `from '@dzupagent/agent/pipeline'` for `PipelineRuntime` and its types
4. Run `yarn build`

**Acceptance:** `import { PipelineRuntime } from '@dzupagent/agent/pipeline'` resolves. Build passes.

---

## QF-15: Remove duplicate `DzupError` re-export from `providers.ts`
**Finding:** A-19 (Architecture/Low)
**Agent:** `dzupagent-connectors-dev`

In `packages/agent-adapters/src/providers.ts` around line 102:

1. Find the `export ... DzupError ...` line
2. Remove it — `DzupError` is already re-exported from `packages/agent-adapters/src/utils/errors.ts`
3. Run `yarn build --filter=@dzupagent/agent-adapters`

**Acceptance:** Build passes. No duplicate exports.

---

## QF-16: Fix reflection-loop swallowed errors
**Finding:** M-04 (Code/P3)
**Agent:** `dzupagent-agent-dev`

In `packages/agent/src/reflection/reflection-loop.ts`:

1. Find the catch block that silently discards reflection errors
2. Add: `this.eventBus?.emit('reflection:failed', { runId, error: err })`
3. Return `{ output: originalOutput, reflectionSkipped: true, reason: err.message }` instead of just the original output

**Acceptance:** Test asserts `reflection:failed` is emitted on error. Reflection skipped flag is observable.

---

## QF-17: Fix structured output max-repair-attempts
**Finding:** M-08 (Code/P3)
**Agent:** `dzupagent-agent-dev`

In `packages/agent/src/agent/structured-generate.ts` around line 285:

1. Add `maxRepairAttempts?: number` (default `2`) to the config/options parameter
2. Add an iteration counter to the repair loop
3. When counter exceeds `maxRepairAttempts`, throw a `StructuredOutputMaxAttemptsError` (create this error class if it doesn't exist)

**Acceptance:** LLM returning malformed JSON 3 times throws after exactly 2 repair attempts.

---

## QF-18: Fix `void` suppressions in md-frontmatter-parser
**Finding:** M-03 (Code/P3)
**Agent:** `dzupagent-connectors-dev`

In `packages/agent-adapters/src/dzupagent/md-frontmatter-parser.ts`:

1. Find the 3 `void asyncStep()` patterns
2. Replace each with `await asyncStep()` (the function should be async if it isn't already)
3. Ensure parse errors propagate to callers

**Acceptance:** No `void` suppressions in the file. Build passes.

---

## QF-19: Delete `auto-compress.ts` shim
**Finding:** AG-13 (Agent/Low)
**Agent:** `dzupagent-agent-dev`

1. Run: `grep -r "from.*context/auto-compress\|agent.*auto-compress" packages/agent/src/ --include="*.ts"` — note all importers
2. For each importer: change `from '*/context/auto-compress'` to `from '@dzupagent/context'`
3. Delete `packages/agent/src/context/auto-compress.ts`
4. Run `yarn typecheck --filter=@dzupagent/agent`

**Acceptance:** File is deleted. Typecheck passes. 0 broken imports.

---

## QF-20: Add `check:layering` CI script
**Finding:** AG-25 (Agent/Medium)
**Agent:** `dzupagent-test-dev`

1. In the workspace root `package.json`, add:
   ```json
   "check:layering": "dependency-cruiser --config .dependency-cruiser.cjs packages/agent-adapters/src"
   ```
2. Create `.dependency-cruiser.cjs` (or extend the existing one) with a rule:
   ```js
   { from: { path: "packages/agent-adapters/src" }, to: { path: "packages/agent/src" }, severity: "error" }
   ```
3. Add `"check:layering"` to the `verify` script chain
4. Verify it catches a synthetic violation: add a test import, run `check:layering`, observe failure, remove test import

**Acceptance:** `yarn check:layering` fails when `agent-adapters/src` imports directly from `packages/agent/src`. Passes currently.
