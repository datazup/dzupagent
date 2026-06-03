# W4 Durable Fork/Branch Resume — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On resume after a mid-fork crash, skip branches that fully completed (restoring their merged effect from the checkpoint) and re-run only unfinished branches — bounding crash re-execution to at most one partial branch's nodes.

**Architecture:** Mirror the W3 durable-loop-resume pattern at _branch_ granularity. Add an optional `PipelineCheckpoint.forkState` field that records each completed branch's `stateDelta` + `nodeResults`. The fork executor checkpoints after each branch completes (via an `onBranchComplete` callback), restores completed branches on resume instead of re-running them, and the runtime re-enters a mid-flight fork node the same way it re-enters a mid-flight loop node. Threading `runId` into the branch executor also closes the W5 fork-context idempotency-key gap.

**Tech Stack:** TypeScript (strict, ESM), Vitest, Turbo, Postgres (pg-compatible client). Packages: `@dzupagent/core`, `@dzupagent/agent`.

**Spec:** `docs/superpowers/specs/2026-06-03-w4-durable-fork-branch-resume-design.md`

**Working branch:** `harden/mcp-stdio-arg-policy` (already checked out in `dzupagent/`).

---

## Pre-flight (do once before Task 1)

- [ ] **Confirm clean-ish state and correct branch**

Run (from `dzupagent/`):

```bash
git branch --show-current
git log --oneline -1
```

Expected: branch `harden/mcp-stdio-arg-policy`, HEAD is `1449ff55 docs(orchestration): W4 ... design spec`.

> ⚠️ The working tree has a **concurrent session's** unrelated changes under `packages/subagents/` and `packages/agent-adapters/`. Do **not** stage or revert them. Every commit in this plan stages **only the explicitly listed files** (`git add <file> ...`, never `git add -A`).

---

## File Structure

| File                                                                   | Responsibility                  | Change                                                                                     |
| ---------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------ |
| `packages/core/src/pipeline/pipeline-checkpoint-store.ts`              | Checkpoint shape                | **Modify** — add optional `forkState` field                                                |
| `packages/agent/src/pipeline/pipeline-runtime/checkpoint-helpers.ts`   | Build a checkpoint object       | **Modify** — accept + snapshot `forkState`                                                 |
| `packages/agent/src/pipeline/pipeline-runtime/fork-branch-executor.ts` | Fork fan-out + branch execution | **Modify** — `runId` dep, `ForkResumeOptions`, restore/skip logic, branch `idempotencyKey` |
| `packages/agent/src/pipeline/pipeline-executor.ts`                     | Graph walk + checkpointing      | **Modify** — `forkState` plumbing, new `dispatchFork`                                      |
| `packages/agent/src/pipeline/pipeline-runtime.ts`                      | Lifecycle, execute/resume entry | **Modify** — init/restore `forkState`, `findMidFlightForkNodeId`                           |
| `packages/agent/src/pipeline/postgres-checkpoint-store.ts`             | Postgres persistence            | **Modify** — `fork_state` column/migration/upsert/restore                                  |
| `packages/agent/src/__tests__/postgres-checkpoint-store.test.ts`       | Postgres store tests            | **Modify** — setup-DDL count + round-trip                                                  |
| `packages/agent/src/__tests__/pipeline-fork-resume.test.ts`            | W4 behavior tests               | **Create**                                                                                 |

Order rationale: core type first (everyone depends on it), then the helper, then the executor pieces, then the runtime wiring, then postgres, then the behavior test last (it needs all wiring in place). Each task commits independently.

---

## Task 1: Add `forkState` to the checkpoint shape (core)

**Files:**

- Modify: `packages/core/src/pipeline/pipeline-checkpoint-store.ts:49-50` (after `loopState`)

- [ ] **Step 1: Add the field to `PipelineCheckpoint`**

In `pipeline-checkpoint-store.ts`, immediately after the `loopState?: ...` field (line 49) and before `state:` (line 50/51), insert:

```ts
  /**
   * Per-fork branch progress for durable fork/branch resume (W4).
   *
   * Maps a fork node's `forkId` to the branches that have fully completed,
   * each with the state delta and node results it produced. On resume,
   * completed branches are restored from here (not re-run) and only
   * unfinished branches re-execute; the final merge combines restored +
   * freshly-run results in deterministic outgoing-edge order. An entry is
   * removed once the fork's join completes. Optional for backward
   * compatibility; absence means "no fork is mid-flight". `nodeResults` is
   * the JSON-serialized form of a `NodeResult` map (`nodeId` -> result);
   * this module intentionally avoids importing `NodeResult` to keep the
   * checkpoint store free of runtime-contracts coupling.
   */
  forkState?: Record<
    string,
    {
      branches: Record<
        string,
        {
          stateDelta: Record<string, unknown>;
          nodeResults: Record<string, unknown>;
        }
      >;
    }
  >;
```

