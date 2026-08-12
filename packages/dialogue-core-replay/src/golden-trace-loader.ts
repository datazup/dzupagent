import type { GoldenTrace } from "./golden-trace-contract.js";
import { decodeGoldenTrace } from "./golden-trace-decoder.js";
import { fail } from "./golden-trace-decode-context.js";
import { GOLDEN_TRACE_MAX_ENCODED_BYTES } from "./golden-trace-limits.js";

export function validateGoldenTrace(value: unknown): GoldenTrace {
  return decodeGoldenTrace(value);
}

export function loadGoldenTrace(json: string): GoldenTrace {
  if (typeof json !== "string") {
    fail("TYPE_STRING", "$");
  }
  if (Buffer.byteLength(json, "utf8") > GOLDEN_TRACE_MAX_ENCODED_BYTES) {
    fail("MAX_ENCODED_BYTES", "$");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    fail("JSON_PARSE", "$");
  }
  return validateGoldenTrace(parsed);
}
