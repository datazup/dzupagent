import {
  GOLDEN_TRACE_FIXTURE_BASE_COMMIT,
  GOLDEN_TRACE_FIXTURE_COMPILER_CONTRACT,
  GOLDEN_TRACE_FIXTURE_DIALOGUE_CORE_VERSION,
  GOLDEN_TRACE_FIXTURE_MANIFEST_SCHEMA_V1,
  GOLDEN_TRACE_FIXTURE_P003_SOURCE_MANIFEST_SHA256,
  GOLDEN_TRACE_FIXTURE_PRIVACY_POLICY_V1,
  GOLDEN_TRACE_FIXTURE_REPLAY_VERSION,
  GOLDEN_TRACE_FIXTURE_RUNTIME_TARGET,
  GOLDEN_TRACE_FIXTURE_SANITIZER_POLICY_V1,
  GOLDEN_TRACE_SCHEMA_V1,
  type GoldenTraceFixtureBindingsV1,
  type GoldenTraceFixtureCustodyV1,
  type GoldenTraceFixtureFileV1,
  type GoldenTraceFixtureManifestV1,
  type GoldenTraceFixturePrivacyV1,
  type GoldenTraceFixtureSourceBindingV1,
} from "./golden-trace-fixture-contract.js";
import {
  GoldenTraceFixtureDecodeContext,
  type GoldenTraceFixtureExactRecord,
} from "./golden-trace-fixture-decode-context.js";
import {
  GOLDEN_TRACE_FIXTURE_MAX_FILES,
  GOLDEN_TRACE_FIXTURE_MAX_PATH_BYTES,
  GOLDEN_TRACE_FIXTURE_MAX_PAYLOAD_BYTES,
} from "./golden-trace-fixture-limits.js";
import {
  failGoldenTraceFixture,
  GoldenTraceFixtureValidationError,
} from "./golden-trace-fixture-validation-error.js";

const MANIFEST_KEYS = [
  "schema",
  "fixtureId",
  "custody",
  "bindings",
  "privacy",
  "files",
] as const;
const PRIVACY_KEYS = [
  "classification",
  "authorship",
  "privacyPolicy",
  "sanitizerPolicy",
  "rawProviderOutput",
  "credentialsOrSecrets",
  "tenantOrPrivateContent",
  "absolutePaths",
  "productionCapture",
  "publicationStatus",
] as const;

export function validateGoldenTraceFixtureManifestV1(
  value: unknown,
): GoldenTraceFixtureManifestV1 {
  try {
    const context = new GoldenTraceFixtureDecodeContext();
    const manifest = context.record(
      value,
      "$manifest",
      0,
      MANIFEST_KEYS,
      (record) => decodeManifest(context, record),
    );
    context.assertEncodedManifestSize(manifest);
    return manifest;
  } catch (error) {
    if (error instanceof GoldenTraceFixtureValidationError) {
      throw error;
    }
    failGoldenTraceFixture("UNSAFE_INPUT", "$manifest");
  }
}

function decodeManifest(
  context: GoldenTraceFixtureDecodeContext,
  record: GoldenTraceFixtureExactRecord,
): GoldenTraceFixtureManifestV1 {
  const schema = context.literal(
    context.required(record, "schema", "$manifest"),
    "$manifest.schema",
    1,
    GOLDEN_TRACE_FIXTURE_MANIFEST_SCHEMA_V1,
  );
  const fixtureId = context.string(
    context.required(record, "fixtureId", "$manifest"),
    "$manifest.fixtureId",
    1,
    { nonEmpty: true },
  );
  validateFixtureId(fixtureId);
  const custody = decodeCustody(
    context,
    context.required(record, "custody", "$manifest"),
  );
  const bindings = decodeBindings(
    context,
    context.required(record, "bindings", "$manifest"),
  );
  const privacy = decodePrivacy(
    context,
    context.required(record, "privacy", "$manifest"),
  );
  const files = context.array(
    context.required(record, "files", "$manifest"),
    "$manifest.files",
    1,
    (item, location, depth) =>
      decodeFile(context, item, location, depth, fixtureId),
    {
      minItems: GOLDEN_TRACE_FIXTURE_MAX_FILES,
      maxItems: GOLDEN_TRACE_FIXTURE_MAX_FILES,
      lengthCode: "MANIFEST_FILE_COUNT_LIMIT",
    },
  );

  return { schema, fixtureId, custody, bindings, privacy, files };
}

