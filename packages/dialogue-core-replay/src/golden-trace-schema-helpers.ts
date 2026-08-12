import type {
  ExactRecord,
  GoldenTraceDecodeContext,
} from "./golden-trace-decode-context.js";

export type GoldenTraceValueDecoder<T> = (
  context: GoldenTraceDecodeContext,
  value: unknown,
  path: string,
  depth: number,
) => T;

export function requiredString(
  context: GoldenTraceDecodeContext,
  record: ExactRecord,
  key: string,
  path: string,
  depth: number,
): string {
  return context.string(
    context.required(record, key, path),
    `${path}.${key}`,
    depth + 1,
  );
}

export function optionalString(
  context: GoldenTraceDecodeContext,
  record: ExactRecord,
  key: string,
  path: string,
  depth: number,
): string | undefined {
  return record.has(key)
    ? context.string(record.get(key), `${path}.${key}`, depth + 1)
    : undefined;
}

export function optionalBoolean(
  context: GoldenTraceDecodeContext,
  record: ExactRecord,
  key: string,
  path: string,
  depth: number,
): boolean | undefined {
  return record.has(key)
    ? context.boolean(record.get(key), `${path}.${key}`, depth + 1)
    : undefined;
}

export function optionalNumber(
  context: GoldenTraceDecodeContext,
  record: ExactRecord,
  key: string,
  path: string,
  depth: number,
  constraint:
    | "finite"
    | "integer"
    | "non-negative"
    | "non-negative-integer",
): number | undefined {
  return record.has(key)
    ? context.number(
        record.get(key),
        `${path}.${key}`,
        depth + 1,
        constraint,
      )
    : undefined;
}

export function requiredStringArray(
  context: GoldenTraceDecodeContext,
  record: ExactRecord,
  key: string,
  path: string,
  depth: number,
): string[] {
  return context.array(
    context.required(record, key, path),
    `${path}.${key}`,
    depth + 1,
    (item, itemPath, itemDepth) =>
      context.string(item, itemPath, itemDepth),
  );
}

export function optionalStringArray(
  context: GoldenTraceDecodeContext,
  record: ExactRecord,
  key: string,
  path: string,
  depth: number,
): string[] | undefined {
  return record.has(key)
    ? context.array(
        record.get(key),
        `${path}.${key}`,
        depth + 1,
        (item, itemPath, itemDepth) =>
          context.string(item, itemPath, itemDepth),
      )
    : undefined;
}

export function optionalArray<T>(
  context: GoldenTraceDecodeContext,
  record: ExactRecord,
  key: string,
  path: string,
  depth: number,
  decoder: GoldenTraceValueDecoder<T>,
): T[] | undefined {
  return record.has(key)
    ? context.array(
        record.get(key),
        `${path}.${key}`,
        depth + 1,
        (item, itemPath, itemDepth) =>
          decoder(context, item, itemPath, itemDepth),
      )
    : undefined;
}

export function optionalValue<T>(
  context: GoldenTraceDecodeContext,
  record: ExactRecord,
  key: string,
  path: string,
  depth: number,
  decoder: GoldenTraceValueDecoder<T>,
): T | undefined {
  return record.has(key)
    ? decoder(context, record.get(key), `${path}.${key}`, depth + 1)
    : undefined;
}
