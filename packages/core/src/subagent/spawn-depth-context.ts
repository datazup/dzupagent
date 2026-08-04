/**
 * Ambient sub-agent spawn-depth context (DZUPAGENT-AGENT-C-04).
 *
 * `SubAgentConfig._depth` was previously *read* by `SubAgentSpawner.spawnReAct`
 * but never *written* by any code path: the spawner does not construct child
 * configs — a sub-agent recurses by being handed a tool that calls back into
 * the spawner with a caller-supplied config. Unless that caller manually
 * threaded `_depth`, the recursion cap was dead code.
 *
 * Rather than depending on every tool author to thread the field correctly,
 * depth is carried ambiently through the async call graph with
 * `AsyncLocalStorage`. `spawnReAct` runs its whole loop — model turns and tool
 * invocations alike — inside `runAtSpawnDepth(depth + 1, ...)`, so a nested
 * spawn triggered from a tool observes its true depth with no cooperation from
 * the tool.
 *
 * Precedence: an explicit `config._depth` still wins (backwards compatible, and
 * lets a caller pin depth across a process/queue boundary where the async
 * context does not survive). Otherwise the ambient depth is used.
 *
 * Mirrors the local-copy rationale of `logging/correlation-context.ts`: a
 * dependency-root-safe AsyncLocalStorage with no external dependencies.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const depthStore = new AsyncLocalStorage<number>();

/**
 * Depth of the sub-agent currently executing, or `0` when no sub-agent is on
 * the stack (i.e. the next spawn is a top-level one).
 */
export function currentSpawnDepth(): number {
  return depthStore.getStore() ?? 0;
}

/** Run `fn` with the ambient spawn depth set to `depth`. */
export function runAtSpawnDepth<T>(depth: number, fn: () => T): T {
  return depthStore.run(depth, fn);
}

/**
 * Resolve the depth a spawn should execute at: explicit `_depth` when the
 * caller pinned one, otherwise the ambient depth.
 */
export function resolveSpawnDepth(explicitDepth: number | undefined): number {
  return typeof explicitDepth === "number" && Number.isFinite(explicitDepth)
    ? explicitDepth
    : currentSpawnDepth();
}
