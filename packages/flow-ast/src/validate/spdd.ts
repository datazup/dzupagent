// Thin composition root for SPDD per-node-kind validators.
// The concrete validators live in ./spdd/ leaf modules grouped by SPDD
// pipeline phase (sources -> canvas -> execution -> drift), mirroring the
// sibling ./document/ split convention. This module preserves the exact
// public surface consumed by ./dispatch.ts with zero signature changes.
export {
  validateSpddImportSources,
  validateSpddBuildSourcePack,
  validateSpddRunAnalysis,
} from "./spdd/sources.js";
export {
  validateSpddGenerateCanvas,
  validateSpddValidateCanvas,
  validateSpddReviewCanvas,
  validateSpddProjectPlan,
} from "./spdd/canvas.js";
export {
  validateSpddArmDispatch,
  validateSpddRunValidation,
  validateSpddCollectProof,
} from "./spdd/execution.js";
export {
  validateSpddScanDrift,
  validateSpddCreateSyncProposal,
  validateSpddAgentSwarm,
} from "./spdd/drift.js";
