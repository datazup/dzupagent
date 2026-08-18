import type {
  RecursiveScopeContractIssue,
  RecursiveScopedCommitBindingV1,
  RecursiveScopedCommitV1,
  RecursiveScopedFrameBindingV1,
  RecursiveScopedFrameV1,
  RecursiveScopedMergeV1,
  RecursiveScopedMergeBindingV1,
} from "./types.js";
import { canonicalJson } from "./internals.js";
import {
  formatIssues,
  validateRecursiveScopedFrameBindingV1,
  validateRecursiveScopedFrameV1,
} from "./frame.js";
import {
  validateRecursiveScopedCommitBindingV1,
  validateRecursiveScopedCommitV1,
  validateRecursiveScopedMergeBindingV1,
  validateRecursiveScopedMergeV1,
} from "./commit.js";

export function serializeRecursiveScopedFrameV1(
  value: RecursiveScopedFrameV1,
): string {
  const validation = validateRecursiveScopedFrameV1(value);
  if (!validation.valid) {
    throw new Error(
      formatIssues("Recursive scoped-frame serialization failed", validation.issues),
    );
  }
  return canonicalJson(validation.value);
}

/**
 * Restores an untrusted frame only when it matches the complete binding held by
 * the definition-owning parent. Runtime dispatchers must consume this API (or
 * an equivalently strict host adapter), never a raw JSON parse.
 */
export function deserializeRecursiveScopedFrameV1(
  json: string,
  expected: RecursiveScopedFrameBindingV1,
): RecursiveScopedFrameV1 {
  return parseRecursiveScopedFrameV1(parseJson(json, "frame"), expected);
}

export function parseRecursiveScopedFrameV1(
  value: unknown,
  expected: RecursiveScopedFrameBindingV1,
): RecursiveScopedFrameV1 {
  const structural = validateRecursiveScopedFrameV1(value);
  if (!structural.valid) {
    throw new Error(
      formatIssues("Recursive scoped-frame parsing failed", structural.issues),
    );
  }
  const binding = validateRecursiveScopedFrameBindingV1(structural.value, expected);
  if (!binding.valid) {
    throw new Error(
      formatIssues("Recursive scoped-frame binding failed", binding.issues),
    );
  }
  return binding.value;
}

export function serializeRecursiveScopedCommitV1(
  value: RecursiveScopedCommitV1,
): string {
  const validation = validateRecursiveScopedCommitV1(value);
  if (!validation.valid) {
    throw new Error(
      formatIssues("Recursive scoped-commit serialization failed", validation.issues),
    );
  }
  return canonicalJson(validation.value);
}

export function deserializeRecursiveScopedCommitV1(
  json: string,
  expected: RecursiveScopedCommitBindingV1,
): RecursiveScopedCommitV1 {
  return parseRecursiveScopedCommitV1(parseJson(json, "commit"), expected);
}

export function parseRecursiveScopedCommitV1(
  value: unknown,
  expected: RecursiveScopedCommitBindingV1,
): RecursiveScopedCommitV1 {
  const structural = validateRecursiveScopedCommitV1(value);
  if (!structural.valid) {
    throw new Error(
      formatIssues("Recursive scoped-commit parsing failed", structural.issues),
    );
  }
  const binding = validateRecursiveScopedCommitBindingV1(structural.value, expected);
  if (!binding.valid) {
    throw new Error(
      formatIssues("Recursive scoped-commit binding failed", binding.issues),
    );
  }
  return binding.value;
}

export function serializeRecursiveScopedMergeV1(
  value: RecursiveScopedMergeV1,
): string {
  const validation = validateRecursiveScopedMergeV1(value);
  if (!validation.valid) {
    throw new Error(
      formatIssues("Recursive scoped-merge serialization failed", validation.issues),
    );
  }
  return canonicalJson(validation.value);
}

export function deserializeRecursiveScopedMergeV1(
  json: string,
  expected: RecursiveScopedMergeBindingV1,
): RecursiveScopedMergeV1 {
  return parseRecursiveScopedMergeV1(parseJson(json, "merge"), expected);
}

export function parseRecursiveScopedMergeV1(
  value: unknown,
  expected: RecursiveScopedMergeBindingV1,
): RecursiveScopedMergeV1 {
  const structural = validateRecursiveScopedMergeV1(value);
  if (!structural.valid) {
    throw new Error(
      formatIssues("Recursive scoped-merge parsing failed", structural.issues),
    );
  }
  const binding = validateRecursiveScopedMergeBindingV1(structural.value, expected);
  if (!binding.valid) {
    throw new Error(
      formatIssues("Recursive scoped-merge binding failed", binding.issues),
    );
  }
  return binding.value;
}

function parseJson(value: string, kind: "frame" | "commit" | "merge"): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    const issue: RecursiveScopeContractIssue = {
      code: "INVALID_TYPE",
      path: "$",
      message: "Input is not valid JSON.",
    };
    throw new Error(
      formatIssues(`Recursive scoped-${kind} deserialization failed`, [issue]),
    );
  }
}
