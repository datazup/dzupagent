// The execution-boundary evidence contract is decomposed along its section
// boundaries (ARCH27-T-15 residue); this facade is the
// `./execution-boundary-evidence` subpath surface and re-exports it unchanged.
export * from "./execution-boundary-evidence/types.js";
export {
  admitExecutionBoundaryEvidenceV1,
  validateExecutionBoundaryEvidenceV1,
} from "./execution-boundary-evidence/validation.js";
// The materializers are engine-tier (see ENGINE.md); this domain subpath
// barrel is the re-export exception that keeps their public import path.
export {
  materializeAdapterPolicyRefV1,
  materializeExecutionBoundaryEvidenceV1,
  materializeExecutionStateAccessInventoryV1,
  materializeWorkspaceHandleRefV1,
} from "./engine/execution-boundary-evidence.js";
