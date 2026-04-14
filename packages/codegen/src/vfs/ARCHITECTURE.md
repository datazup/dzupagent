# VFS Module Architecture (`packages/codegen/src/vfs`)

This document describes the current `src/vfs` implementation as of **April 4, 2026**.

## 1. Purpose

The `vfs` module is the state-management and workspace-execution backbone for `@dzupagent/codegen`.

It provides:

1. In-memory source state (`VirtualFS`).
2. Low-overhead branching for speculative generation (`CopyOnWriteVFS`).
3. Parallel candidate generation + winner commit (`parallel-sampling`).
4. Unified-diff parsing and patch application (`patch-engine`).
5. Workspace abstraction across in-memory and disk backends (`workspace-fs`).
6. Sandbox execution bridge (`WorkspaceRunner`).
7. Optional persistence and rollback boundaries (`vfs-snapshot`, `checkpoint-manager`).

Design objective: keep generated code mutable, testable, and reversible without coupling every caller to one storage or execution backend.

## 2. Module Map

| File | Primary responsibility |
|---|---|
| `virtual-fs.ts` | Basic in-memory file map, snapshot, diff, merge |
| `vfs-types.ts` | Shared CoW/merge/sampling types |
| `cow-vfs.ts` | Copy-on-write fork with merge/conflict logic |
| `parallel-sampling.ts` | Run N isolated forks, score results, commit winner |
| `patch-engine.ts` | Parse/apply unified diffs, per-hunk outcomes, rollback support |
| `workspace-fs.ts` | Common FS interface + in-memory/disk/worktree adapters |
| `workspace-runner.ts` | Upload VFS snapshot to sandbox, execute command, sync back |
| `vfs-snapshot.ts` | Non-fatal save/load helpers for external snapshot stores |
| `checkpoint-manager.ts` | Git-backed shadow checkpoints for rollback of real directories |

## 3. Core Data Model

### 3.1 `VirtualFS` is the canonical state container

`VirtualFS` stores `Map<string, string>` from relative path to file content and exposes:

1. `write`, `read`, `exists`, `delete`, `list`.
2. `size` getter.
3. `toSnapshot()` and `fromSnapshot()`.
4. `diff(other)` and `merge(other)`.

Important semantic detail:

1. `diff(other)` is directional: it returns changes needed to transform `this` into `other`.
2. `merge(other)` is last-write-wins for keys present in `other`.

### 3.2 CoW state model (`CopyOnWriteVFS`)

A fork stores:

1. `overlay: Map<string, string>` for writes in that fork.
2. `deletedPaths: Set<string>` to mask parent reads.
3. `baseSnapshot: Map<string, string>` captured at fork creation for conflict detection.

Reads fall through parent chain unless path is overridden or masked.

### 3.3 Patch model

`patch-engine` models diffs as:

1. `FilePatch` (old/new path + hunks).
2. `PatchHunk` (old/new ranges + typed lines).
3. `PatchApplyResult` and per-hunk `HunkResult` with error codes:
   `E_PARSE`, `E_CONTEXT_MISMATCH`, `E_FILE_NOT_FOUND`, `E_HUNK_CONFLICT`, `E_ALREADY_APPLIED`.

### 3.4 Workspace abstraction model

`WorkspaceFS` unifies I/O behavior:

1. `read`, `write`, `delete`, `list`, `snapshot`.
2. `applyPatch(unifiedDiff, opts?)`.

Implementations:

1. `InMemoryWorkspaceFS` wraps `VirtualFS`.
2. `DiskWorkspaceFS` constrains all paths to a root directory.
3. `GitWorktreeWorkspaceFS` delegates to `DiskWorkspaceFS` rooted at a worktree path.

## 4. End-to-End Flows

### 4.1 In-memory generation/edit flow

```text
generation node/tool
    -> VirtualFS.write/read/list
    -> optional validateImports(vfs)
    -> optional snapshot (toSnapshot)
    -> pass snapshot to evaluator/scorer/pipeline phases
```

Used by tools and validators that operate without touching disk.

### 4.2 Parallel sampling flow

```text
VirtualFS root
    -> sample(count, fn):
         create N CopyOnWriteVFS forks
         run fn(fork, i) in parallel
         collect result/error/duration
    -> selectBest(results, scorer)
    -> commitBest(winner, forks)  // merge winner fork with 'theirs'
```

