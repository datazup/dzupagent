# W4 — Durable Fork/Branch Resume (Design)

**Date:** 2026-06-03
**Status:** Approved design — ready for implementation plan
**Track:** Orchestration runtime hardening (Tier 1, last item)
**Roadmap:** `out/orchestration-reeval-and-improvement-roadmap-2026-06-02.md` §2.2 W4, §3 Tier 1
**Branch:** `harden/mcp-stdio-arg-policy` (in `dzupagent/`)
**Precedent:** W3 durable loop resume (`4084a4d5`), W5 idempotency keys (`09f0f2da`)

---

## 1. Problem

When a pipeline crashes mid-fork, **every parallel branch re-executes from its start** on
resume. Branch work — often expensive LLM calls — is thrown away.

**Verified root cause** (read in code, not assumed):

- `fork-branch-executor.ts:90` — branch results surface only at the `Promise.allSettled`
  join. Nothing about per-branch progress is persisted before the join completes.
- `pipeline-executor.ts:175-203` — the fork node is pushed to `completedNodeIds` only
  **after** the join finishes. A crash mid-fork leaves the fork node _not_ completed, so on
  resume the parent re-enters the fork node fresh (`executeFromNode` skip-check at line 151
  never matches it) and re-runs all branches.
- Branch `NodeExecutionContext` (`fork-branch-executor.ts:135-139`) carries **no `runId`
  and no `idempotencyKey`** — confirming both the W4 prerequisite _and_ the W5
  fork-context gap noted in the roadmap (§3 item 2 scope note).

## 2. Goal & non-goals

**Goal:** On resume after a mid-fork crash, skip branches that fully completed (restoring
their merged effect) and re-run only unfinished branches. Re-execution on crash is bounded
to **at most one partial branch's nodes**.

**Non-goals (explicitly deferred):**

- **Per-node-within-branch durability** (zero re-execution / true distributed-saga
  semantics). Branches run on _cloned_ state and merge only at the join; per-node branch
  checkpoints would require partial-merge replay and branch-local `completedNodeIds`
  threading. That deeper work stays deferred. This design delivers the high-leverage 90%
  at ~W3 effort and risk.
- Aborting sibling branches when one fails (that is W1's domain and is already addressed at
  the shared concurrency-runner; fork uses `Promise.allSettled` by design — failed
  branches do not abort siblings).

## 3. Approach — mirror W3's loop-cursor pattern at _branch_ granularity

A new **optional** checkpoint field `forkState`, threaded exactly the way `loopState`
(W3) and `nodeIdempotencyKeys` (W5) are, with an **incremental per-branch checkpoint
callback**. This is the proven W3 shape, not a new mechanism. Two design decisions
(confirmed during brainstorming):

1. **Granularity = per-branch.** Track which branches fully completed; skip those, re-run
   the rest.
2. **Merge replay = persist per-branch deltas.** Because completed branches' state deltas
   are merged into `runState` only at join time (which never happened on crash), each
   completed branch's `stateDelta` + `nodeResults` are persisted into `forkState` **as that
   branch finishes**, and restored on resume so the final deterministic merge is correct.

### 3.1 Checkpoint shape — `core/src/pipeline/pipeline-checkpoint-store.ts`

New optional field on `PipelineCheckpoint`, backward-compatible like `loopState`:

```ts
/**
 * Per-fork branch progress for durable fork/branch resume (W4).
 *
 * Maps a fork node's `forkId` to the set of branches that have fully
 * completed, each with the state delta and node results it produced. On
 * resume, completed branches are restored from here (not re-run) and only
 * unfinished branches re-execute; the final merge combines restored +
 * freshly-run results in deterministic outgoing-edge order. An entry is
 * removed once the fork's join completes. Optional for backward
 * compatibility; absence means "no fork is mid-flight".
 */
forkState?: Record<string, {
  branches: Record<string /* branchStartId */, {
    stateDelta: Record<string, unknown>;
    /** JSON-serialized NodeResult map: nodeId -> { nodeId, output, durationMs, error? } */
    nodeResults: Record<string, unknown>;
  }>;
}>;
```

