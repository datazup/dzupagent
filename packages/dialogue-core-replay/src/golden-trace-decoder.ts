import type { GoldenTrace } from "./golden-trace-contract.js";
import {
  fail,
  GoldenTraceDecodeContext,
} from "./golden-trace-decode-context.js";
import { decodeGoldenTraceTurn } from "./golden-trace-recording-decoder.js";
import { decodeRunSpec, decodeTurnVerb } from "./golden-trace-run-spec-decoder.js";
import { GoldenTraceValidationError } from "./golden-trace-validation-error.js";

export function decodeGoldenTrace(value: unknown): GoldenTrace {
  try {
    const context = new GoldenTraceDecodeContext();
    const trace = context.record(
      value,
      "$",
      0,
      ["runId", "runSpecHash", "verbSequence", "runSpec", "turns"],
      [],
      (record) => ({
        runId: context.string(
          context.required(record, "runId", "$"),
          "$.runId",
          1,
          { nonEmpty: true },
        ),
        runSpecHash: context.runSpecHash(
          context.required(record, "runSpecHash", "$"),
          "$.runSpecHash",
          1,
        ),
        verbSequence: context.array(
          context.required(record, "verbSequence", "$"),
          "$.verbSequence",
          1,
          (item, itemPath, itemDepth) =>
            decodeTurnVerb(context, item, itemPath, itemDepth),
        ),
        runSpec: decodeRunSpec(
          context,
          context.required(record, "runSpec", "$"),
          "$.runSpec",
          1,
        ),
        turns: context.array(
          context.required(record, "turns", "$"),
          "$.turns",
          1,
          (item, itemPath, itemDepth) =>
            decodeGoldenTraceTurn(context, item, itemPath, itemDepth),
        ),
      }),
    );
    context.assertEncodedSize(trace);
    return trace;
  } catch (error) {
    if (error instanceof GoldenTraceValidationError) {
      throw error;
    }
    fail("UNSAFE_INPUT", "$");
  }
}