This enables speculative generation while keeping parent state stable until winner selection.

### 4.3 Patch application flow

```text
unified diff string
    -> parseUnifiedDiff() => FilePatch[]
    -> applyPatchSet(patches, readFile, writeFile, { rollbackOnFailure? })
         per-file read
         per-hunk apply with exact + fuzz matching
         optional transaction-style rollback
```

`workspace-fs` reuses this flow identically for in-memory and disk backends.

### 4.4 Sandbox execution flow (`WorkspaceRunner`)

```text
VirtualFS
    -> toSnapshot()
    -> sandbox.uploadFiles(snapshot)
    -> sandbox.execute(command, { cwd, timeoutMs })
    -> if syncBack:
         sandbox.downloadFiles(pathsToCheck)
         write changed content back into VirtualFS
```

`WorkspaceRunner` returns execution metadata (`success`, `exitCode`, `stdout`, `stderr`, `timedOut`, `durationMs`, optional `modifiedFiles`).

### 4.5 Checkpoint/restore flow (`CheckpointManager`)

```text
ensureCheckpoint(workDir, reason)
    -> per-turn dedup + safety checks
    -> shadow repo init (GIT_DIR/GIT_WORK_TREE)
    -> git add -A (with excludes)
    -> commit if staged changes exist
    -> optional prune

restore(workDir, checkpointHash)
    -> create pre-rollback snapshot
    -> git checkout checkpointHash -- .
```

Purpose: rollback safety for disk mutations without adding git metadata to user workspace.

## 5. Feature Catalog

### 5.1 `virtual-fs.ts`

1. Sorted listing and prefix filtering.
2. Directional diff (`added/modified/deleted`) with old/new content.
3. Snapshot export/import for serialization boundaries.
4. Simple merge primitive for integrating another VFS.

### 5.2 `cow-vfs.ts`

1. Cheap forking with read-through and isolated overlays.
2. Delete masking without mutating parent.
3. Diff views (`diff()` structured, `forkDelta()` flat).
4. Conflict detection between forks.
5. Merge strategies:
   `theirs` (fork wins), `ours` (parent wins), `manual` (collect conflicts).
6. Depth guard (`MAX_FORK_DEPTH = 3`) to prevent unbounded nesting.
7. `detach()` to materialize a standalone `VirtualFS`.

### 5.3 `parallel-sampling.ts`

1. Bounded sample count (1..10).
2. Error capture per fork (does not fail whole batch).
3. Duration telemetry per sample.
4. Winner selection utility and one-call orchestrator (`sampleAndCommitBest`).

### 5.4 `patch-engine.ts`

1. Unified-diff parsing with support for:
   multi-file, multi-hunk, add-only/remove-only hunks, single-count headers.
2. Hunk application:
   exact match first, then fuzz search (`MAX_FUZZ = 3`).
3. Idempotency detection (`E_ALREADY_APPLIED`).
4. Patch-set apply with optional rollback.
5. Generic read/write callbacks make it storage-agnostic.

### 5.5 `workspace-fs.ts`

1. Backend-neutral `WorkspaceFS` interface.
2. In-memory adapter for fast, isolated operations.
3. Disk adapter with root confinement and path-traversal protection.
4. Patch application exposed uniformly across backends.
5. Worktree adapter for branch-isolated filesystem operations.

### 5.6 `workspace-runner.ts`

1. Converts VFS state into sandbox filesystem inputs.
2. Supports command timeout, cwd, and optional selective sync-back.
3. Captures and normalizes sandbox execution failures.
4. Provides availability and cleanup delegation helpers.

### 5.7 `vfs-snapshot.ts`

1. Minimal store contract (`save`/`load`) for external persistence.
2. Non-throwing typed results for reliability in pipeline flows.

### 5.8 `checkpoint-manager.ts`

1. Shadow-git snapshots keyed by hashed absolute directory path.
2. Per-turn dedup (`newTurn()` resets dedup state).
3. Safety skips for `/` and `$HOME`.
4. Diff and list helpers for checkpoint introspection.
5. Best-effort pruning and restore workflows.

