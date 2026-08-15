import { validatePipelinePendingInteractionV1 } from "./record-validation.js";
import { validatePipelineInteractionResumeV1 } from "./resume-validation.js";
import { validatePipelineInteractionSpecV1 } from "./spec-validation.js";
import type {
  PipelineInteractionResumeV1,
  PipelineInteractionSpecV1,
  PipelineInteractionValidationResult,
  PipelinePendingInteractionV1,
} from "./types.js";

export function serializePipelineInteractionSpecV1(
  value: PipelineInteractionSpecV1,
): string {
  return serializeValidated(value, validatePipelineInteractionSpecV1);
}

export function deserializePipelineInteractionSpecV1(
  json: string,
): PipelineInteractionSpecV1 {
  return deserializeValidated(json, validatePipelineInteractionSpecV1);
}

export function serializePipelinePendingInteractionV1(
  value: PipelinePendingInteractionV1,
): string {
  return serializeValidated(value, validatePipelinePendingInteractionV1);
}

export function deserializePipelinePendingInteractionV1(
  json: string,
): PipelinePendingInteractionV1 {
  return deserializeValidated(json, validatePipelinePendingInteractionV1);
}

export function serializePipelineInteractionResumeV1(
  value: PipelineInteractionResumeV1,
): string {
  return serializeValidated(value, validatePipelineInteractionResumeV1);
}

export function deserializePipelineInteractionResumeV1(
  json: string,
): PipelineInteractionResumeV1 {
  return deserializeValidated(json, validatePipelineInteractionResumeV1);
}

function serializeValidated<T>(
  value: T,
  validator: (candidate: unknown) => PipelineInteractionValidationResult<T>,
): string {
  const result = validator(value);
  if (!result.valid) {
    throw new Error(
      `Pipeline interaction serialization failed: ${result.issues
        .map((entry) => `${entry.path}: ${entry.message}`)
        .join("; ")}`,
    );
  }
  return JSON.stringify(result.value);
}

function deserializeValidated<T>(
  json: string,
  validator: (candidate: unknown) => PipelineInteractionValidationResult<T>,
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Pipeline interaction deserialization failed: invalid JSON.");
  }
  const result = validator(parsed);
  if (!result.valid) {
    throw new Error(
      `Pipeline interaction deserialization failed: ${result.issues
        .map((entry) => `${entry.path}: ${entry.message}`)
        .join("; ")}`,
    );
  }
  return result.value;
}
