import type {
  BranchCondition,
  DialogueBranch,
  DialogueBranchPath,
  HandoffDescriptor,
} from "@dzupagent/dialogue-core";

import type { GoldenTraceDecodeContext } from "./golden-trace-decode-context.js";
import {
  optionalString,
  requiredString,
  requiredStringArray,
} from "./golden-trace-schema-helpers.js";

export function decodeHandoff(
  context: GoldenTraceDecodeContext,
  value: unknown,
  path: string,
  depth: number,
): HandoffDescriptor {
  return context.record(
    value,
    path,
    depth,
    ["fromParticipantId", "toParticipantId", "reason"],
    [],
    (record) => ({
      fromParticipantId: requiredString(
        context,
        record,
        "fromParticipantId",
        path,
        depth,
      ),
      toParticipantId: requiredString(
        context,
        record,
        "toParticipantId",
        path,
        depth,
      ),
      reason: requiredString(context, record, "reason", path, depth),
    }),
  );
}

export function decodeBranch(
  context: GoldenTraceDecodeContext,
  value: unknown,
  path: string,
  depth: number,
): DialogueBranch {
  return context.record(
    value,
    path,
    depth,
    ["id", "fromTurnId", "paths"],
    ["defaultPathId"],
    (record) => {
      const id = requiredString(context, record, "id", path, depth);
      const fromTurnId = requiredString(
        context,
        record,
        "fromTurnId",
        path,
        depth,
      );
      const paths = context.array(
        context.required(record, "paths", path),
        `${path}.paths`,
        depth + 1,
        (item, itemPath, itemDepth) =>
          decodeBranchPath(context, item, itemPath, itemDepth),
      );
      const defaultPathId = optionalString(
        context,
        record,
        "defaultPathId",
        path,
        depth,
      );
      return {
        id,
        fromTurnId,
        paths,
        ...(defaultPathId === undefined ? {} : { defaultPathId }),
      };
    },
  );
}

function decodeBranchPath(
  context: GoldenTraceDecodeContext,
  value: unknown,
  path: string,
  depth: number,
): DialogueBranchPath {
  return context.record(
    value,
    path,
    depth,
    ["id", "condition", "turnIds"],
    [],
    (record) => ({
      id: requiredString(context, record, "id", path, depth),
      condition: decodeBranchCondition(
        context,
        context.required(record, "condition", path),
        `${path}.condition`,
        depth + 1,
      ),
      turnIds: requiredStringArray(
        context,
        record,
        "turnIds",
        path,
        depth,
      ),
    }),
  );
}

function decodeBranchCondition(
  context: GoldenTraceDecodeContext,
  value: unknown,
  path: string,
  depth: number,
): BranchCondition {
  return context.record(
    value,
    path,
    depth,
    ["expression"],
    ["sourceTurnId"],
    (record) => {
      const expression = requiredString(
        context,
        record,
        "expression",
        path,
        depth,
      );
      const sourceTurnId = optionalString(
        context,
        record,
        "sourceTurnId",
        path,
        depth,
      );
      return {
        expression,
        ...(sourceTurnId === undefined ? {} : { sourceTurnId }),
      };
    },
  );
}
