// Thin composition root for the SPDD per-node parsers.
// The 13 spdd.* node parsers were decomposed (ARCH-M-06 / MJ-01) into cohesive
// per-phase leaf modules under ./spdd/; this file preserves the exact public
// surface consumed by ./dispatch.ts and the __tests__ specs.
export {
  parseSpddImportSources,
  parseSpddBuildSourcePack,
  parseSpddRunAnalysis,
} from "./spdd/sources.js";
export {
  parseSpddGenerateCanvas,
  parseSpddValidateCanvas,
  parseSpddReviewCanvas,
  parseSpddProjectPlan,
} from "./spdd/canvas.js";
export {
  parseSpddArmDispatch,
  parseSpddRunValidation,
  parseSpddCollectProof,
} from "./spdd/dispatch.js";
export {
  parseSpddScanDrift,
  parseSpddCreateSyncProposal,
  parseSpddAgentSwarm,
} from "./spdd/drift-swarm.js";