**Boundary note (verified):** `pipeline-checkpoint-store.ts` in `@dzupagent/core`
deliberately imports **no** `NodeResult` type (it uses only `Record<string, unknown>`;
`NodeResult` lives in `@dzupagent/runtime-contracts`). W4 honors this: the checkpoint types
`nodeResults` as `Record<string, unknown>`, and the agent-side executor casts on restore —
exactly how `state` already crosses this boundary. `NodeResult` is fully JSON-serializable
(`nodeId`, `output`, `durationMs`, `error?`), so the `Map`↔object conversion is lossless.

### 3.2 `fork-branch-executor.ts`

Three changes:

1. **`runId` added to `ForkBranchExecutorDeps`.** The branch `NodeExecutionContext` gains
   `idempotencyKey: nodeIdempotencyKey(runId, node.id)` — **closing the W5 fork-context
   gap** as a direct side-benefit (roadmap §3 item 2 scope note).

2. **New optional `ForkResumeOptions` param** to `handleFork`, mirroring
   `LoopResumeOptions`:

   ```ts
   export interface ForkResumeOptions {
     /** branchStartId -> already-completed branch result (restored, not re-run). */
     completedBranches: Record<string, BranchExecutionResult>;
     /** Called after each branch completes successfully, before the join merge. */
     onBranchComplete: (
       branchStartId: string,
       result: BranchExecutionResult,
     ) => Promise<void>;
   }
   ```

3. **`handleFork` resume logic:**
   - For each `branchStartId`: if present in `completedBranches`, **restore** its
     `BranchExecutionResult` (rehydrate `nodeResults` object → `Map`) instead of calling
     `executeBranch`.
   - Otherwise run `executeBranch` as today; on success, `await onBranchComplete(startId,
result)` before the branch promise resolves.
   - The final deterministic merge over `settled` (edge order, `branch-merge.ts`) is
     **unchanged** — it now merges a mix of restored and freshly-run results identically.

### 3.3 `pipeline-executor.ts` — new `dispatchFork` (mirrors `dispatchLoop`)

Replace the inline fork block (lines 175-203) with a `dispatchFork` method that mirrors
`dispatchLoop` (lines 293-371):

- Read `forkState[forkId]?.branches` → build `completedBranches` (rehydrating
  `nodeResults` objects to `Map`s).
- Provide `onBranchComplete(branchStartId, result)` that:
  - writes `{ stateDelta, nodeResults: mapToObject(result.nodeResults) }` into
    `forkState[forkId].branches[branchStartId]`, then
  - `await this.saveCheckpoint(...)`. **Checkpoint cadence becomes after each branch**, not
    only at join.
- After the join completes: `delete forkState[forkId]` (same lifecycle as `loopState`
  being deleted when a loop finishes, executor line 358), then push the join node to
  `completedNodeIds`, record its idempotency key, and run the existing join checkpoint.

**Plumbing (identical to what W3 added for `loopState`):** thread `forkState` through
`ExecuteFromNodeInput`, `handleSuspend(...)`, and `saveCheckpoint(...)` signatures, and
include it in every `createPipelineCheckpoint({...})` call.

`forkId` source: the fork block already computes `(node as ForkNode).forkId` to find the
join (executor line 183-184); `dispatchFork` reuses it as the `forkState` key.

### 3.4 Postgres store — `agent/src/pipeline/postgres-checkpoint-store.ts`

- New `fork_state JSONB` column + backward-compatible `ADD COLUMN IF NOT EXISTS` migration
  (identical treatment to W3's `loop_state` and W5's `node_idempotency_keys`).
