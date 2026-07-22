import type { SpawnNode } from "@dzupagent/flow-ast";

import { DSL_ERROR } from "../errors.js";
import {
  COMMON_NODE_KEYS,
  normalizeCommonNodeFields,
  normalizeObject,
  reportUnsupportedFields,
} from "../normalize-value-helpers.js";
import type { DslDiagnostic } from "../types.js";

const SPAWN_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  "templateRef",
  "template_ref",
  "input",
  "waitForCompletion",
  "wait_for_completion",
]);

export function normalizeSpawn(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[]
): SpawnNode {
  reportUnsupportedFields(raw, SPAWN_KEYS, path, diagnostics);
  const base = normalizeCommonNodeFields(raw, path, diagnostics);

  const templateRef =
    typeof raw.templateRef === "string"
      ? raw.templateRef
      : typeof raw.template_ref === "string"
      ? raw.template_ref
      : "";

  const node: SpawnNode = {
    type: "spawn",
    ...base,
    templateRef,
  };

  if (templateRef.length === 0) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: "spawn.templateRef is required",
      path: `${path}.templateRef`,
    });
  }

  const input = normalizeObject(raw.input, `${path}.input`, diagnostics);
  if (input !== undefined) node.input = input;

  const waitRaw = raw.waitForCompletion ?? raw.wait_for_completion;
  if (waitRaw !== undefined) {
    if (typeof waitRaw === "boolean") {
      node.waitForCompletion = waitRaw;
    } else {
      diagnostics.push({
        phase: "normalize",
        code: DSL_ERROR.INVALID_NODE_SHAPE,
        message: "spawn.waitForCompletion must be a boolean",
        path: `${path}.waitForCompletion`,
      });
    }
  }

  return node;
}
