import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import type {
  GoldenTraceFixtureAdmissionV1,
  GoldenTraceFixturePayloadV1,
} from "./golden-trace-fixture-contract.js";
import { GoldenTraceFixtureDecodeContext } from "./golden-trace-fixture-decode-context.js";
import { validateGoldenTraceFixtureManifestV1 } from "./golden-trace-fixture-decoder.js";
import {
  GOLDEN_TRACE_FIXTURE_MAX_AGGREGATE_BYTES,
  GOLDEN_TRACE_FIXTURE_MAX_FILES,
  GOLDEN_TRACE_FIXTURE_MAX_MANIFEST_BYTES,
  GOLDEN_TRACE_FIXTURE_MAX_PATH_BYTES,
  GOLDEN_TRACE_FIXTURE_MAX_PAYLOAD_BYTES,
} from "./golden-trace-fixture-limits.js";
import {
  failGoldenTraceFixture,
  GoldenTraceFixtureValidationError,
} from "./golden-trace-fixture-validation-error.js";
import { loadGoldenTrace } from "./golden-trace-loader.js";
import { GoldenTraceValidationError } from "./golden-trace-validation-error.js";

export function loadGoldenTraceFixtureV1(
  manifestJson: string,
  payloads: unknown,
): GoldenTraceFixtureAdmissionV1 {
  try {
    if (typeof manifestJson !== "string") {
      failGoldenTraceFixture("MANIFEST_INVALID", "$manifest");
    }
    if (
      Buffer.byteLength(manifestJson, "utf8") >
      GOLDEN_TRACE_FIXTURE_MAX_MANIFEST_BYTES
    ) {
      failGoldenTraceFixture("MANIFEST_BYTES_LIMIT", "$manifest");
    }

    let manifestValue: unknown;
    try {
      manifestValue = JSON.parse(manifestJson);
    } catch {
      failGoldenTraceFixture("MANIFEST_JSON_INVALID", "$manifest");
    }
    const manifest = validateGoldenTraceFixtureManifestV1(manifestValue);
    const decodedPayloads = decodePayloadSet(payloads);
    if (decodedPayloads.length !== manifest.files.length) {
      failGoldenTraceFixture("PAYLOAD_SET_MISMATCH", "$payloads");
    }

    const file = manifest.files[0];
    const payload = decodedPayloads[0];
    if (file === undefined || payload === undefined || payload.path !== file.path) {
      failGoldenTraceFixture("PAYLOAD_SET_MISMATCH", "$payloads[0].path");
    }
    const rawByteLength = payload.bytes.byteLength;
    if (
      rawByteLength > GOLDEN_TRACE_FIXTURE_MAX_PAYLOAD_BYTES ||
      rawByteLength > GOLDEN_TRACE_FIXTURE_MAX_AGGREGATE_BYTES
    ) {
      failGoldenTraceFixture("PAYLOAD_BYTES_LIMIT", "$payloads[0].bytes");
    }
    if (rawByteLength !== file.byteLength) {
      failGoldenTraceFixture(
        "PAYLOAD_BYTE_LENGTH_MISMATCH",
        "$payloads[0].bytes",
      );
    }
    const digest = `sha256:${createHash("sha256")
      .update(new Uint8Array(payload.bytes))
      .digest("hex")}`;
    if (digest !== file.sha256) {
      failGoldenTraceFixture("PAYLOAD_DIGEST_MISMATCH", "$payloads[0].bytes");
    }

    let utf8: string;
    try {
      utf8 = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(payload.bytes);
    } catch {
      failGoldenTraceFixture("TRACE_INVALID", "$payloads[0].bytes");
    }
    let trace;
    try {
      trace = loadGoldenTrace(utf8);
    } catch (error) {
      if (error instanceof GoldenTraceValidationError) {
        failGoldenTraceFixture("TRACE_INVALID", "$payloads[0].bytes");
      }
      throw error;
    }
    return Object.freeze({ manifest, trace });
  } catch (error) {
    if (error instanceof GoldenTraceFixtureValidationError) {
      throw error;
    }
    failGoldenTraceFixture("UNSAFE_INPUT", "$fixture");
  }
}

function decodePayloadSet(value: unknown): readonly GoldenTraceFixturePayloadV1[] {
  try {
    const context = new GoldenTraceFixtureDecodeContext();
    return context.array(
      value,
      "$payloads",
      0,
      (item, location, depth) =>
        context.record(
          item,
          location,
          depth,
          ["path", "bytes"],
          (record) => ({
            path: context.string(
              context.required(record, "path", location),
              `${location}.path`,
              depth + 1,
              {
                nonEmpty: true,
                maxBytes: GOLDEN_TRACE_FIXTURE_MAX_PATH_BYTES,
              },
            ),
            bytes: context.bytes(
              context.required(record, "bytes", location),
              `${location}.bytes`,
              depth + 1,
            ),
          }),
        ),
      {
        minItems: GOLDEN_TRACE_FIXTURE_MAX_FILES,
        maxItems: GOLDEN_TRACE_FIXTURE_MAX_FILES,
        lengthCode: "PAYLOAD_SET_MISMATCH",
      },
    );
  } catch (error) {
    if (error instanceof GoldenTraceFixtureValidationError) {
      throw error;
    }
    failGoldenTraceFixture("UNSAFE_INPUT", "$payloads");
  }
}
