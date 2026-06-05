import { isDeepStrictEqual } from "node:util";

import type {
  ValidationResult,
  ValidationSpec,
  ValidatorPort,
} from "@dzupagent/dialogue-core";

import { ReplayExhaustedError } from "./errors.js";

export interface RecordedValidatorCall {
  readonly spec?: ValidationSpec;
  readonly result: ValidationResult;
}

export class RecordedValidatorPort implements ValidatorPort {
  private callIndex = 0;

  constructor(private readonly calls: readonly RecordedValidatorCall[]) {}

  get dialogueReplayRecordedPortCallCount(): number {
    return this.callIndex;
  }

  async validate(spec: ValidationSpec): Promise<ValidationResult> {
    const callIndex = this.callIndex;
    const call = this.calls[callIndex];
    if (call === undefined) {
      throw new ReplayExhaustedError("validator", "validate", callIndex);
    }

    this.callIndex += 1;
    if (call.spec !== undefined && !isDeepStrictEqual(spec, call.spec)) {
      throw new Error(
        `Recorded validator spec mismatch at call index ${callIndex}.`,
      );
    }

    return { ...call.result };
  }
}
