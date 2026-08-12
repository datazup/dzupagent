export type {
  AgentResult,
  RunSpec,
  RunSpecHash,
  TurnVerb,
  ValidationResult,
  ValidationSpec,
  WorkspaceEffect,
  WorkspaceSnapshot,
} from "@dzupagent/dialogue-core";

export type {
  GoldenTrace,
  GoldenTraceTurn,
} from "./golden-trace-contract.js";
export { loadGoldenTrace, validateGoldenTrace } from "./golden-trace-loader.js";
export { GoldenTraceValidationError } from "./golden-trace-validation-error.js";
export { GOLDEN_TRACE_FIXTURE_CONTRACT_V1 } from "./golden-trace-fixture-contract.js";
export type {
  GoldenTraceFixtureAdmissionV1,
  GoldenTraceFixtureBindingsV1,
  GoldenTraceFixtureCustodyV1,
  GoldenTraceFixtureFileV1,
  GoldenTraceFixtureManifestV1,
  GoldenTraceFixturePayloadV1,
  GoldenTraceFixturePrivacyV1,
  GoldenTraceFixtureSanitizedPrivacyV1,
  GoldenTraceFixtureSourceBindingV1,
  GoldenTraceFixtureSyntheticPrivacyV1,
} from "./golden-trace-fixture-contract.js";
export { validateGoldenTraceFixtureManifestV1 } from "./golden-trace-fixture-decoder.js";
export { loadGoldenTraceFixtureV1 } from "./golden-trace-fixture-loader.js";
export { GoldenTraceFixtureValidationError } from "./golden-trace-fixture-validation-error.js";
export type { GoldenTraceFixtureValidationCode } from "./golden-trace-fixture-validation-error.js";
