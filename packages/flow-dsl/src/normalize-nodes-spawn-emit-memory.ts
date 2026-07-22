/**
 * DSL normalization for the `spawn`, `emit`, `memory`, and remaining leaf
 * action nodes (http/wait/subflow/prompt/return_to).
 *
 * Thin composition root. The implementation is split into per-kind leaf
 * modules under `normalize-nodes-spawn-emit-memory/` (DZUPAGENT-ARCH-M-06):
 *
 * - `spawn.ts` — the `spawn` node normalizer + allowed keys
 * - `emit.ts` — the `emit` node normalizer + allowed keys
 * - `memory.ts` — the `memory` node normalizer + allowed keys
 * - `misc-nodes.ts` — the http/wait/subflow/prompt/return_to normalizers
 *
 * Public surface (`normalizeSpawn`, `normalizeEmit`, `normalizeMemory`,
 * `normalizeHttp`, `normalizeWait`, `normalizeSubflow`, `normalizePrompt`,
 * `normalizeReturnTo`) is unchanged and consumed by the node dispatcher in
 * `./normalize-node-helpers.ts`.
 */

export { normalizeSpawn } from "./normalize-nodes-spawn-emit-memory/spawn.js";
export { normalizeEmit } from "./normalize-nodes-spawn-emit-memory/emit.js";
export { normalizeMemory } from "./normalize-nodes-spawn-emit-memory/memory.js";
export {
  normalizeHttp,
  normalizePrompt,
  normalizeReturnTo,
  normalizeSubflow,
  normalizeWait,
} from "./normalize-nodes-spawn-emit-memory/misc-nodes.js";
