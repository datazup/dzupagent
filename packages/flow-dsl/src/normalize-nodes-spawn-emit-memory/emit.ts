import type { EmitNode } from "@dzupagent/flow-ast";

import { DSL_ERROR } from "../errors.js";
import {
  COMMON_NODE_KEYS,
  isFlowValue,
  normalizeCommonNodeFields,
  normalizeObject,
  reportUnsupportedFields,
} from "../normalize-value-helpers.js";
import type { DslDiagnostic } from "../types.js";

const EMIT_KEYS = new Set<string>([...COMMON_NODE_KEYS, "event", "payload"]);

export function normalizeEmit(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[]
): EmitNode {
  reportUnsupportedFields(raw, EMIT_KEYS, path, diagnostics);
  const base = normalizeCommonNodeFields(raw, path, diagnostics);

  const event = typeof raw.event === "string" ? raw.event : "";
  const node: EmitNode = {
    type: "emit",
    ...base,
    event,
  };

  if (event.length === 0) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: "emit.event is required",
      path: `${path}.event`,
    });
  }

  if (raw.payload !== undefined) {
    const payload = normalizeObject(
      raw.payload,
      `${path}.payload`,
      diagnostics
    );
    if (payload !== undefined) {
      const safePayload: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(payload)) {
        if (isFlowValue(v)) {
          safePayload[k] = v;
        } else {
          diagnostics.push({
            phase: "normalize",
            code: DSL_ERROR.INVALID_NODE_SHAPE,
            message: `emit.payload.${k} must be a JSON-compatible value`,
            path: `${path}.payload.${k}`,
          });
        }
      }
      node.payload = safePayload as Record<string, unknown>;
    }
  }

  return node;
}
