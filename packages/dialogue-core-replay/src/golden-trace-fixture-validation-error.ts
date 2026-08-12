import { GOLDEN_TRACE_FIXTURE_MAX_DIAGNOSTIC_BYTES } from "./golden-trace-fixture-limits.js";

export type GoldenTraceFixtureValidationCode =
  | "MANIFEST_INVALID"
  | "MANIFEST_JSON_INVALID"
  | "MANIFEST_BYTES_LIMIT"
  | "MANIFEST_FILE_COUNT_LIMIT"
  | "MANIFEST_STRING_LIMIT"
  | "MANIFEST_DEPTH_LIMIT"
  | "MANIFEST_NODE_LIMIT"
  | "PRIVACY_DENIED"
  | "PAYLOAD_SET_MISMATCH"
  | "PAYLOAD_BYTES_LIMIT"
  | "PAYLOAD_BYTE_LENGTH_MISMATCH"
  | "PAYLOAD_DIGEST_MISMATCH"
  | "TRACE_INVALID"
  | "UNSAFE_INPUT";

export class GoldenTraceFixtureValidationError extends Error {
  constructor(
    readonly code: GoldenTraceFixtureValidationCode,
    readonly location: string,
  ) {
    super(`GoldenTrace fixture admission failed [${code}] at ${location}.`);
    this.name = "GoldenTraceFixtureValidationError";
  }
}

export function failGoldenTraceFixture(
  code: GoldenTraceFixtureValidationCode,
  location: string,
): never {
  const maxLocationBytes = GOLDEN_TRACE_FIXTURE_MAX_DIAGNOSTIC_BYTES - 96;
  const boundedLocation = boundUtf8(location, maxLocationBytes);
  throw new GoldenTraceFixtureValidationError(code, boundedLocation);
}

function boundUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }

  let end = Math.min(value.length, maxBytes - 3);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes - 3) {
    end -= 1;
  }
  return `${value.slice(0, end)}...`;
}
