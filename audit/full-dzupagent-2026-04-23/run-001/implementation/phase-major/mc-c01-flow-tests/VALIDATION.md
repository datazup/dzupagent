# MC-C01: Flow-Compiler Test Typecheck Fixes — VALIDATION

**Task**: Fix 6 typecheck errors in `packages/flow-compiler/src/__tests__/e2e.test.ts` so the flow-compiler test suite can typecheck and run cleanly.

**Status**: COMPLETE

**Date**: 2026-04-24

---

## Problem Statement

`packages/flow-compiler/src/__tests__/e2e.test.ts` contained 6 `TS2322` errors, all following the same root-cause pattern:

```
src/__tests__/e2e.test.ts(69,11): error TS2322:
  Type '{ type: string; id: string; toolRef: string; input: {}; }' is not assignable to type 'FlowNode'.
  Type '{ type: string; id: string; toolRef: string; input: {}; }' is not assignable to type 'ActionNode'.
    Types of property 'type' are incompatible.
      Type 'string' is not assignable to type '"action"'.
```

Affected lines: 69, 94 (x2), 112, 143, 167.

## Root Cause

The helper `makeActionJson(toolRef: string)` returned an inferred object literal type. Because the function signature had no explicit return type, TypeScript widened `type: 'action'` to `type: string`, so callers assigning the result to a `FlowNode` failed the discriminated-union narrowing requirement (`type: 'action'` literal).

## Fix

**File**: `packages/flow-compiler/src/__tests__/e2e.test.ts`

1. Imported the `ActionNode` type from `@dzupagent/flow-ast`.
2. Annotated `makeActionJson` return type as `ActionNode` to preserve literal narrowing through the call graph.
3. Added `as const` on a standalone `{ type: 'action', toolRef: '', input: {} }` literal at line 179 to narrow its `type` field to `'action'`.

### Diff summary

```diff
-import type { ToolResolver, ResolvedTool, FlowNode } from '@dzupagent/flow-ast'
+import type { ToolResolver, ResolvedTool, FlowNode, ActionNode } from '@dzupagent/flow-ast'

-function makeActionJson(toolRef: string) {
+function makeActionJson(toolRef: string): ActionNode {
   return { type: 'action', id: toolRef, toolRef, input: {} }
 }

-    const input: FlowNode = { type: 'action', toolRef: '', input: {} }
+    const input: FlowNode = { type: 'action' as const, toolRef: '', input: {} }
```

Three small edits, no test logic changed.

## Validation Results

### Typecheck — flow-compiler

```
$ cd packages/flow-compiler && yarn typecheck
$ tsc --noEmit
Done in 47.39s.
```

**0 errors.** All 6 target errors resolved, and previously reported implicit-any errors in `lower.test.ts` (lines 322, 345) also cleared (they were transitive — `.find()` on `artifact.edges`/`artifact.nodes` now resolves correctly once the AST types cascade).

### Typecheck — flow-dsl

```
$ cd packages/flow-dsl && yarn typecheck
$ tsc --noEmit
Done in 25.85s.
```

**0 errors.**

### Tests — flow-compiler

```
 Test Files  16 passed (16)
      Tests  289 passed (289)
   Duration  115.40s
```

All suites green, including:
- `src/__tests__/e2e.test.ts` — **33 tests passed** (previously un-runnable)
- `src/__tests__/shared.test.ts` — 31 tests
- `src/__tests__/emit.test.ts` — 43 tests
- `src/__tests__/lower.test.ts` — 26 tests
- plus 12 other suites under `test/`

### Tests — flow-dsl

```
 Test Files  11 passed (11)
      Tests  160 passed (160)
   Duration  25.47s
```

All green.

## Goal Check

| Requirement                                                        | Status |
|--------------------------------------------------------------------|--------|
| `yarn typecheck --filter @dzupagent/flow-compiler` → 0 errors      | PASS   |
| `yarn workspace @dzupagent/flow-compiler test` → ≥40 tests passing | PASS (289 tests)   |
| `yarn workspace @dzupagent/flow-dsl test` still green              | PASS (160 tests)   |

## Files Changed

- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/flow-compiler/src/__tests__/e2e.test.ts`

## Notes

- The error pattern was a textbook TypeScript widening issue: object literals returned from helpers lose their literal-type narrowing unless an explicit return type is given. Annotating `makeActionJson` with `ActionNode` is the idiomatic fix and matches how `makeAction` is done in the sibling `lower.test.ts` (which uses `: FlowNode`).
- The `lower.test.ts` implicit-any warnings that appeared in an earlier run were transient — once the helper types cascaded correctly the inference resolved. No edits to `lower.test.ts` were required.
- No test logic was altered — only type annotations.