- `save()` writes `JSON.stringify(forkState ?? {})`; `load()` parses it back.
- In-memory and Redis stores round-trip the whole checkpoint object already — **no change**.
- The store's `setup()` DDL test (`postgres-checkpoint-store.test.ts:65-99`) asserts
  `calls` `toHaveLength(5)` in a fixed order: CREATE TABLE → `node_idempotency_keys`
  migration → `loop_state` migration → run index → expiry index. W4 inserts the
  `fork_state` ALTER **after `loop_state`, before the indexes**, so: bump to
  `toHaveLength(6)`, add a 6th `() => ({ rows: [] })` to the mock client, add a
  `calls[3]` assertion for `ADD COLUMN IF NOT EXISTS fork_state`, and shift the two index
  assertions to `calls[4]`/`calls[5]`. The `CREATE TABLE` body (line ~107) also gains a
  `fork_state JSONB` column, and the INSERT/`ON CONFLICT` upsert (lines ~139-152) gains
  `fork_state` to its column list and `EXCLUDED` set.

## 4. Failed-branch semantics (preserved)

A failed branch today emits `node_failed`, does **not** abort siblings, and is **not**
merged (`fork-branch-executor.ts:99-105`). Under W4 a failed branch is simply **never
recorded** in `forkState` (no `onBranchComplete` call for it), so on resume it **re-runs** —
which matches current "failed branches don't persist" behavior. No change to failure
handling.

## 5. Concurrency correctness of the per-branch checkpoint callback

Branches run concurrently; each `onBranchComplete` does a **synchronous** object write into
`forkState` _before_ its first `await`, so the shared `forkState` object is never corrupted
by interleaving (Node is single-threaded). Checkpoint version numbers come from the single
`versionTracker` increment inside `saveCheckpoint` — the same single source of truth W3's
`onIterationComplete` already relies on. As with W3, concurrent saves serialize through that
one counter; each save reflects a monotonically increasing version. No new locking needed.

## 6. Testing — new `agent/src/__tests__/pipeline-fork-resume.test.ts`

Mirror `pipeline-loop-resume.test.ts`. Assertions:

1. **Per-branch checkpoint cadence** — a checkpoint is written after each branch completes
   (not only at join).
2. **Mid-fork crash resumes correctly** — given branches b1,b2 done and b3 mid-flight at
   crash: on resume the node executor is **not** called for b1/b2's nodes, **only** b3's
   nodes re-run, and the final merged `runState` equals the no-crash result.
3. **`forkState` cleared after join** — a completed fork leaves no `forkState[forkId]`
   entry (so resume does not treat it as mid-flight).
4. **Failed branch re-runs on resume** — a branch that errored before the crash is not in
   `forkState` and re-executes.
5. **Branch contexts receive `idempotencyKey`** — asserts the W5 fork-context gap is closed
   (`<runId>:<nodeId>` reaches branch nodes).
6. **Suspend/resume round-trip carries `forkState`** — suspend mid-fork, reload checkpoint,
   resume, verify completed branches are not re-run.

## 7. Quality gates

Package-scoped first, then cross-boundary:

```bash
# from dzupagent/
yarn typecheck --filter=@dzupagent/core --filter=@dzupagent/agent
yarn lint      --filter=@dzupagent/core --filter=@dzupagent/agent
yarn test      --filter=@dzupagent/core --filter=@dzupagent/agent
yarn verify    # crosses core <-> agent (build/typecheck/lint/test + circular-deps)
```

Baseline to preserve: **full agent suite 4190/4190** (post-W3). Pre-existing unrelated reds
(dts-budgets agent, ~40 server suites) are out of scope.

## 8. Scope honesty

- **Delivers:** per-branch durable resume — re-runs at most one partial branch's nodes;
  closes the W5 fork-context idempotency gap.
- **Does not deliver:** per-node-within-branch resume (zero re-execution). That distributed-
  saga-class work remains deferred (roadmap §3 W4 deferral note).
- **Files touched (estimate):** `pipeline-checkpoint-store.ts` (core, +1 field),
  `fork-branch-executor.ts` (deps + resume options + restore logic),
  `pipeline-executor.ts` (`dispatchFork` + `forkState` plumbing through 3 signatures),
  `postgres-checkpoint-store.ts` (+1 column/migration/setup-test bump), plus the new test
  file. No public-API surface change beyond the optional checkpoint field.
