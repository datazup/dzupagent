import type { GoldenTrace } from "./golden-trace-contract.js";

export const GOLDEN_TRACE_FIXTURE_MANIFEST_SCHEMA_V1 =
  "datazup.dialogue-core-replay.golden-trace-fixture-manifest/v1";
export const GOLDEN_TRACE_SCHEMA_V1 =
  "datazup.dialogue-core.golden-trace/v1";
export const GOLDEN_TRACE_FIXTURE_PRIVACY_POLICY_V1 =
  "datazup.dialogue-core-replay.fixture-privacy/v1";
export const GOLDEN_TRACE_FIXTURE_SANITIZER_POLICY_V1 =
  "datazup.dialogue-core-replay.fixture-sanitizer/v1";
export const GOLDEN_TRACE_FIXTURE_BASE_COMMIT =
  "b13276bf8d20615f3010a1f5814256dd9e3096bc";
export const GOLDEN_TRACE_FIXTURE_P003_SOURCE_MANIFEST_SHA256 =
  "sha256:4c995523edcd994425f11cb6ba2944d2fd378237ebefe8cbae114af87772b28b";
export const GOLDEN_TRACE_FIXTURE_DIALOGUE_CORE_VERSION = "0.2.0";
export const GOLDEN_TRACE_FIXTURE_REPLAY_VERSION = "0.2.0";
export const GOLDEN_TRACE_FIXTURE_RUNTIME_TARGET = "node20-esm";
export const GOLDEN_TRACE_FIXTURE_COMPILER_CONTRACT =
  "typescript@5.9.3+nodenext+es2022+exact-optional-property-types";

export const GOLDEN_TRACE_FIXTURE_CONTRACT_V1 = Object.freeze({
  manifestSchema: GOLDEN_TRACE_FIXTURE_MANIFEST_SCHEMA_V1,
  traceSchema: GOLDEN_TRACE_SCHEMA_V1,
  privacyPolicy: GOLDEN_TRACE_FIXTURE_PRIVACY_POLICY_V1,
  sanitizerPolicy: GOLDEN_TRACE_FIXTURE_SANITIZER_POLICY_V1,
  baseCommit: GOLDEN_TRACE_FIXTURE_BASE_COMMIT,
  predecessorSourceManifestSha256:
    GOLDEN_TRACE_FIXTURE_P003_SOURCE_MANIFEST_SHA256,
  dialogueCoreVersion: GOLDEN_TRACE_FIXTURE_DIALOGUE_CORE_VERSION,
  replayVersion: GOLDEN_TRACE_FIXTURE_REPLAY_VERSION,
  runtimeTarget: GOLDEN_TRACE_FIXTURE_RUNTIME_TARGET,
  compilerContract: GOLDEN_TRACE_FIXTURE_COMPILER_CONTRACT,
});

export interface GoldenTraceFixtureCustodyV1 {
  readonly manifestBytes: "external-receipt-required";
  readonly fileTableScope: "payloads-only";
}

export interface GoldenTraceFixtureSourceBindingV1 {
  readonly baseCommit: typeof GOLDEN_TRACE_FIXTURE_BASE_COMMIT;
  readonly predecessorSourceManifestSha256: typeof GOLDEN_TRACE_FIXTURE_P003_SOURCE_MANIFEST_SHA256;
}

export interface GoldenTraceFixtureBindingsV1 {
  readonly traceSchema: typeof GOLDEN_TRACE_SCHEMA_V1;
  readonly dialogueCoreVersion: typeof GOLDEN_TRACE_FIXTURE_DIALOGUE_CORE_VERSION;
  readonly replayVersion: typeof GOLDEN_TRACE_FIXTURE_REPLAY_VERSION;
  readonly runtimeTarget: typeof GOLDEN_TRACE_FIXTURE_RUNTIME_TARGET;
  readonly compilerContract: typeof GOLDEN_TRACE_FIXTURE_COMPILER_CONTRACT;
  readonly source: GoldenTraceFixtureSourceBindingV1;
}

interface GoldenTraceFixturePrivacyCommonV1 {
  readonly authorship: "datazup";
  readonly privacyPolicy: typeof GOLDEN_TRACE_FIXTURE_PRIVACY_POLICY_V1;
  readonly rawProviderOutput: false;
  readonly credentialsOrSecrets: false;
  readonly tenantOrPrivateContent: false;
  readonly absolutePaths: false;
  readonly productionCapture: false;
  readonly publicationStatus: "local-only-unreviewed";
}

export interface GoldenTraceFixtureSyntheticPrivacyV1
  extends GoldenTraceFixturePrivacyCommonV1 {
  readonly classification: "synthetic";
  readonly sanitizerPolicy: "not-applicable";
}

export interface GoldenTraceFixtureSanitizedPrivacyV1
  extends GoldenTraceFixturePrivacyCommonV1 {
  readonly classification: "sanitized";
  readonly sanitizerPolicy: typeof GOLDEN_TRACE_FIXTURE_SANITIZER_POLICY_V1;
}

export type GoldenTraceFixturePrivacyV1 =
  | GoldenTraceFixtureSyntheticPrivacyV1
  | GoldenTraceFixtureSanitizedPrivacyV1;

export interface GoldenTraceFixtureFileV1 {
  readonly path: string;
  readonly role: "golden-trace";
  readonly mediaType: "application/json; charset=utf-8";
  readonly byteLength: number;
  readonly sha256: `sha256:${string}`;
}

export interface GoldenTraceFixtureManifestV1 {
  readonly schema: typeof GOLDEN_TRACE_FIXTURE_MANIFEST_SCHEMA_V1;
  readonly fixtureId: string;
  readonly custody: GoldenTraceFixtureCustodyV1;
  readonly bindings: GoldenTraceFixtureBindingsV1;
  readonly privacy: GoldenTraceFixturePrivacyV1;
  readonly files: readonly GoldenTraceFixtureFileV1[];
}

export interface GoldenTraceFixturePayloadV1 {
  readonly path: string;
  readonly bytes: ArrayBuffer;
}

export interface GoldenTraceFixtureAdmissionV1 {
  readonly manifest: GoldenTraceFixtureManifestV1;
  readonly trace: GoldenTrace;
}