- [ ] **Step 2: Typecheck core**

Run (from `dzupagent/`):

```bash
yarn typecheck --filter=@dzupagent/core
```

Expected: PASS (no errors). The field is optional, so no consumer breaks.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/pipeline/pipeline-checkpoint-store.ts
git commit -m "feat(pipeline): add forkState to PipelineCheckpoint (W4)

Optional, backward-compatible field recording per-branch progress for
durable fork/branch resume. Mirrors loopState (W3). Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Thread `forkState` through `createPipelineCheckpoint` (helper)

**Files:**

- Modify: `packages/agent/src/pipeline/pipeline-runtime/checkpoint-helpers.ts`

- [ ] **Step 1: Add `forkState` to the options + output**

In `checkpoint-helpers.ts`, add to the `options` type (after the `loopState` option at line 15):

```ts
  /** Per-fork branch progress for durable fork/branch resume (W4). */
  forkState?: Record<
    string,
    { branches: Record<string, { stateDelta: Record<string, unknown>; nodeResults: Record<string, unknown> }> }
  >;
```

And in the returned `omitUndefined({...})` object, after the `loopState:` entry (line 29-32), add:

```ts
    forkState:
      options.forkState && Object.keys(options.forkState).length > 0
        ? structuredClone(options.forkState)
        : undefined,
```

- [ ] **Step 2: Typecheck agent**

Run:

```bash
yarn typecheck --filter=@dzupagent/agent
```

Expected: PASS. (Callers don't pass `forkState` yet — it's optional.)

- [ ] **Step 3: Commit**

