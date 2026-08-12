export type ReplayRecordingMethod =
  | "agent.run"
  | "validator.validate"
  | "workspace.snapshot"
  | "workspace.captureEffect";

export type ReplayAssertionCode =
  | "ASSERTION_FAILED"
  | "RUN_SPEC_HASH_MISMATCH"
  | "VERB_SEQUENCE_MISMATCH"
  | "RECORDING_OVERRUN"
  | "RECORDING_UNDERRUN"
  | "RECORDING_MISMATCH"
  | "EVENT_ORDER_MISMATCH"
  | "EVENT_IDENTITY_MISMATCH"
  | "EVENT_OUTCOME_MISMATCH"
  | "GROUP_COUNT_MISMATCH";

export interface ReplayAssertionDetails {
  readonly code?: ReplayAssertionCode;
  readonly groupIndex?: number;
  readonly methodName?: ReplayRecordingMethod;
  readonly expectedCount?: number;
  readonly actualCount?: number;
}

const MAX_DIAGNOSTIC_BYTES = 256;
const TRUNCATION_SUFFIX = "...";

export class ReplayAssertionError extends Error {
  readonly code: ReplayAssertionCode;
  readonly groupIndex: number | undefined;
  readonly methodName: ReplayRecordingMethod | undefined;
  readonly expectedCount: number | undefined;
  readonly actualCount: number | undefined;

  constructor(message: string, details: ReplayAssertionDetails = {}) {
    super(boundDiagnostic(message));
    this.name = "ReplayAssertionError";
    this.code = details.code ?? "ASSERTION_FAILED";
    this.groupIndex = details.groupIndex;
    this.methodName = details.methodName;
    this.expectedCount = details.expectedCount;
    this.actualCount = details.actualCount;
  }
}

function boundDiagnostic(message: string): string {
  if (Buffer.byteLength(message, "utf8") <= MAX_DIAGNOSTIC_BYTES) {
    return message;
  }

  const byteBudget =
    MAX_DIAGNOSTIC_BYTES - Buffer.byteLength(TRUNCATION_SUFFIX, "utf8");
  let bytes = 0;
  let bounded = "";

  for (const character of message) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > byteBudget) {
      break;
    }
    bounded += character;
    bytes += characterBytes;
  }

  return `${bounded}${TRUNCATION_SUFFIX}`;
}
