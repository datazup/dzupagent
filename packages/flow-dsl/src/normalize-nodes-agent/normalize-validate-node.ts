/**
 * DSL normalization for the `validate` node (dzupflow/v1alpha-agent).
 *
 * Requires either a `ref` or a non-empty `commands` array; shares the
 * `normalizeCommands` helper with the `agent` node's validation field. Shape
 * constraints must agree with `@dzupagent/flow-ast`'s `parse`/`validate`.
 */

import type { ValidateNode } from "@dzupagent/flow-ast";

import { DSL_ERROR } from "../errors.js";
import {
  COMMON_NODE_KEYS,
  isPlainObject,
  normalizeCommonNodeFields,
  reportUnsupportedFields,
} from "../normalize-value-helpers.js";
import type { DslDiagnostic } from "../types.js";
import { normalizeCommands } from "./agent-validation-policy-fields.js";

const VALIDATE_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  "ref",
  "commands",
  "repair",
]);

export function normalizeValidate(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[]
): ValidateNode {
  reportUnsupportedFields(raw, VALIDATE_KEYS, path, diagnostics);
  const base = normalizeCommonNodeFields(raw, path, diagnostics);

  const ref =
    typeof raw.ref === "string" && raw.ref.length > 0 ? raw.ref : undefined;
  const commands = normalizeCommands(
    raw.commands,
    `${path}.commands`,
    diagnostics,
    false
  );

  if (ref === undefined && (commands === undefined || commands.length === 0)) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message:
        "validate node requires either `ref` or a non-empty `commands` array",
      path,
    });
  }

  const node: ValidateNode = { type: "validate", ...base };
  if (ref !== undefined) node.ref = ref;
  if (commands !== undefined) node.commands = commands;

  if (raw.repair !== undefined) {
    if (!isPlainObject(raw.repair)) {
      diagnostics.push({
        phase: "normalize",
        code: DSL_ERROR.INVALID_NODE_SHAPE,
        message: "validate.repair must be an object",
        path: `${path}.repair`,
      });
    } else {
      const max = raw.repair.maxAttempts;
      if (typeof max !== "number" || max < 0) {
        diagnostics.push({
          phase: "normalize",
          code: DSL_ERROR.MISSING_REQUIRED_FIELD,
          message:
            "validate.repair.maxAttempts is required (non-negative number)",
          path: `${path}.repair.maxAttempts`,
        });
      } else {
        const repair: NonNullable<ValidateNode["repair"]> = {
          maxAttempts: max,
        };
        const onFailure = raw.repair.onFailure;
        if (onFailure === "retry-prior-agent" || onFailure === "stop") {
          repair.onFailure = onFailure;
        } else if (onFailure !== undefined) {
          diagnostics.push({
            phase: "normalize",
            code: DSL_ERROR.INVALID_ENUM_VALUE,
            message:
              'validate.repair.onFailure must be "retry-prior-agent" or "stop"',
            path: `${path}.repair.onFailure`,
          });
        }
        node.repair = repair;
      }
    }
  }

  return node;
}