```bash
git add packages/agent/src/pipeline/pipeline-runtime/checkpoint-helpers.ts
git commit -m "feat(pipeline): thread forkState through createPipelineCheckpoint (W4)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Add `runId` + idempotency key + resume options to the fork executor

**Files:**

- Modify: `packages/agent/src/pipeline/pipeline-runtime/fork-branch-executor.ts`

This task adds the resume machinery to `handleFork`/`executeBranch` but **all new params are optional**, so existing callers keep compiling. The executor wires them up in Task 4.

- [ ] **Step 1: Import the idempotency-key builder + add deps/types**

At the top of `fork-branch-executor.ts`, add to the imports (after the `branch-merge` import block, line 29):

```ts
import { nodeIdempotencyKey } from "./idempotency.js";
```

Add `runId` to `ForkBranchExecutorDeps` (after `findJoinNode`, line 36):

```ts
/** Stable run identifier — used to derive per-branch-node idempotency keys (W4/W5). */
runId: string;
```

Add a new exported interface after `ForkBranchExecutorDeps` (after line 37):

```ts
/** Resume inputs for durable fork/branch resume (W4). */
export interface ForkResumeOptions {
  /**
   * branchStartId -> already-completed branch result. Restored (not re-run)
   * on resume. Absent branches execute normally.
   */
  completedBranches: Record<string, BranchExecutionResult>;
  /**
   * Called after each freshly-run branch completes successfully, before the
   * join merge, so the runtime can persist the branch's progress.
   */
  onBranchComplete: (
    branchStartId: string,
    result: BranchExecutionResult,
  ) => Promise<void>;
}
```

- [ ] **Step 2: Accept `resume` in `handleFork` and skip/restore completed branches**

Change the `handleFork` signature (line 44-50) to add a trailing optional `resume` param:

```ts
export async function handleFork(
  deps: ForkBranchExecutorDeps,
  forkNode: ForkNode,
  runState: Record<string, unknown>,
  nodeResults: Map<string, NodeResult>,
  completedNodeIds: string[],
  resume?: ForkResumeOptions,
): Promise<void> {
```

Replace the branch-promise mapping block (current lines 72-88) with restore-or-run logic:

```ts
// Execute branches in parallel — each branch gets its own span. On resume,
// a branch already recorded in `resume.completedBranches` is restored
// verbatim instead of re-running.
const branchPromises = branchStartIds.map(async (startId) => {
  const restored = resume?.completedBranches[startId];
  if (restored) return restored;

  const branchSpan = config.tracer?.startPhaseSpan(`branch:${startId}`, {
    attributes: {
      "forge.pipeline.node_type": "branch",
      "forge.pipeline.phase": startId,
    },
  });
  try {
    const result = await executeBranch(
      deps,
      startId,
      joinNode?.id,
      branchBaseState,
      branchBaseResults,
    );
    if (branchSpan) config.tracer?.endSpanOk(branchSpan);
    // Persist this branch's progress before the join merge (W4).
    if (resume) await resume.onBranchComplete(startId, result);
    return result;
  } catch (err) {
    if (branchSpan) config.tracer?.endSpanWithError(branchSpan, err);
    throw err;
  }
});
```

- [ ] **Step 3: Set the branch-node `idempotencyKey` in `executeBranch`**

In `executeBranch`, change the `NodeExecutionContext` construction (current lines 135-139) to include the key (and destructure `runId` from deps at line 121):

```ts
const { config, nodeMap, outgoingEdges, emit, runId } = deps;
```

```ts
const context: NodeExecutionContext = omitUndefined({
  state: runState,
  previousResults: nodeResults,
  signal: config.signal,
  // W5 fork-context gap closed: branch nodes now get a stable key.
  idempotencyKey: nodeIdempotencyKey(runId, node.id),
});
```

- [ ] **Step 4: Typecheck agent**

Run:

```bash
yarn typecheck --filter=@dzupagent/agent
```

Expected: FAIL — `pipeline-executor.ts`'s `forkDeps()` does not yet supply `runId`. This is expected; Task 4 fixes it. (If you prefer a green checkpoint here, do Step 5 of Task 4 first, but the plan commits them separately.)

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/pipeline/pipeline-runtime/fork-branch-executor.ts
git commit -m "feat(pipeline): fork executor resume options + branch idempotency key (W4/W5)

handleFork gains optional ForkResumeOptions (restore completed branches,
persist each via onBranchComplete); branch contexts now receive a stable
idempotencyKey, closing the W5 fork-context gap. runId now required on
ForkBranchExecutorDeps. Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Wire `dispatchFork` + `forkState` plumbing into the executor

**Files:**

- Modify: `packages/agent/src/pipeline/pipeline-executor.ts`

- [ ] **Step 1: Add `forkState` to `ExecuteFromNodeInput`**

In the `ExecuteFromNodeInput` interface (after `loopState` at line 91), add:

```ts
/** Per-fork branch progress for durable fork/branch resume (W4). */
forkState: Record<
  string,
  {
    branches: Record<
      string,
      {
        stateDelta: Record<string, unknown>;
        nodeResults: Record<string, unknown>;
      }
    >;
  }
>;
```

- [ ] **Step 2: Destructure + thread `forkState` in `executeFromNode`**

In `executeFromNode`, add `forkState` to the destructure block (after `loopState` at line 125), and pass it to `handleSuspend`, the fork branch, `dispatchLoop`, and `dispatchNode` calls.

Replace the **fork block** (current lines 174-203) with a delegation to a new `dispatchFork`:

```ts
// Fork: execute branches in parallel with durable per-branch resume,
// then continue from join.
if (node.type === "fork") {
  const forkOutcome = await this.dispatchFork(
    node as ForkNode,
    runId,
    runState,
    nodeResults,
    completedNodeIds,
    nodeIdempotencyKeys,
    loopState,
    forkState,
    versionTracker,
  );
  currentNodeId = forkOutcome.nextNodeId;
  continue;
}
```

Update the `handleSuspend(...)` call (line 161-171) to pass `forkState` after `loopState`:

```ts
return this.handleSuspend(
  node.id,
  runId,
  runState,
  nodeResults,
  completedNodeIds,
  nodeIdempotencyKeys,
  loopState,
  forkState,
  versionTracker,
  startTime,
);
```

Update the `dispatchLoop(...)` call (line 207-217) and `dispatchNode(...)` call (line 224-234) to pass `forkState` after `loopState` (you will add the param to their signatures in Steps 4-6).

- [ ] **Step 3: Add `dispatchFork`**

Insert this method right before `dispatchLoop` (before line 293):

```ts
  private async dispatchFork(
    forkNode: ForkNode,
    runId: string,
    runState: Record<string, unknown>,
    nodeResults: Map<string, NodeResult>,
    completedNodeIds: string[],
    nodeIdempotencyKeys: Record<string, string>,
    loopState: Record<string, { iteration: number }>,
    forkState: Record<
      string,
      { branches: Record<string, { stateDelta: Record<string, unknown>; nodeResults: Record<string, unknown> }> }
    >,
    versionTracker: { version: number }
  ): Promise<{ nextNodeId: string | undefined }> {
    const forkId = forkNode.forkId;

    // Restore any branches that completed before a crash (W4): rehydrate each
    // saved nodeResults object back into a Map for the merge.
    const saved = forkState[forkId]?.branches ?? {};
    const completedBranches: Record<string, BranchExecutionResult> = {};
    for (const [branchStartId, entry] of Object.entries(saved)) {
      completedBranches[branchStartId] = {
        state: "completed",
        stateDelta: entry.stateDelta,
        nodeResults: new Map(
          Object.entries(entry.nodeResults) as [string, NodeResult][]
        ),
        // completedNodeIds inside a restored branch are already in the parent
        // completedNodeIds via the merge that recorded them; empty is safe
        // because the merge re-applies stateDelta + nodeResults, and skip-by-id
        // handles any node that also sits on the main path.
        completedNodeIds: [],
      };
    }

    await handleForkNode(
      this.forkDeps(runId),
      forkNode,
      runState,
      nodeResults,
      completedNodeIds,
      {
        completedBranches,
        onBranchComplete: async (branchStartId, result) => {
          const bucket = (forkState[forkId] ??= { branches: {} });
          bucket.branches[branchStartId] = {
            stateDelta: result.stateDelta,
            nodeResults: Object.fromEntries(result.nodeResults),
          };
          await this.saveCheckpoint(
            runId,
            runState,
            completedNodeIds,
            nodeIdempotencyKeys,
            loopState,
            forkState,
            versionTracker
          );
        },
      }
    );

    // Fork + all branches done — clear the fork cursor so resume does not treat
    // it as mid-flight, then advance through the join (mirrors the old block).
    delete forkState[forkId];
    const joinNode = findJoinNode(forkId, this.config.definition.nodes);
    if (joinNode) {
      completedNodeIds.push(joinNode.id);
      this.recordIdempotencyKey(nodeIdempotencyKeys, runId, joinNode.id);
      await this.saveCheckpoint(
        runId,
        runState,
        completedNodeIds,
        nodeIdempotencyKeys,
        loopState,
        forkState,
        versionTracker
      );
      return { nextNodeId: this.next(joinNode.id, runState) };
    }
    return { nextNodeId: undefined };
  }
```

- [ ] **Step 4: Update `forkDeps()` to take + pass `runId`**

Replace `forkDeps()` (lines 420-430) with:

```ts
  /** Build the dependency bag for fork/branch fan-out. */
  private forkDeps(runId: string) {
    return {
      config: this.config,
      nodeMap: this.nodeMap,
      outgoingEdges: this.outgoingEdges,
      emit: this.emit.bind(this),
      runId,
      findJoinNode: (forkId: string): JoinNode | undefined =>
        findJoinNode(forkId, this.config.definition.nodes),
    };
  }
```

- [ ] **Step 5: Add `forkState` param to `dispatchNode`, `dispatchLoop`, `handleSuspend`, `saveCheckpoint`**

Add a `forkState` parameter (typed as in Step 1) immediately after the `loopState` parameter in each of these signatures, and pass it through to every internal `this.saveCheckpoint(...)` / `createPipelineCheckpoint({...})` call:

- `dispatchNode` (line 251-291): add param; in its `saveCheckpoint: () => this.saveCheckpoint(...)` closure (line 281-289) pass `forkState` after `loopState`.
- `dispatchLoop` (line 293-371): add param; its two `this.saveCheckpoint(...)` calls (lines 315-322, 362-369) pass `forkState` after `loopState`.
- `handleSuspend` (line 377-414): add param; in `createPipelineCheckpoint({...})` (line 393-403) add `forkState,` after `loopState,`.
- `saveCheckpoint` (line 464-497): add param; in `createPipelineCheckpoint({...})` (line 484-493) add `forkState,` after `loopState,`.

Final `saveCheckpoint` signature:

```ts
  private async saveCheckpoint(
    runId: string,
    runState: Record<string, unknown>,
    completedNodeIds: string[],
    nodeIdempotencyKeys: Record<string, string>,
    loopState: Record<string, { iteration: number }>,
    forkState: Record<
      string,
      { branches: Record<string, { stateDelta: Record<string, unknown>; nodeResults: Record<string, unknown> }> }
    >,
    versionTracker: { version: number }
  ): Promise<void> {
```

- [ ] **Step 6: Import `BranchExecutionResult` type**

Add to the `fork-branch-executor` import (line 49) — change it to also import the resume option type and the branch result type:

```ts
import {
  handleFork as handleForkNode,
  type ForkResumeOptions,
} from "./pipeline-runtime/fork-branch-executor.js";
import type { BranchExecutionResult } from "./pipeline-runtime/branch-merge.js";
```

(`ForkResumeOptions` is imported for the closure's type-safety; if unused as a named type the linter will flag it — in that case inline-type the `onBranchComplete` closure and drop the import. Prefer keeping it only if referenced.)

- [ ] **Step 7: Typecheck agent**

Run:

```bash
yarn typecheck --filter=@dzupagent/agent
```

Expected: FAIL — the runtime (`pipeline-runtime.ts`) does not yet supply `forkState` in `ExecuteFromNodeInput`. Task 5 fixes it.

- [ ] **Step 8: Commit**

```bash
git add packages/agent/src/pipeline/pipeline-executor.ts
git commit -m "feat(pipeline): dispatchFork with durable per-branch resume (W4)

Replaces the inline fork block with dispatchFork: restores completed
branches from forkState, persists each branch via onBranchComplete (per-
branch checkpoint cadence), clears the fork cursor after the join, and
threads forkState through dispatchNode/dispatchLoop/handleSuspend/
saveCheckpoint. Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Init + restore `forkState` and re-enter mid-flight forks (runtime)

**Files:**

- Modify: `packages/agent/src/pipeline/pipeline-runtime.ts`

- [ ] **Step 1: Init `forkState` on a fresh run**

In `execute()`, after the `loopState` init (line 144), add:

```ts
const forkState: Record<
  string,
  {
    branches: Record<
      string,
      {
        stateDelta: Record<string, unknown>;
        nodeResults: Record<string, unknown>;
      }
    >;
  }
> = {};
```

And add `forkState,` to the `runFromNode({...})` call (after `loopState,` at line 161).

- [ ] **Step 2: Restore `forkState` on resume**

In `resume()`, after the `loopState` restore (line 185-187), add:

```ts
// Restore per-fork branch progress so a mid-fork crash re-runs only
// unfinished branches rather than the whole fork (W4).
const forkState: Record<
  string,
  {
    branches: Record<
      string,
      {
        stateDelta: Record<string, unknown>;
        nodeResults: Record<string, unknown>;
      }
    >;
  }
> = structuredClone(checkpoint.forkState ?? {});
```

- [ ] **Step 3: Add the mid-flight fork re-entry helper**

After `findMidFlightLoopNodeId` (line 303), add the analog. Note the property is `node.forkId` (one word) and the only condition needed is a surviving `forkState` entry — `dispatchFork` **deletes** `forkState[forkId]` once the fork+join complete, so any entry that survives into resume means that fork was mid-flight (no `completedNodeIds` check required):

```ts
  /**
   * Find a fork node that was mid-flight when the checkpoint was written: its
   * `forkState` entry survived (the fork clears it only after the join
   * completes). Returns the fork node's ID, or undefined when no fork is
   * mid-flight. Mirrors `findMidFlightLoopNodeId` (W3).
   */
  private findMidFlightForkNodeId(
    forkState: Record<string, { branches: Record<string, unknown> }>
  ): string | undefined {
    for (const node of this.config.definition.nodes) {
      if (node.type !== "fork") continue;
      if (forkState[node.forkId]) return node.id;
    }
    return undefined;
  }
```

- [ ] **Step 4: Re-enter the mid-flight fork before the suspend logic**

In `resume()`, the W3 mid-loop block is at lines 209-226. Add a parallel mid-fork block. Insert it **after** the mid-loop block (after line 226), so loop resume keeps priority (a checkpoint won't be both, but ordering is explicit):

```ts
// Mid-fork crash (W4): no suspend point, but a fork has surviving branch
// progress. Re-enter at that fork node; `dispatchFork` restores completed
// branches and re-runs only the unfinished ones. The fork node is not in
// `completedNodeIds` until the join completes, so it is not skipped.
const midFlightForkId = this.findMidFlightForkNodeId(forkState);
if (!checkpoint.suspendedAtNodeId && !midFlightLoopId && midFlightForkId) {
  const versionTracker = { version: checkpoint.version };
  return this.runFromNode({
    startNodeId: midFlightForkId,
    runId,
    runState,
    nodeResults,
    completedNodeIds,
    nodeIdempotencyKeys,
    loopState,
    forkState,
    versionTracker,
    startTime,
  });
}
```

- [ ] **Step 5: Thread `forkState` into the W3 mid-loop block + the suspend-tail `runFromNode`**

Add `forkState,` (after `loopState,`) to:

- the mid-loop `runFromNode({...})` call (lines 215-225),
- the final suspend-tail `runFromNode({...})` call (lines 274-284).

- [ ] **Step 6: Add `forkState` to the `runFromNode` arg type**

In `runFromNode`'s parameter type (line 326-336), add after `loopState`:

```ts
forkState: Record<
  string,
  {
    branches: Record<
      string,
      {
        stateDelta: Record<string, unknown>;
        nodeResults: Record<string, unknown>;
      }
    >;
  }
>;
```

(It is passed straight through to `this.executor.executeFromNode(args)` — `ExecuteFromNodeInput` already has the field from Task 4.)

- [ ] **Step 7: Typecheck agent**

Run:

```bash
yarn typecheck --filter=@dzupagent/agent
```

Expected: PASS — all `forkState` producers and consumers now line up.

- [ ] **Step 8: Lint agent**

Run:

```bash
yarn lint --filter=@dzupagent/agent
```

Expected: PASS (no unused vars; if `ForkResumeOptions` import from Task 4 Step 6 is unused, remove it now).

- [ ] **Step 9: Commit**

```bash
git add packages/agent/src/pipeline/pipeline-runtime.ts
git commit -m "feat(pipeline): init/restore forkState + mid-fork resume re-entry (W4)

execute() seeds an empty forkState; resume() restores it from the
checkpoint and, when a fork has surviving branch progress, re-enters at
that fork node so dispatchFork restores completed branches. Mirrors the
W3 mid-loop re-entry. Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Persist `fork_state` in the Postgres store

**Files:**

- Modify: `packages/agent/src/pipeline/postgres-checkpoint-store.ts`

- [ ] **Step 1: Add the row field**

In `interface CheckpointRow` (line 38-51), after `loop_state` (line 45):

```ts
fork_state: Record<
  string,
  {
    branches: Record<
      string,
      {
        stateDelta: Record<string, unknown>;
        nodeResults: Record<string, unknown>;
      }
    >;
  }
> | null;
```

- [ ] **Step 2: Add the column + migration in `setup()`**

In the `createTable` DDL (line 99-116), after the `loop_state JSONB,` line (108):

```sql
        fork_state JSONB,
```

After `addLoopStateCol` (line 121), add:

```ts
const addForkStateCol = `ALTER TABLE ${this.tableName} ADD COLUMN IF NOT EXISTS fork_state JSONB`;
```

And in the query sequence, run it **after** `addLoopStateCol` and **before** the indexes (replace lines 123-127):

```ts
await this.client.query(createTable);
await this.client.query(addIdempotencyCol);
await this.client.query(addLoopStateCol);
await this.client.query(addForkStateCol);
await this.client.query(createRunIdx);
await this.client.query(createExpiryIdx);
```

- [ ] **Step 3: Add `fork_state` to the upsert**

In `save()`'s INSERT column list (line 136-140), add `fork_state` and a new positional param `$13`:

```ts
const sql = `
      INSERT INTO ${this.tableName} (
        pipeline_run_id, pipeline_id, version, schema_version,
        completed_node_ids, state, suspended_at_node_id, budget_state,
        created_at, expires_at, node_idempotency_keys, loop_state, fork_state
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb)
      ON CONFLICT (pipeline_run_id, version) DO UPDATE SET
        pipeline_id = EXCLUDED.pipeline_id,
        schema_version = EXCLUDED.schema_version,
        completed_node_ids = EXCLUDED.completed_node_ids,
        state = EXCLUDED.state,
        suspended_at_node_id = EXCLUDED.suspended_at_node_id,
        budget_state = EXCLUDED.budget_state,
        created_at = EXCLUDED.created_at,
        expires_at = EXCLUDED.expires_at,
        node_idempotency_keys = EXCLUDED.node_idempotency_keys,
        loop_state = EXCLUDED.loop_state,
        fork_state = EXCLUDED.fork_state
    `;
```

And add the param to the values array (after the `loop_state` param at line 169):

```ts
      checkpoint.forkState ? JSON.stringify(checkpoint.forkState) : null,
```

- [ ] **Step 4: Restore `fork_state` in `rowToCheckpoint`**

After the `loop_state` restore (line 281-283):

```ts
if (row.fork_state && typeof row.fork_state === "object") {
  cp.forkState = row.fork_state;
}
```

- [ ] **Step 5: Typecheck agent**

Run:

```bash
yarn typecheck --filter=@dzupagent/agent
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/pipeline/postgres-checkpoint-store.ts
git commit -m "feat(pipeline): persist fork_state in Postgres checkpoint store (W4)

New fork_state JSONB column + ADD COLUMN IF NOT EXISTS migration, upsert
wiring, and row restore. Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Update the Postgres store setup test

**Files:**

- Modify: `packages/agent/src/__tests__/postgres-checkpoint-store.test.ts:65-99`

- [ ] **Step 1: Update the setup DDL test**

Replace the `it("issues CREATE TABLE, ...")` test body (lines 66-99) so it expects 6 calls with `fork_state` slotted after `loop_state`:

```ts
it("issues CREATE TABLE, the idempotency + loop-state + fork-state migrations, and index DDL using the configured table name", async () => {
  const { client, calls } = createMockClient([
    () => ({ rows: [] }),
    () => ({ rows: [] }),
    () => ({ rows: [] }),
    () => ({ rows: [] }),
    () => ({ rows: [] }),
    () => ({ rows: [] }),
  ]);
  const store = new PostgresPipelineCheckpointStore({
    client,
    tableName: "my_checkpoints",
  });

  await store.setup();

  expect(calls).toHaveLength(6);
  expect(calls[0]!.text).toContain("CREATE TABLE IF NOT EXISTS my_checkpoints");
  // Backward-compatible migration (W5): adds node_idempotency_keys.
  expect(calls[1]!.text).toContain(
    "ALTER TABLE my_checkpoints ADD COLUMN IF NOT EXISTS node_idempotency_keys",
  );
  // Backward-compatible migration (W3): adds loop_state.
  expect(calls[2]!.text).toContain(
    "ALTER TABLE my_checkpoints ADD COLUMN IF NOT EXISTS loop_state",
  );
  // Backward-compatible migration (W4): adds fork_state.
  expect(calls[3]!.text).toContain(
    "ALTER TABLE my_checkpoints ADD COLUMN IF NOT EXISTS fork_state",
  );
  expect(calls[4]!.text).toContain(
    "CREATE INDEX IF NOT EXISTS my_checkpoints_run_idx",
  );
  expect(calls[5]!.text).toContain(
    "CREATE INDEX IF NOT EXISTS my_checkpoints_expiry_idx",
  );
});
```

- [ ] **Step 2: Run the postgres store test**

Run:

```bash
yarn workspace @dzupagent/agent test postgres-checkpoint-store
```

(If the `yarn workspace ... test <pattern>` wrapper misbehaves, fall back to the repo-local binary: `node_modules/.bin/vitest run packages/agent/src/__tests__/postgres-checkpoint-store.test.ts`.)
Expected: PASS — including any existing save/round-trip test (those serialize `forkState: undefined` → `null`, which is unchanged behavior).

- [ ] **Step 3: Commit**

```bash
git add packages/agent/src/__tests__/postgres-checkpoint-store.test.ts
git commit -m "test(pipeline): assert fork_state DDL migration in setup (W4)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Behavior tests — durable fork/branch resume

**Files:**

- Create: `packages/agent/src/__tests__/pipeline-fork-resume.test.ts`

This is the core verification. It uses a 2-branch fork where one branch crashes, then resumes and asserts the completed branch is **not** re-run.

- [ ] **Step 1: Write the failing test file**

Create `packages/agent/src/__tests__/pipeline-fork-resume.test.ts`:

```ts
/**
 * W4 — durable fork/branch resume.
 *
 * Verifies that completed fork branches are checkpointed and, on resume after
 * a mid-fork crash, are NOT re-run — only unfinished branches re-execute — and
 * that branch node contexts carry a stable idempotency key (W5 fork gap).
 */
import { describe, it, expect } from "vitest";
import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";
import { InMemoryPipelineCheckpointStore } from "../pipeline/in-memory-checkpoint-store.js";
import type { PipelineDefinition } from "@dzupagent/core";
import type { NodeExecutor } from "../pipeline/pipeline-runtime-types.js";

/**
 * Pipeline: entry `F` (fork) fans out to two branches:
 *   branch A: a1  -> J (join)
 *   branch B: b1  -> J (join)
 * then `J` -> `done`. Each branch node writes a marker into state.
 */
function forkPipeline(): PipelineDefinition {
  return {
    id: "fork-resume",
    name: "ForkResume",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    entryNodeId: "F",
    checkpointStrategy: "after_each_node",
    nodes: [
      { id: "F", type: "fork", forkId: "fk1" },
      { id: "a1", type: "agent", agentId: "a", timeoutMs: 5000 },
      { id: "b1", type: "agent", agentId: "b", timeoutMs: 5000 },
      { id: "J", type: "join", forkId: "fk1" },
      { id: "done", type: "agent", agentId: "d", timeoutMs: 5000 },
    ],
    edges: [
      { from: "F", to: "a1" },
      { from: "F", to: "b1" },
      { from: "a1", to: "J" },
      { from: "b1", to: "J" },
      { from: "J", to: "done" },
    ],
  } as PipelineDefinition;
}

describe("durable fork/branch resume (W4)", () => {
  it("checkpoints each completed branch and exposes a branch idempotency key", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const keysSeen: Record<string, string | undefined> = {};
    const executor: NodeExecutor = async (nodeId, _node, ctx) => {
      keysSeen[nodeId] = ctx.idempotencyKey;
      ctx.state[`ran_${nodeId}`] = true;
      return { nodeId, output: nodeId, durationMs: 1 };
    };

    const runtime = new PipelineRuntime({
      definition: forkPipeline(),
      nodeExecutor: executor,
      checkpointStore: store,
    });

    const result = await runtime.execute();
    expect(result.state).toBe("completed");

    // Branch nodes received a stable `<runId>:<nodeId>` key (W5 fork gap closed).
    expect(keysSeen["a1"]).toBe(`${result.runId}:a1`);
    expect(keysSeen["b1"]).toBe(`${result.runId}:b1`);

    // forkState cleared once the fork+join completed.
    const finalCheckpoint = await store.load(result.runId);
    expect(finalCheckpoint?.forkState?.["fk1"]).toBeUndefined();
  });

  it("resumes a mid-fork crash without re-running the completed branch", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const firstRuns: string[] = [];

    // Branch a1 completes; branch b1 crashes. Force a deterministic order by
    // making b1 throw. (Both branches start from the cloned base state.)
    const crashingExecutor: NodeExecutor = async (nodeId, _node, ctx) => {
      firstRuns.push(nodeId);
      if (nodeId === "b1") throw new Error("simulated crash in branch b1");
      ctx.state[`ran_${nodeId}`] = true;
      return { nodeId, output: nodeId, durationMs: 1 };
    };

    const first = new PipelineRuntime({
      definition: forkPipeline(),
      nodeExecutor: crashingExecutor,
      checkpointStore: store,
    });

    const firstResult = await first.execute();
    // The fork itself does not throw (branches settle independently); but the
    // join->done path never runs because b1 failed and was not merged. The run
    // completes with a1 merged and b1 absent from forkState.
    const checkpoint = await store.load(firstResult.runId);
    expect(firstRuns).toContain("a1");
    expect(firstRuns).toContain("b1");
    // a1 was recorded as a completed branch; b1 (failed) was not.
    expect(checkpoint?.forkState?.["fk1"]?.branches?.["a1"]).toBeDefined();
    expect(checkpoint?.forkState?.["fk1"]?.branches?.["b1"]).toBeUndefined();

    // Resume with a healthy executor; a1 must NOT re-run, b1 must.
    const resumeRuns: string[] = [];
    const healthyExecutor: NodeExecutor = async (nodeId, _node, ctx) => {
      resumeRuns.push(nodeId);
      ctx.state[`ran_${nodeId}`] = true;
      return { nodeId, output: nodeId, durationMs: 1 };
    };

    const second = new PipelineRuntime({
      definition: forkPipeline(),
      nodeExecutor: healthyExecutor,
      checkpointStore: store,
    });

    const resumed = await second.resume(checkpoint!);
    expect(resumed.state).toBe("completed");

    // a1 restored (not re-run); b1 re-ran; merged state has both branches.
    expect(resumeRuns).not.toContain("a1");
    expect(resumeRuns).toContain("b1");
    expect(resumed.nodeResults.has("a1")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test — expect it to pass (wiring already in place from Tasks 1-6)**

Run:

```bash
yarn workspace @dzupagent/agent test pipeline-fork-resume
```

(Fallback: `node_modules/.bin/vitest run packages/agent/src/__tests__/pipeline-fork-resume.test.ts`.)
Expected: PASS.

> **If the second test's assumptions about fork-failure flow don't hold** (e.g. a failed branch causes the whole `dispatchFork` to advance differently, or `firstResult.state` is `completed` because the join still fired): treat this as a real finding, not a test bug. Use `superpowers:systematic-debugging`: add a temporary `console.log` of `checkpoint?.forkState` and the run state after `first.execute()`, confirm the actual fork-on-partial-failure semantics in `fork-branch-executor.ts:90-106`, and adjust the test's _expectations_ to match verified behavior (the design guarantee is only: completed branches are not re-run, failed branches re-run). Do not weaken the core assertion `resumeRuns.not.toContain("a1")`.

- [ ] **Step 3: Commit**

```bash
git add packages/agent/src/__tests__/pipeline-fork-resume.test.ts
git commit -m "test(pipeline): durable fork/branch resume behavior (W4)

Completed branch is checkpointed and not re-run on resume; failed branch
re-runs; branch nodes carry a stable idempotency key. Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Full verification gate

- [ ] **Step 1: Package-scoped gates**

Run (from `dzupagent/`):

```bash
yarn typecheck --filter=@dzupagent/core --filter=@dzupagent/agent
yarn lint --filter=@dzupagent/core --filter=@dzupagent/agent
yarn test --filter=@dzupagent/core --filter=@dzupagent/agent
```

Expected: all PASS. The full agent suite should be **4190 + the new fork-resume tests**, with no regressions. (Pre-existing unrelated reds — dts-budgets agent, ~40 server suites — are out of scope and may remain red; confirm the count of _new_ failures is zero.)

- [ ] **Step 2: Cross-boundary verify**

Run:

```bash
yarn verify
```

Expected: PASS (build + typecheck + lint + test + circular-deps across core↔agent).

> If `yarn verify` is too slow or flaky in this environment, the package-scoped gates in Step 1 plus `yarn check:circular-deps` are an acceptable substitute — note in the final report which gate you ran.

- [ ] **Step 3: Confirm the concurrent session's files were never touched**

Run:

```bash
git status --short
git log --oneline -9
```

Expected: the `packages/subagents/` + `packages/agent-adapters/` modifications are still **unstaged/modified** (untouched by us); the 8 W4 commits (Tasks 1-8) sit on top of the spec commit. No W4 commit should include any subagents/agent-adapters file.

---

## Self-Review (completed during planning)

- **Spec coverage:** §3.1 → Task 1; §3.2 → Task 3; §3.3 → Tasks 4-5; §3.4 → Tasks 6-7; §6 tests → Task 8; §7 gates → Task 9. All spec sections mapped.
- **Type consistency:** `forkState` uses the identical inline type `Record<string, { branches: Record<string, { stateDelta: Record<string, unknown>; nodeResults: Record<string, unknown> }> }>` in core, helper, executor, runtime, and postgres row. `onBranchComplete`/`completedBranches` names match between `ForkResumeOptions` (Task 3) and `dispatchFork` (Task 4). `findMidFlightForkNodeId` single corrected signature (Task 5 Step 3).
- **Placeholder scan:** no TBD/TODO; every code step shows full code; the one conditional ("if `ForkResumeOptions` import unused, remove it") is an explicit lint instruction, not a placeholder.
- **Known risk flagged:** Task 8 Step 2 documents the fork-on-partial-failure uncertainty and routes it to systematic-debugging with a non-negotiable core assertion, rather than guessing.