## 6. Usage Examples

### 6.1 Basic `VirtualFS` lifecycle

```ts
import { VirtualFS } from '@dzupagent/codegen'

const vfs = new VirtualFS({ 'src/index.ts': 'export const x = 1' })
vfs.write('src/util.ts', 'export const add = (a: number, b: number) => a + b')

const before = vfs.toSnapshot()
vfs.write('src/index.ts', 'export const x = 2')

const changed = VirtualFS.fromSnapshot(before).diff(vfs)
// changed -> [{ path: 'src/index.ts', type: 'modified', ... }]
```

### 6.2 Parallel candidate generation + commit best

```ts
import { VirtualFS, sampleAndCommitBest } from '@dzupagent/codegen'

const root = new VirtualFS({ 'src/index.ts': 'export const quality = 0' })

const outcome = await sampleAndCommitBest(
  root,
  3,
  async (fork, i) => {
    const score = (i + 1) * 10
    fork.write('src/index.ts', `export const quality = ${score}`)
    return { score }
  },
  (r) => r.score,
)

if (outcome) {
  // root now contains winning fork content
  console.log(outcome.winner.result.score)
}
```

### 6.3 Apply a unified diff in memory

```ts
import { VirtualFS, InMemoryWorkspaceFS } from '@dzupagent/codegen'

const vfs = new VirtualFS({ 'hello.txt': 'line1\nline2\nline3\n' })
const ws = new InMemoryWorkspaceFS(vfs)

const patch = [
  '--- a/hello.txt',
  '+++ b/hello.txt',
  '@@ -1,3 +1,3 @@',
  ' line1',
  '-line2',
  '+line2_modified',
  ' line3',
].join('\n')

const result = await ws.applyPatch(patch, { rollbackOnFailure: true })
console.log(result.results[0]?.success) // true
```

### 6.4 Execute tests/build inside sandbox from VFS snapshot

```ts
import { VirtualFS, WorkspaceRunner, MockSandbox } from '@dzupagent/codegen'

const vfs = new VirtualFS({ 'src/index.ts': 'export const x = 1' })
const runner = new WorkspaceRunner(new MockSandbox())

const run = await runner.run(vfs, {
  command: 'npm test',
  timeoutMs: 60_000,
  syncBack: true,
  syncPaths: ['src/index.ts'],
})

console.log(run.success, run.modifiedFiles)
```

### 6.5 Checkpoint a real workspace before mutation

```ts
import { CheckpointManager } from '@dzupagent/codegen'

const checkpoints = new CheckpointManager({ baseDir: '/tmp/dzip-checkpoints' })
const cp = await checkpoints.ensureCheckpoint('/repo', 'before risky refactor')

if (cp.status === 'created') {
  // ... mutate files ...
  await checkpoints.restore('/repo', cp.checkpointId)
}
```

## 7. Common Use Cases

1. **LLM code editing loop**:
   keep all edits in `VirtualFS`, run validators/scorers, persist only after quality checks pass.
2. **Speculative generation**:
   fork with `CopyOnWriteVFS`, test multiple variants, merge only the best candidate.
3. **Safe patch ingestion**:
   parse/apply LLM-generated unified diffs with per-hunk diagnostics and optional rollback.
4. **Sandboxed verification**:
   upload VFS snapshot to sandbox, run lint/test/build, sync selected files back.
5. **Disk rollback guarantees**:
   create checkpoints before file-mutating operations on real repositories.

## 8. Reference Map In Repository

### 8.1 Direct usage inside `packages/codegen`

1. `tools/edit-file.tool.ts` and `tools/multi-edit.tool.ts` mutate `VirtualFS`.
2. `validation/import-validator.ts` traverses `VirtualFS` to validate relative imports.
3. `workspace-fs.ts` composes `parseUnifiedDiff` + `applyPatchSet`.
4. `parallel-sampling.ts` composes `CopyOnWriteVFS`.
5. Package root (`src/index.ts`) exports full VFS surface for external consumers.

### 8.2 Usage from other packages

