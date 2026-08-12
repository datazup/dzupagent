import type { ValidationSpec } from "@dzupagent/dialogue-core";

import type { GoldenTraceDecodeContext } from "./golden-trace-decode-context.js";
import {
  optionalNumber,
  optionalString,
  optionalStringArray,
  requiredString,
} from "./golden-trace-schema-helpers.js";

const SANDBOX_POLICIES = [
  "none",
  "read-only",
  "workspace-write",
] as const;

export function decodeValidationSpec(
  context: GoldenTraceDecodeContext,
  value: unknown,
  path: string,
  depth: number,
): ValidationSpec {
  return context.record(
    value,
    path,
    depth,
    ["commandId", "cwdRoot"],
    [
      "args",
      "timeoutMs",
      "env",
      "maxOutputBytes",
      "tenantScope",
      "sandboxPolicy",
    ],
    (record) => {
      const commandId = requiredString(
        context,
        record,
        "commandId",
        path,
        depth,
      );
      const cwdRoot = requiredString(
        context,
        record,
        "cwdRoot",
        path,
        depth,
      );
      const args = optionalStringArray(
        context,
        record,
        "args",
        path,
        depth,
      );
      const timeoutMs = optionalNumber(
        context,
        record,
        "timeoutMs",
        path,
        depth,
        "non-negative-integer",
      );
      const env = record.has("env")
        ? context.stringRecord(record.get("env"), `${path}.env`, depth + 1)
        : undefined;
      const maxOutputBytes = optionalNumber(
        context,
        record,
        "maxOutputBytes",
        path,
        depth,
        "non-negative-integer",
      );
      const tenantScope = optionalString(
        context,
        record,
        "tenantScope",
        path,
        depth,
      );
      const sandboxPolicy = record.has("sandboxPolicy")
        ? context.literal(
            record.get("sandboxPolicy"),
            `${path}.sandboxPolicy`,
            depth + 1,
            SANDBOX_POLICIES,
          )
        : undefined;

      return {
        commandId,
        cwdRoot,
        ...(args === undefined ? {} : { args }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(env === undefined ? {} : { env }),
        ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
        ...(tenantScope === undefined ? {} : { tenantScope }),
        ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
      };
    },
  );
}
