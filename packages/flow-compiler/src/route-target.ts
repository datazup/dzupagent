// Thin composition root for STAGE-4 target routing. The three independent
// AST passes that previously lived fused in this file are now cohesive leaf
// modules under ./route-target/:
//   • target-router.ts            — the D2 feature bitmask (FEATURE_BITS /
//                                   computeFeatureBitmask) and the router→lowerer
//                                   dispatch decision (routeTarget).
//   • on-error.ts                 — the separate forward-compatible on_error
//                                   structural detection pass (hasOnError),
//                                   the STAGE-2/STAGE-4 skill-chain backstop.
//   • unsupported-runtime-nodes.ts — the runtime-leaf/artifact-anchor pass that
//                                   flags runtime-executed leaves a target can't
//                                   lower (collectUnsupportedRuntimeNodes +
//                                   UnsupportedRuntimeNode).
// Public surface is unchanged; consumers keep importing from "./route-target.js".
export {
  FEATURE_BITS,
  routeTarget,
  computeFeatureBitmask,
} from "./route-target/target-router.js";
export type { FeatureBitmask } from "./route-target/target-router.js";
export { hasOnError } from "./route-target/on-error.js";
export { collectUnsupportedRuntimeNodes } from "./route-target/unsupported-runtime-nodes.js";
export type { UnsupportedRuntimeNode } from "./route-target/unsupported-runtime-nodes.js";