function decodeCustody(
  context: GoldenTraceFixtureDecodeContext,
  value: unknown,
): GoldenTraceFixtureCustodyV1 {
  return context.record(
    value,
    "$manifest.custody",
    1,
    ["manifestBytes", "fileTableScope"],
    (record) => ({
      manifestBytes: context.literal(
        context.required(record, "manifestBytes", "$manifest.custody"),
        "$manifest.custody.manifestBytes",
        2,
        "external-receipt-required",
      ),
      fileTableScope: context.literal(
        context.required(record, "fileTableScope", "$manifest.custody"),
        "$manifest.custody.fileTableScope",
        2,
        "payloads-only",
      ),
    }),
  );
}

function decodeBindings(
  context: GoldenTraceFixtureDecodeContext,
  value: unknown,
): GoldenTraceFixtureBindingsV1 {
  return context.record(
    value,
    "$manifest.bindings",
    1,
    [
      "traceSchema",
      "dialogueCoreVersion",
      "replayVersion",
      "runtimeTarget",
      "compilerContract",
      "source",
    ],
    (record) => ({
      traceSchema: context.literal(
        context.required(record, "traceSchema", "$manifest.bindings"),
        "$manifest.bindings.traceSchema",
        2,
        GOLDEN_TRACE_SCHEMA_V1,
      ),
      dialogueCoreVersion: context.literal(
        context.required(
          record,
          "dialogueCoreVersion",
          "$manifest.bindings",
        ),
        "$manifest.bindings.dialogueCoreVersion",
        2,
        GOLDEN_TRACE_FIXTURE_DIALOGUE_CORE_VERSION,
      ),
      replayVersion: context.literal(
        context.required(record, "replayVersion", "$manifest.bindings"),
        "$manifest.bindings.replayVersion",
        2,
        GOLDEN_TRACE_FIXTURE_REPLAY_VERSION,
      ),
      runtimeTarget: context.literal(
        context.required(record, "runtimeTarget", "$manifest.bindings"),
        "$manifest.bindings.runtimeTarget",
        2,
        GOLDEN_TRACE_FIXTURE_RUNTIME_TARGET,
      ),
      compilerContract: context.literal(
        context.required(record, "compilerContract", "$manifest.bindings"),
        "$manifest.bindings.compilerContract",
        2,
        GOLDEN_TRACE_FIXTURE_COMPILER_CONTRACT,
      ),
      source: decodeSource(
        context,
        context.required(record, "source", "$manifest.bindings"),
      ),
    }),
  );
}

function decodeSource(
  context: GoldenTraceFixtureDecodeContext,
  value: unknown,
): GoldenTraceFixtureSourceBindingV1 {
  return context.record(
    value,
    "$manifest.bindings.source",
    2,
    ["baseCommit", "predecessorSourceManifestSha256"],
    (record) => ({
      baseCommit: context.literal(
        context.required(
          record,
          "baseCommit",
          "$manifest.bindings.source",
        ),
        "$manifest.bindings.source.baseCommit",
        3,
        GOLDEN_TRACE_FIXTURE_BASE_COMMIT,
      ),
      predecessorSourceManifestSha256: context.literal(
        context.required(
          record,
          "predecessorSourceManifestSha256",
          "$manifest.bindings.source",
        ),
        "$manifest.bindings.source.predecessorSourceManifestSha256",
        3,
        GOLDEN_TRACE_FIXTURE_P003_SOURCE_MANIFEST_SHA256,
      ),
    }),
  );
}

