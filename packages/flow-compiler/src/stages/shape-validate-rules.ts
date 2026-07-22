import type { distributedValidators } from "./shape-validate-rules-distributed.js";
import { controlFlowValidators } from "./shape-validate-rules/control-flow.js";
import { leafValidators } from "./shape-validate-rules/leaf.js";
import { shellEvidenceSpddValidators } from "./shape-validate-rules/shell-evidence-spdd.js";
import type {
  ShapeRulePartial,
  ShapeRuleTable,
} from "./shape-validate-shared.js";

/**
 * Control-flow + leaf structural validation rules (RF-9 / CODE-M-08 +
 * ARCH-M-06). The former ~36-branch `visit()` switch is a data-driven rule
 * table: each FlowNode kind maps to a pure rule that pushes its own EMPTY_BODY /
 * MISSING_REQUIRED_FIELD defects and recurses into its child slices via
 * `ctx.visit`. The fleet/knowledge/worker/adapter rules live in
 * `shape-validate-rules-distributed.ts`; `shape-validate.ts` assembles both into
 * one exhaustive `ShapeRuleTable`.
 *
 * ARCH-M-06 / MJ-01 decomposition: the ~40 co-located per-node-kind rules that
 * previously lived inline here were split by rule category into cohesive leaf
 * modules under `./shape-validate-rules/` — control-flow.ts (recursing nodes),
 * leaf.ts (no-child-slice nodes), shell-evidence-spdd.ts (shell/evidence/schema
 * + SPDD no-ops). This file is now a thin composition root that assembles them
 * into the same `controlAndLeafValidators` table and preserves the exact
 * `ControlAndLeafKind` type. Pure refactor — behaviour is unchanged.
 */
export type ControlAndLeafKind = Exclude<
  keyof ShapeRuleTable,
  keyof typeof distributedValidators
>;

/**
 * Assembled from the three per-category sub-tables. The `ShapeRulePartial<
 * ControlAndLeafKind>` annotation is the exhaustiveness guard: the spread must
 * cover EXACTLY the ControlAndLeafKind key set (every non-distributed FlowNode
 * kind), so a kind missing from all three sub-tables is a COMPILE error and an
 * extra/mistyped kind is rejected — preserving the old single-table guarantee.
 * `shape-validate.ts` additionally types the merge with distributedValidators as
 * the full `ShapeRuleTable`, keeping the exhaustiveness contract end-to-end.
 */
export const controlAndLeafValidators: ShapeRulePartial<ControlAndLeafKind> = {
  ...controlFlowValidators,
  ...leafValidators,
  ...shellEvidenceSpddValidators,
};
