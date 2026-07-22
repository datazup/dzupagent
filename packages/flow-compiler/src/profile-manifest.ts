/**
 * Barrel for the flow-compiler profile manifest surface.
 *
 * The implementation was decomposed into focused leaf modules under
 * `./profile-manifest/`. This file preserves the exact public export
 * surface (types + values) that consumers import from
 * `./profile-manifest.js`.
 */

export type {
  FlowProfileDiagnostic,
  FlowProfileDiagnosticCode,
  FlowProfileKind,
  FlowProfileLock,
  FlowProfileLockEntry,
  FlowProfileLowering,
  FlowProfileManifest,
  FlowProfileValidationResult,
} from "./profile-manifest/types.js";

export {
  FLOW_PROFILE_LOCK_JSON_SCHEMA,
  FLOW_PROFILE_MANIFEST_JSON_SCHEMA,
} from "./profile-manifest/schemas.js";

export { FLOW_PROFILE_MANIFESTS } from "./profile-manifest/definitions.js";

export { hashFlowProfileManifest } from "./profile-manifest/hashing.js";

export {
  createFlowProfileLock,
  validateFlowProfileLock,
  validateFlowProfileManifest,
} from "./profile-manifest/validation.js";
