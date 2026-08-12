import type {
  ValidationResult,
  WorkspaceEffect,
  WorkspaceSnapshot,
} from "@dzupagent/dialogue-core";

import type { GoldenTraceTurn } from "./golden-trace-contract.js";
import { decodeRecordedAgentCall } from "./golden-trace-agent-decoder.js";
import type { GoldenTraceDecodeContext } from "./golden-trace-decode-context.js";
import { decodeTurnVerb } from "./golden-trace-run-spec-decoder.js";
import {
  optionalValue,
  requiredString,
  requiredStringArray,
} from "./golden-trace-schema-helpers.js";
import { decodeValidationSpec } from "./golden-trace-validation-spec-decoder.js";
import type { RecordedValidatorCall } from "./recorded-validator-port.js";
import type { RecordedWorkspaceEffectCapture } from "./recorded-workspace-port.js";

const APPLY_STATUSES = [
  "clean",
  "partial",
  "failed",
  "no-op",
] as const;

export function decodeGoldenTraceTurn(
  context: GoldenTraceDecodeContext,
  value: unknown,
  path: string,
  depth: number,
): GoldenTraceTurn {
  return context.record(
    value,
    path,
    depth,
    [
      "turnId",
      "verb",
      "agentCalls",
      "validatorCalls",
      "workspaceSnapshots",
      "workspaceEffects",
    ],
    [],
    (record) => ({
      turnId: requiredString(context, record, "turnId", path, depth),
      verb: decodeTurnVerb(
        context,
        context.required(record, "verb", path),
        `${path}.verb`,
        depth + 1,
      ),
      agentCalls: context.array(
        context.required(record, "agentCalls", path),
        `${path}.agentCalls`,
        depth + 1,
        (item, itemPath, itemDepth) =>
          decodeRecordedAgentCall(context, item, itemPath, itemDepth),
      ),
      validatorCalls: context.array(
        context.required(record, "validatorCalls", path),
        `${path}.validatorCalls`,
        depth + 1,
        (item, itemPath, itemDepth) =>
          decodeRecordedValidatorCall(context, item, itemPath, itemDepth),
      ),
      workspaceSnapshots: context.array(
        context.required(record, "workspaceSnapshots", path),
        `${path}.workspaceSnapshots`,
        depth + 1,
        (item, itemPath, itemDepth) =>
          decodeWorkspaceSnapshot(context, item, itemPath, itemDepth),
      ),
      workspaceEffects: context.array(
        context.required(record, "workspaceEffects", path),
        `${path}.workspaceEffects`,
        depth + 1,
        (item, itemPath, itemDepth) =>
          decodeWorkspaceEffectCapture(context, item, itemPath, itemDepth),
      ),
    }),
  );
}

function decodeRecordedValidatorCall(
  context: GoldenTraceDecodeContext,
  value: unknown,
  path: string,
  depth: number,
): RecordedValidatorCall {
  return context.record(
    value,
    path,
    depth,
    ["result"],
    ["spec"],
    (record) => {
      const spec = optionalValue(
        context,
        record,
        "spec",
        path,
        depth,
        decodeValidationSpec,
      );
      const result = decodeValidationResult(
        context,
        context.required(record, "result", path),
        `${path}.result`,
        depth + 1,
      );
      return {
        ...(spec === undefined ? {} : { spec }),
        result,
      };
    },
  );
}

function decodeValidationResult(
  context: GoldenTraceDecodeContext,
  value: unknown,
  path: string,
  depth: number,
): ValidationResult {
  return context.record(
    value,
    path,
    depth,
    ["ok", "exitCode", "output", "durationMs"],
    [],
    (record) => ({
      ok: context.boolean(
        context.required(record, "ok", path),
        `${path}.ok`,
        depth + 1,
      ),
      exitCode: context.number(
        context.required(record, "exitCode", path),
        `${path}.exitCode`,
        depth + 1,
        "integer",
      ),
      output: requiredString(context, record, "output", path, depth),
      durationMs: context.number(
        context.required(record, "durationMs", path),
        `${path}.durationMs`,
        depth + 1,
        "non-negative-integer",
      ),
    }),
  );
}

function decodeWorkspaceSnapshot(
  context: GoldenTraceDecodeContext,
  value: unknown,
  path: string,
  depth: number,
): WorkspaceSnapshot {
  return context.record(
    value,
    path,
    depth,
    ["baseRevision", "treeHash"],
    [],
    (record) => ({
      baseRevision: requiredString(
        context,
        record,
        "baseRevision",
        path,
        depth,
      ),
      treeHash: requiredString(
        context,
        record,
        "treeHash",
        path,
        depth,
      ),
    }),
  );
}

function decodeWorkspaceEffectCapture(
  context: GoldenTraceDecodeContext,
  value: unknown,
  path: string,
  depth: number,
): RecordedWorkspaceEffectCapture {
  return context.record(
    value,
    path,
    depth,
    ["effect"],
    ["beforeSnapshot"],
    (record) => {
      const beforeSnapshot = optionalValue(
        context,
        record,
        "beforeSnapshot",
        path,
        depth,
        decodeWorkspaceSnapshot,
      );
      const effect = decodeWorkspaceEffect(
        context,
        context.required(record, "effect", path),
        `${path}.effect`,
        depth + 1,
      );
      return {
        ...(beforeSnapshot === undefined ? {} : { beforeSnapshot }),
        effect,
      };
    },
  );
}

function decodeWorkspaceEffect(
  context: GoldenTraceDecodeContext,
  value: unknown,
  path: string,
  depth: number,
): WorkspaceEffect {
  return context.record(
    value,
    path,
    depth,
    ["diff", "changedFiles", "postRevision", "treeHash", "applyStatus"],
    [],
    (record) => ({
      diff: requiredString(context, record, "diff", path, depth),
      changedFiles: requiredStringArray(
        context,
        record,
        "changedFiles",
        path,
        depth,
      ),
      postRevision: requiredString(
        context,
        record,
        "postRevision",
        path,
        depth,
      ),
      treeHash: requiredString(
        context,
        record,
        "treeHash",
        path,
        depth,
      ),
      applyStatus: context.literal(
        context.required(record, "applyStatus", path),
        `${path}.applyStatus`,
        depth + 1,
        APPLY_STATUSES,
      ),
    }),
  );
}
