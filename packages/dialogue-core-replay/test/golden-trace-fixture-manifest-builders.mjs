import { createHash } from "node:crypto";

import { required } from "./typecheck-helpers.mjs";

export const MANIFEST_SCHEMA =
  "datazup.dialogue-core-replay.golden-trace-fixture-manifest/v1";
export const TRACE_SCHEMA = "datazup.dialogue-core.golden-trace/v1";
export const PRIVACY_POLICY =
  "datazup.dialogue-core-replay.fixture-privacy/v1";
export const SANITIZER_POLICY =
  "datazup.dialogue-core-replay.fixture-sanitizer/v1";
export const BASE_COMMIT = "b13276bf8d20615f3010a1f5814256dd9e3096bc";
export const P003_SOURCE_MANIFEST =
  "sha256:4c995523edcd994425f11cb6ba2944d2fd378237ebefe8cbae114af87772b28b";

/**
 * @typedef {object} FixturePrivacy
 * @property {string} classification
 * @property {string} authorship
 * @property {string} privacyPolicy
 * @property {string} sanitizerPolicy
 * @property {boolean} rawProviderOutput
 * @property {boolean} credentialsOrSecrets
 * @property {boolean} tenantOrPrivateContent
 * @property {boolean} absolutePaths
 * @property {boolean} productionCapture
 * @property {string} publicationStatus
 */

/**
 * @typedef {object} FixtureManifest
 * @property {string} schema
 * @property {string} fixtureId
 * @property {{ manifestBytes: string, fileTableScope: string }} custody
 * @property {{
 *   traceSchema: string,
 *   dialogueCoreVersion: string,
 *   replayVersion: string,
 *   runtimeTarget: string,
 *   compilerContract: string,
 *   source: { baseCommit: string, predecessorSourceManifestSha256: string }
 * }} bindings
 * @property {FixturePrivacy} privacy
 * @property {Array<{
 *   path: string,
 *   role: string,
 *   mediaType: string,
 *   byteLength: number,
 *   sha256: string
 * }>} files
 */

/** @param {string} utf8 */
export function sha256Utf8(utf8) {
  return sha256Bytes(utf8Bytes(utf8));
}

/** @param {ArrayBuffer} bytes */
export function sha256Bytes(bytes) {
  return `sha256:${createHash("sha256").update(new Uint8Array(bytes)).digest("hex")}`;
}

/** @param {string} utf8 */
export function utf8Bytes(utf8) {
  return new TextEncoder().encode(utf8).buffer;
}

/** @returns {FixturePrivacy} */
export function syntheticPrivacy() {
  return {
    classification: "synthetic",
    authorship: "datazup",
    privacyPolicy: PRIVACY_POLICY,
    sanitizerPolicy: "not-applicable",
    rawProviderOutput: false,
    credentialsOrSecrets: false,
    tenantOrPrivateContent: false,
    absolutePaths: false,
    productionCapture: false,
    publicationStatus: "local-only-unreviewed",
  };
}

/** @returns {FixturePrivacy} */
export function sanitizedPrivacy() {
  return {
    ...syntheticPrivacy(),
    classification: "sanitized",
    sanitizerPolicy: SANITIZER_POLICY,
  };
}

/**
 * @param {string} fixtureId
 * @param {string} utf8
 */
export function manifestFor(fixtureId, utf8) {
  return manifestForBytes(fixtureId, utf8Bytes(utf8));
}

/**
 * @param {string} fixtureId
 * @param {ArrayBuffer} bytes
 * @returns {FixtureManifest}
 */
export function manifestForBytes(fixtureId, bytes) {
  const payloadPath = `${fixtureId}.golden.json`;
  return {
    schema: MANIFEST_SCHEMA,
    fixtureId,
    custody: {
      manifestBytes: "external-receipt-required",
      fileTableScope: "payloads-only",
    },
    bindings: {
      traceSchema: TRACE_SCHEMA,
      dialogueCoreVersion: "0.2.0",
      replayVersion: "0.2.0",
      runtimeTarget: "node20-esm",
      compilerContract:
        "typescript@5.9.3+nodenext+es2022+exact-optional-property-types",
      source: {
        baseCommit: BASE_COMMIT,
        predecessorSourceManifestSha256: P003_SOURCE_MANIFEST,
      },
    },
    privacy: syntheticPrivacy(),
    files: [
      {
        path: payloadPath,
        role: "golden-trace",
        mediaType: "application/json; charset=utf-8",
        byteLength: bytes.byteLength,
        sha256: sha256Bytes(bytes),
      },
    ],
  };
}

/**
 * @param {FixtureManifest} manifest
 * @param {string} utf8
 */
export function payloadFor(manifest, utf8) {
  return payloadBytesFor(manifest, utf8Bytes(utf8));
}

/**
 * @param {FixtureManifest} manifest
 * @param {ArrayBuffer} bytes
 */
export function payloadBytesFor(manifest, bytes) {
  return [{ path: required(manifest.files[0], "manifest file").path, bytes }];
}

export function minimalTraceJson() {
  return JSON.stringify({
    runId: "fixture-run",
    runSpecHash:
      "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    verbSequence: [],
    runSpec: { mode: "deliberate", participants: [], turns: [] },
    turns: [],
  });
}
