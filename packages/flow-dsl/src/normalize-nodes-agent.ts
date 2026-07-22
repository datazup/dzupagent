/**
 * DSL normalization for `agent` and `validate` nodes (dzupflow/v1alpha-agent).
 *
 * Thin composition root. The implementation is split into per-concern leaf
 * modules under `normalize-nodes-agent/` (DZUPAGENT-ARCH-M-06):
 *
 * - `normalize-agent-node.ts` — the `agent` node normalizer + allowed keys
 * - `normalize-validate-node.ts` — the `validate` node normalizer + allowed keys
 * - `agent-output-retry-fields.ts` — output/stop/onInvalidOutput/retry fields
 * - `agent-validation-policy-fields.ts` — validation/policy fields + the
 *   shared `normalizeCommands` helper
 *
 * Public surface (`normalizeAgent`, `normalizeValidate`) is unchanged. Shape
 * constraints must agree with `@dzupagent/flow-ast`'s `parse/agent.ts` and
 * `validate/agent.ts`.
 */

export { normalizeAgent } from "./normalize-nodes-agent/normalize-agent-node.js";
export { normalizeValidate } from "./normalize-nodes-agent/normalize-validate-node.js";
