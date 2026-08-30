// The loop-economics evidence contract is decomposed along its section
// boundaries (ARCH27-T-15 residue); this facade is the
// `./loop-economics-evidence` subpath surface and re-exports it unchanged.
export {
  LOOP_ECONOMICS_EVIDENCE_SCHEMA,
  type LoopEconomicsEffectIntentBinding,
  type LoopEconomicsEvidenceDiagnostic,
  type LoopEconomicsEvidenceDiagnosticCode,
  type LoopEconomicsEvidenceExpectation,
  type LoopEconomicsEvidenceInput,
  type LoopEconomicsEvidenceOwner,
  type LoopEconomicsEvidenceUnit,
  type LoopEconomicsEvidenceV1,
  type LoopEconomicsEvidenceValidation,
  type LoopEconomicsExecutionAdmission,
  type LoopEconomicsMoneyBinding,
  type LoopEconomicsQuotaBinding,
  type LoopEconomicsTerminalEffect,
  type LoopEconomicsTerminalEvidence,
  type LoopEconomicsTerminalExecution,
} from "./loop-economics-evidence/types.js";
export { validateLoopEconomicsEvidence } from "./loop-economics-evidence/validation.js";
// The materializer is engine-tier (see ENGINE.md); this domain subpath
// barrel is the re-export exception that keeps its public import path.
export { materializeLoopEconomicsEvidence } from "./engine/loop-economics-evidence.js";
