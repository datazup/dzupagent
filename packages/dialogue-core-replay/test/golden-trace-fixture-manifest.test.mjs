import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as core from "../../dialogue-core/src/index.ts";
import * as replay from "../src/index.ts";
import {
  BASE_COMMIT,
  MANIFEST_SCHEMA,
  P003_SOURCE_MANIFEST,
  PRIVACY_POLICY,
  SANITIZER_POLICY,
  TRACE_SCHEMA,
  manifestFor,
  minimalTraceJson,
  payloadBytesFor,
  payloadFor,
  sanitizedPrivacy,
} from "./golden-trace-fixture-manifest-builders.mjs";
import { mutableRecord, required } from "./typecheck-helpers.mjs";

/** @typedef {ReturnType<typeof manifestFor>} FixtureManifest */

const fixturesDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

function fixtureLoader() {
  expect(replay.loadGoldenTraceFixtureV1).toBeTypeOf("function");
  return replay.loadGoldenTraceFixtureV1;
}

/**
 * @param {() => unknown} run
 * @param {string} code
 */
function expectFixtureFailure(run, code) {
  try {
    run();
    throw new Error("expected fixture admission to fail");
  } catch (error) {
    if (!(error instanceof replay.GoldenTraceFixtureValidationError)) {
      throw error;
    }
    expect(error).toBeInstanceOf(replay.GoldenTraceFixtureValidationError);
    expect(error.code).toBe(code);
    expect(
      ["$manifest", "$payloads", "$fixture"].some(
        (root) =>
          error.location === root ||
          error.location.startsWith(`${root}.`) ||
          error.location.startsWith(`${root}[`),
      ),
    ).toBe(true);
    expect(Buffer.byteLength(error.message, "utf8")).toBeLessThanOrEqual(256);
  }
}

function validBundle() {
  const utf8 = minimalTraceJson();
  const manifest = manifestFor("minimal", utf8);
  return { manifest, manifestJson: JSON.stringify(manifest), utf8 };
}