function decodePrivacy(
  context: GoldenTraceFixtureDecodeContext,
  value: unknown,
): GoldenTraceFixturePrivacyV1 {
  return context.record(
    value,
    "$manifest.privacy",
    1,
    PRIVACY_KEYS,
    (record) => {
      const classification = context.oneOf(
        context.required(record, "classification", "$manifest.privacy"),
        "$manifest.privacy.classification",
        2,
        ["synthetic", "sanitized"] as const,
      );
      const authorship = context.literal(
        context.required(record, "authorship", "$manifest.privacy"),
        "$manifest.privacy.authorship",
        2,
        "datazup",
      );
      const privacyPolicy = context.literal(
        context.required(record, "privacyPolicy", "$manifest.privacy"),
        "$manifest.privacy.privacyPolicy",
        2,
        GOLDEN_TRACE_FIXTURE_PRIVACY_POLICY_V1,
      );
      const sanitizerPolicy = context.literal(
        context.required(record, "sanitizerPolicy", "$manifest.privacy"),
        "$manifest.privacy.sanitizerPolicy",
        2,
        classification === "synthetic"
          ? "not-applicable"
          : GOLDEN_TRACE_FIXTURE_SANITIZER_POLICY_V1,
      );
      assertPrivacyFalse(context, record, "rawProviderOutput");
      assertPrivacyFalse(context, record, "credentialsOrSecrets");
      assertPrivacyFalse(context, record, "tenantOrPrivateContent");
      assertPrivacyFalse(context, record, "absolutePaths");
      assertPrivacyFalse(context, record, "productionCapture");
      const publicationStatus = context.literal(
        context.required(
          record,
          "publicationStatus",
          "$manifest.privacy",
        ),
        "$manifest.privacy.publicationStatus",
        2,
        "local-only-unreviewed",
      );

      const common = {
        authorship,
        privacyPolicy,
        rawProviderOutput: false,
        credentialsOrSecrets: false,
        tenantOrPrivateContent: false,
        absolutePaths: false,
        productionCapture: false,
        publicationStatus,
      } as const;
      return classification === "synthetic"
        ? {
            classification,
            sanitizerPolicy: sanitizerPolicy as "not-applicable",
            ...common,
          }
        : {
            classification,
            sanitizerPolicy:
              sanitizerPolicy as typeof GOLDEN_TRACE_FIXTURE_SANITIZER_POLICY_V1,
            ...common,
          };
    },
  );
}

function assertPrivacyFalse(
  context: GoldenTraceFixtureDecodeContext,
  record: GoldenTraceFixtureExactRecord,
  key:
    | "rawProviderOutput"
    | "credentialsOrSecrets"
    | "tenantOrPrivateContent"
    | "absolutePaths"
    | "productionCapture",
): void {
  const location = `$manifest.privacy.${key}`;
  if (
    context.boolean(
      context.required(record, key, "$manifest.privacy"),
      location,
      2,
    )
  ) {
    failGoldenTraceFixture("PRIVACY_DENIED", location);
  }
}

function decodeFile(
  context: GoldenTraceFixtureDecodeContext,
  value: unknown,
  location: string,
  depth: number,
  fixtureId: string,
): GoldenTraceFixtureFileV1 {
  return context.record(
    value,
    location,
    depth,
    ["path", "role", "mediaType", "byteLength", "sha256"],
    (record) => {
      const payloadPath = context.string(
        context.required(record, "path", location),
        `${location}.path`,
        depth + 1,
        {
          nonEmpty: true,
          maxBytes: GOLDEN_TRACE_FIXTURE_MAX_PATH_BYTES,
        },
      );
      validatePayloadPath(payloadPath, fixtureId, `${location}.path`);
      const byteLength = context.nonNegativeInteger(
        context.required(record, "byteLength", location),
        `${location}.byteLength`,
        depth + 1,
      );
      if (byteLength > GOLDEN_TRACE_FIXTURE_MAX_PAYLOAD_BYTES) {
        failGoldenTraceFixture("PAYLOAD_BYTES_LIMIT", `${location}.byteLength`);
      }
      return {
        path: payloadPath,
        role: context.literal(
          context.required(record, "role", location),
          `${location}.role`,
          depth + 1,
          "golden-trace",
        ),
        mediaType: context.literal(
          context.required(record, "mediaType", location),
          `${location}.mediaType`,
          depth + 1,
          "application/json; charset=utf-8",
        ),
        byteLength,
        sha256: context.digest(
          context.required(record, "sha256", location),
          `${location}.sha256`,
          depth + 1,
        ),
      };
    },
  );
}

function validateFixtureId(fixtureId: string): void {
  let previousWasHyphen = false;
  for (let index = 0; index < fixtureId.length; index += 1) {
    const code = fixtureId.charCodeAt(index);
    const isLowercaseLetter = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    const isHyphen = code === 45;
    if (
      (!isLowercaseLetter && !isDigit && !isHyphen) ||
      (isHyphen && (index === 0 || previousWasHyphen))
    ) {
      failGoldenTraceFixture("MANIFEST_INVALID", "$manifest.fixtureId");
    }
    previousWasHyphen = isHyphen;
  }
  if (previousWasHyphen) {
    failGoldenTraceFixture("MANIFEST_INVALID", "$manifest.fixtureId");
  }
}

function validatePayloadPath(
  payloadPath: string,
  fixtureId: string,
  location: string,
): void {
  if (
    payloadPath !== `${fixtureId}.golden.json` ||
    /[\\/\u0000-\u001f\u007f]/u.test(payloadPath) ||
    /^[A-Za-z]:/u.test(payloadPath)
  ) {
    failGoldenTraceFixture("MANIFEST_INVALID", location);
  }
}
