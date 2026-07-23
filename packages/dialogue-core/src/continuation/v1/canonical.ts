import { createHash } from "node:crypto";

import type { ContinuationHashV1 } from "./types.js";

export function canonicalizeContinuationValueV1(value: unknown): string {
  return canonicalizeValue(value);
}

export function hashContinuationValueV1(
  value: unknown
): ContinuationHashV1 {
  const canonical = canonicalizeContinuationValueV1(value);
  const digest = createHash("sha256").update(canonical).digest("hex");

  return `sha256:${digest}`;
}

function canonicalizeValue(value: unknown): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(
          "Continuation canonicalization requires finite JSON numbers."
        );
      }
      return JSON.stringify(value);
    case "object":
      if (Array.isArray(value)) {
        const items: string[] = [];
        for (let index = 0; index < value.length; index += 1) {
          if (!(index in value)) {
            throw new TypeError(
              "Continuation canonicalization does not accept sparse arrays."
            );
          }
          items.push(canonicalizeValue(value[index]));
        }
        return `[${items.join(",")}]`;
      }
      return canonicalizeObject(value);
    default:
      throw new TypeError(
        "Continuation canonicalization accepts JSON-safe values only."
      );
  }
}

function canonicalizeObject(value: object): string {
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(
      "Continuation canonicalization accepts plain JSON objects only."
    );
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(
      "Continuation canonicalization does not accept symbol fields."
    );
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const fields = keys.map((key) => {
    const field = record[key];
    if (field === undefined) {
      throw new TypeError(
        "Continuation canonicalization does not accept undefined fields."
      );
    }

    return `${JSON.stringify(key)}:${canonicalizeValue(field)}`;
  });

  return `{${fields.join(",")}}`;
}