1. No direct imports of `src/vfs/*` classes/functions were found outside `packages/codegen`.
2. `packages/create-dzupagent/src/templates/codegen.ts` references VFS capability in generated config (`codegen.vfs: true`) and includes `@dzupagent/codegen` dependency.
3. `packages/server/src/runtime/tool-resolver.ts` dynamically imports `@dzupagent/codegen` for git tools (`GitExecutor`/`createGitTools`), not currently for VFS APIs.

## 9. Test Coverage (Static Suite Analysis)

This section is based on static inspection of current Vitest suites (not runtime coverage percentage instrumentation).

### 9.1 Dedicated suites

| Suite | Approx. `it(...)` cases | Coverage focus |
|---|---:|---|
| `vfs.test.ts` | 35 | `VirtualFS` CRUD/list/snapshot/diff/merge + snapshot helper basics |
| `vfs-snapshot.test.ts` | 7 | `saveSnapshot`/`loadSnapshot` success and non-fatal failures |
| `vfs/cow-vfs.test.ts` | 53 | CoW behavior, merge/conflicts, detach, and parallel-sampling helpers |
| `vfs/cow-vfs-extended.test.ts` | 35 | Multi-level forks, depth limits, merge/conflict edge cases |
| `patch-engine.test.ts` | 25 | diff parsing, hunk application, fuzzy match, rollback behavior |
| `workspace-fs.test.ts` | 19 | in-memory/disk adapters, patch apply, path traversal guard |
| `workspace-runner.test.ts` | 17 | upload/execute/syncBack/error handling/delegation |
| `checkpoint-manager.test.ts` | 20 | skip/dedup/create/list/diff/restore logic and failure modes |

Total dedicated VFS-related tests in these suites: **211**.

### 9.2 Additional integration coverage

`incremental-gen-and-test-generator.test.ts` also includes a `parallel-sampling` block (sample/select/commit behavior and isolation), providing additional cross-module confidence beyond dedicated `vfs` test files.

### 9.3 Coverage strengths

1. CoW semantics are extensively tested (including deep fork chains and manual conflict mode).
2. Patch engine has strong parser + apply-path coverage, including rollback and idempotency behavior.
3. Workspace runner behavior is validated for sync/no-sync/default timeout/error handling.
4. Checkpoint manager is tested across success/failure/guardrail scenarios with mocked git/fs.

### 9.4 Notable gaps and risks

1. `GitWorktreeWorkspaceFS` has no dedicated behavior tests (only implicit delegation to `DiskWorkspaceFS` by implementation).
2. `PatchOptions.bestEffort` exists in `workspace-fs.ts` type surface but is currently unused in implementation and untested.
3. `CheckpointManager` tests are mock-heavy; no integration test currently validates real git CLI behavior end-to-end.
4. `WorkspaceRunner.syncBack` defaults to original snapshot keys; newly created sandbox files are not synced unless explicitly included in `syncPaths`.
5. Patch rollback currently restores written files to remembered string content; scenarios involving new file creation + rollback-to-delete semantics are not explicitly tested.

## 10. Design Tradeoffs

1. **Simplicity over full POSIX fidelity**:
   `VirtualFS` is a flat map by path string, which is fast and predictable but intentionally omits directory metadata, permissions, and symlink semantics.
2. **Low-cost speculative branching**:
   CoW overlay model is memory efficient for sparse edits, but merge logic is textual and does not perform AST-aware reconciliation.
3. **Patch robustness via fuzzing**:
   `MAX_FUZZ = 3` improves apply resilience, but can still fail when context drift is larger or ambiguous.
4. **Non-fatal API design**:
   snapshot and checkpoint helpers return typed failures instead of throwing, improving pipeline survivability but requiring callers to handle result states carefully.
5. **Security posture in disk backend**:
   path traversal checks are centralized in `DiskWorkspaceFS.resolveSafe`, reducing accidental escape risk.

## 11. Quick API Checklist

Use `VirtualFS` when:

1. You need fast, in-memory generation/edit cycles.

Use `CopyOnWriteVFS` + `sampleAndCommitBest` when:

1. You need parallel candidate exploration with isolated side effects.

Use `WorkspaceFS` adapters when:

1. You need backend-neutral patch/read/write workflows.

Use `WorkspaceRunner` when:

1. You need to execute commands in sandbox against VFS state.

Use `CheckpointManager` when:

1. You are mutating real filesystem state and need rollback safety.
