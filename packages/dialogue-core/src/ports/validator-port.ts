import type { ValidationSpec } from "../types/validation-spec.js";

export interface ValidationResult {
  ok: boolean;
  exitCode: number;
  output: string;
  durationMs: number;
}

export interface ValidatorPort {
  validate(spec: ValidationSpec): Promise<ValidationResult>;
}