describe("GoldenTrace fixture manifest v1", () => {
  it("requires the versioned manifest, fixture identity, and non-self-digest custody rule", () => {
    const { manifest, manifestJson, utf8 } = validBundle();
    const admission = fixtureLoader()(manifestJson, payloadFor(manifest, utf8));

    expect(admission.manifest.schema).toBe(MANIFEST_SCHEMA);
    expect(admission.manifest.fixtureId).toBe("minimal");
    expect(admission.manifest.custody).toEqual({
      manifestBytes: "external-receipt-required",
      fileTableScope: "payloads-only",
    });
    expect(admission.trace.runId).toBe("fixture-run");
  });

  it("admits synthetic and exactly policy-bound sanitized evidence", () => {
    const synthetic = validBundle();
    expect(
      fixtureLoader()(
        synthetic.manifestJson,
        payloadFor(synthetic.manifest, synthetic.utf8),
      ).manifest.privacy.classification,
    ).toBe("synthetic");

    const sanitized = validBundle();
    sanitized.manifest.privacy = sanitizedPrivacy();
    expect(
      fixtureLoader()(
        JSON.stringify(sanitized.manifest),
        payloadFor(sanitized.manifest, sanitized.utf8),
      ).manifest.privacy.classification,
    ).toBe("sanitized");
  });

  it("rejects missing, unknown, and contradictory manifest fields", () => {
    /** @type {Array<(manifest: FixtureManifest) => void>} */
    const mutations = [
      (manifest) => delete mutableRecord(manifest).fixtureId,
      (manifest) => {
        mutableRecord(manifest).unknown = true;
      },
      (manifest) => delete mutableRecord(manifest.bindings).source,
      (manifest) => {
        mutableRecord(required(manifest.files[0], "manifest file")).unknown =
          true;
      },
      (manifest) => {
        manifest.privacy.classification = "synthetic";
        manifest.privacy.sanitizerPolicy = SANITIZER_POLICY;
      },
      (manifest) => {
        manifest.privacy.classification = "sanitized";
        manifest.privacy.sanitizerPolicy = "not-applicable";
      },
    ];

    for (const mutate of mutations) {
      const { manifest, utf8 } = validBundle();
      mutate(manifest);
      expectFixtureFailure(
        () => fixtureLoader()(JSON.stringify(manifest), payloadFor(manifest, utf8)),
        "MANIFEST_INVALID",
      );
    }
  });

  it("binds every schema, version, runtime, compiler, source, and privacy identifier", () => {
    /** @type {Array<[string, (manifest: FixtureManifest) => void]>} */
    const mutations = [
      ["schema", (manifest) => (manifest.schema = `${MANIFEST_SCHEMA}-drift`)],
      ["trace schema", (manifest) => (manifest.bindings.traceSchema = `${TRACE_SCHEMA}-drift`)],
      ["Dialogue Core", (manifest) => (manifest.bindings.dialogueCoreVersion = "0.2.1")],
      ["replay", (manifest) => (manifest.bindings.replayVersion = "0.2.1")],
      ["runtime", (manifest) => (manifest.bindings.runtimeTarget = "node22-esm")],
      ["compiler", (manifest) => (manifest.bindings.compilerContract = "typescript@latest")],
      ["base commit", (manifest) => (manifest.bindings.source.baseCommit = `${BASE_COMMIT.slice(0, -1)}0`)],
      ["source manifest", (manifest) => (manifest.bindings.source.predecessorSourceManifestSha256 = P003_SOURCE_MANIFEST.toUpperCase())],
      ["privacy policy", (manifest) => (manifest.privacy.privacyPolicy = `${PRIVACY_POLICY}-drift`)],
      [
        "file role",
        (manifest) =>
          (required(manifest.files[0], "manifest file").role = "transcript"),
      ],
      [
        "media type",
        (manifest) =>
          (required(manifest.files[0], "manifest file").mediaType =
            "application/json"),
      ],
    ];

    for (const [_label, mutate] of mutations) {
      const { manifest, utf8 } = validBundle();
      mutate(manifest);
      expectFixtureFailure(
        () => fixtureLoader()(JSON.stringify(manifest), payloadFor(manifest, utf8)),
        "MANIFEST_INVALID",
      );
    }
  });

  it("rejects every denied privacy or publication claim", () => {
    const deniedFlags = [
      "rawProviderOutput",
      "credentialsOrSecrets",
      "tenantOrPrivateContent",
      "absolutePaths",
      "productionCapture",
    ];
    for (const field of deniedFlags) {
      const { manifest, utf8 } = validBundle();
      mutableRecord(manifest.privacy)[field] = true;
      expectFixtureFailure(
        () => fixtureLoader()(JSON.stringify(manifest), payloadFor(manifest, utf8)),
        "PRIVACY_DENIED",
      );
    }

    for (const [field, value] of /** @type {Array<[string, string]>} */ ([
      ["classification", "raw"],
      ["authorship", "provider"],
      ["publicationStatus", "approved"],
    ])) {
      const { manifest, utf8 } = validBundle();
      mutableRecord(manifest.privacy)[field] = value;
      expectFixtureFailure(
        () => fixtureLoader()(JSON.stringify(manifest), payloadFor(manifest, utf8)),
        "MANIFEST_INVALID",
      );
    }
  });

  it("binds exact raw UTF-8 bytes before JSON parsing or normalization", () => {
    const utf8 = `${minimalTraceJson()}\n`;
    const manifest = manifestFor("raw-bytes", utf8);
    expect(fixtureLoader()(JSON.stringify(manifest), payloadFor(manifest, utf8)).trace).toBeDefined();

    const normalized = minimalTraceJson();
    expectFixtureFailure(
      () => fixtureLoader()(JSON.stringify(manifest), payloadFor(manifest, normalized)),
      "PAYLOAD_BYTE_LENGTH_MISMATCH",
    );
  });

  it("rejects byte-count and digest drift at exact boundaries", () => {
    const { manifest, utf8 } = validBundle();
    for (const delta of [-1, 1]) {
      const drifted = structuredClone(manifest);
      required(drifted.files[0], "manifest file").byteLength += delta;
      expectFixtureFailure(
        () => fixtureLoader()(JSON.stringify(drifted), payloadFor(drifted, utf8)),
        "PAYLOAD_BYTE_LENGTH_MISMATCH",
      );
    }

    expect(fixtureLoader()(JSON.stringify(manifest), payloadFor(manifest, utf8)).trace).toBeDefined();

    for (const sha256 of [
      required(manifest.files[0], "manifest file").sha256.toUpperCase(),
      `sha256:${"g".repeat(64)}`,
      `sha256:${"0".repeat(63)}`,
    ]) {
      const drifted = structuredClone(manifest);
      required(drifted.files[0], "manifest file").sha256 = sha256;
      expectFixtureFailure(
        () => fixtureLoader()(JSON.stringify(drifted), payloadFor(drifted, utf8)),
        "MANIFEST_INVALID",
      );
    }

    const digestDrift = structuredClone(manifest);
    required(digestDrift.files[0], "manifest file").sha256 =
      `sha256:${"0".repeat(64)}`;
    expectFixtureFailure(
      () => fixtureLoader()(JSON.stringify(digestDrift), payloadFor(digestDrift, utf8)),
      "PAYLOAD_DIGEST_MISMATCH",
    );

    const sameLengthByteDrift = `${utf8.slice(0, -1)} `;
    expect(Buffer.byteLength(sameLengthByteDrift, "utf8")).toBe(
      required(manifest.files[0], "manifest file").byteLength,
    );
    expectFixtureFailure(
      () =>
        fixtureLoader()(JSON.stringify(manifest), [
          {
            path: required(manifest.files[0], "manifest file").path,
            bytes: new TextEncoder().encode(sameLengthByteDrift).buffer,
          },
        ]),
      "PAYLOAD_DIGEST_MISMATCH",
    );
  });

  it("rejects missing, extra, duplicate, renamed, or unlisted entries", () => {
    const { manifest, utf8 } = validBundle();
    const cases = [
      [structuredClone(manifest), []],
      [
        structuredClone(manifest),
        [
          ...payloadFor(manifest, utf8),
          {
            path: "extra.golden.json",
            bytes: new TextEncoder().encode(utf8).buffer,
          },
        ],
      ],
      [structuredClone(manifest), [...payloadFor(manifest, utf8), ...payloadFor(manifest, utf8)]],
    ];
    for (const [candidate, payloads] of cases) {
      expectFixtureFailure(
        () => fixtureLoader()(JSON.stringify(candidate), payloads),
        "PAYLOAD_SET_MISMATCH",
      );
    }

    const manifestFile = required(manifest.files[0], "manifest file");
    for (const files of [[], [manifestFile, manifestFile]]) {
      const wrongFileCount = structuredClone(manifest);
      wrongFileCount.files = structuredClone(files);
      expectFixtureFailure(
        () =>
          fixtureLoader()(
            JSON.stringify(wrongFileCount),
            payloadFor(manifest, utf8),
          ),
        "MANIFEST_FILE_COUNT_LIMIT",
      );
    }

    const renamed = structuredClone(manifest);
    required(renamed.files[0], "manifest file").path = "renamed.golden.json";
    expectFixtureFailure(
      () =>
        fixtureLoader()(JSON.stringify(renamed), [
          {
            path: "renamed.golden.json",
            bytes: new TextEncoder().encode(utf8).buffer,
          },
        ]),
      "MANIFEST_INVALID",
    );
  });

  it.each([
    "",
    ".",
    "..",
    "/absolute.golden.json",
    "C:\\absolute.golden.json",
    "nested/payload.golden.json",
    "nested\\payload.golden.json",
    "payload\0.golden.json",
    "payload\ngolden.json",
  ])("rejects a non-canonical or symlink-ambiguous payload path %j", (payloadPath) => {
    const { manifest, utf8 } = validBundle();
    required(manifest.files[0], "manifest file").path = payloadPath;
    expectFixtureFailure(
      () =>
        fixtureLoader()(JSON.stringify(manifest), [
          {
            path: payloadPath,
            bytes: new TextEncoder().encode(utf8).buffer,
          },
        ]),
      "MANIFEST_INVALID",
    );
  });

  it("enforces the flat payload-path byte boundary", () => {
    for (const fixtureIdLength of [242, 243]) {
      const fixtureId = "a".repeat(fixtureIdLength);
      const utf8 = minimalTraceJson();
      const manifest = manifestFor(fixtureId, utf8);
      expect(
        Buffer.byteLength(
          required(manifest.files[0], "manifest file").path,
          "utf8",
        ),
      ).toBe(
        fixtureIdLength + 12,
      );
      expect(
        fixtureLoader()(
          JSON.stringify(manifest),
          payloadFor(manifest, utf8),
        ).trace,
      ).toBeDefined();
    }

    const utf8 = minimalTraceJson();
    const oversized = manifestFor("a".repeat(244), utf8);
    expectFixtureFailure(
      () =>
        fixtureLoader()(
          JSON.stringify(oversized),
          payloadFor(oversized, utf8),
        ),
      "MANIFEST_STRING_LIMIT",
    );
  });

  it.each([
    "done-path",
    "escalate-path",
    "branch-fork-merge",
  ])("admits and replays the checked-in %s fixture sidecar", async (fixtureId) => {
    const payloadPath = path.join(fixturesDirectory, `${fixtureId}.golden.json`);
    const manifestPath = path.join(
      fixturesDirectory,
      `${fixtureId}.golden.manifest.v1.json`,
    );
    const [payloadBuffer, manifestJson] = await Promise.all([
      readFile(payloadPath),
      readFile(manifestPath, "utf8"),
    ]);
    const manifest = JSON.parse(manifestJson);
    const admission = fixtureLoader()(
      manifestJson,
      payloadBytesFor(manifest, Uint8Array.from(payloadBuffer).buffer),
    );
    const result = await replay.replayDialogue(
      admission.trace,
      (ports, options) => new core.DialogueScheduler(ports, options),
    );

    expect(result.actualRunSpecHash).toBe(admission.trace.runSpecHash);
    expect(result.actualVerbSequence).toEqual(admission.trace.verbSequence);
  });
});
