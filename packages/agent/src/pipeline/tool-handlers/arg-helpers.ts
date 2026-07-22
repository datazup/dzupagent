import { ForgeError } from "@dzupagent/core/events";

import type { RuntimeZodLikeSchema } from "./schema-shapes.js";

export function stateKey(
  args: Record<string, unknown>,
  key: string,
  fallback: string
): string | undefined {
  return optionalString(args, key) ?? fallback;
}

export function requiredString(
  args: Record<string, unknown>,
  key: string,
  toolName: string
): string {
  const value = args[key];
  if (typeof value === "string" && value.length > 0) return value;
  throw new ForgeError({
    code: "VALIDATION_FAILED",
    message: `${toolName}.${key} must be a non-empty string`,
    context: { tool: toolName, argument: key },
  });
}

export function optionalString(
  args: Record<string, unknown>,
  key: string
): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

export function optionalBoolean(
  args: Record<string, unknown>,
  key: string
): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}

export function optionalRecord(
  args: Record<string, unknown>,
  key: string
): Record<string, unknown> | undefined {
  const value = args[key];
  return isRecord(value) ? value : undefined;
}

export function optionalSchema(
  args: Record<string, unknown>,
  key: string
): string | Record<string, unknown> | undefined {
  const value = args[key];
  if (typeof value === "string") return value;
  return isRecord(value) ? value : undefined;
}

export function optionalStringArray(
  args: Record<string, unknown>,
  key: string
): string[] | undefined {
  const value = args[key];
  if (!Array.isArray(value)) return undefined;
  return value.every((item): item is string => typeof item === "string")
    ? value
    : undefined;
}

export function requiredStringArray(
  args: Record<string, unknown>,
  key: string,
  toolName: string
): string[] {
  const value = optionalStringArray(args, key);
  if (value !== undefined && value.length > 0) return value;
  throw new ForgeError({
    code: "VALIDATION_FAILED",
    message: `${toolName}.${key} must be a non-empty string array`,
    context: { tool: toolName, argument: key },
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isZodLikeSchema(value: unknown): value is RuntimeZodLikeSchema {
  return (
    typeof value === "object" &&
    value !== null &&
    "safeParse" in value &&
    typeof (value as { safeParse?: unknown }).safeParse === "function"
  );
}

export function compactRuntimeToolResult<T extends Record<string, unknown>>(
  value: T
): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as Partial<T>;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
