/**
 * Leaf primitives for flow runtime input validation: the admitted type and
 * classification vocabularies, JSON/key safety predicates, canonical digests
 * and the RFC 3339 date-time reader.
 *
 * Extracted from `flow-runtime-input.ts` (RF-03 pin exit). Everything here was
 * module-private before the split; it is exported so the validator modules can
 * reach it, but this module is NOT a package subpath — the public surface is
 * still exactly what `src/index.ts` re-exports from `flow-runtime-input.js`
 * (of which `sha256Text` is the only member defined here).
 */

import { createHash } from "node:crypto";

import { canonicalInputDigest, canonicalJson } from "./idempotency.js";

import type {
  FlowRuntimeInputClassification,
  FlowRuntimeInputIssue,
  FlowRuntimeInputIssueCode,
  FlowRuntimeInputType,
} from "./flow-runtime-input-contracts.js";

export const INPUT_TYPES = new Set<FlowRuntimeInputType>([
  "string",
  "number",
  "boolean",
  "object",
  "array",
  "credential",
  "any",
]);

export const CLASSIFICATIONS = new Set<FlowRuntimeInputClassification>([
  "public",
  "internal",
  "sensitive",
  "secret",
]);

export const CREDENTIAL_KEYS = new Set([
  "schema",
  "handleId",
  "bindingRef",
  "capabilityRef",
  "provider",
  "scopes",
  "expiresAt",
]);

export const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);
export const TOP_LEVEL_INPUT_KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;

export function matchesType(value: unknown, type: FlowRuntimeInputType): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return plainRecord(value);
    case "array":
      return Array.isArray(value);
    case "credential":
      return false;
    case "any":
      return isPotentialJsonValue(value);
  }
}

export function isPotentialJsonValue(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    Array.isArray(value) ||
    plainRecord(value)
  );
}

export function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function nullRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

export function validTopLevelKey(key: string): boolean {
  return TOP_LEVEL_INPUT_KEY.test(key) && !UNSAFE_OBJECT_KEYS.has(key);
}

export function validJsonObjectKey(key: string): boolean {
  return (
    key.length > 0 &&
    key.length <= 256 &&
    !UNSAFE_OBJECT_KEYS.has(key) &&
    !/[\u0000-\u001f\u007f]/.test(key)
  );
}

export function invalidKeyIssue(path: string, key: string): FlowRuntimeInputIssue {
  return issue(
    "FLOW_INPUT_KEY_INVALID",
    path,
    `Input key '${key}' is not safe for durable runtime state.`,
  );
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

export function digest(value: unknown): `sha256:${string}` {
  return `sha256:${canonicalInputDigest(value)}`;
}

export function sha256Text(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function utf8Bytes(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index) ?? 0;
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else {
      bytes += 4;
      index += 1;
    }
  }
  return bytes;
}

export function boundedString(
  value: unknown,
  field: string,
  max: number,
  issues: string[],
): void {
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    issues.push(`${field} must be a non-empty string no longer than ${max} characters`);
  }
}

export function isRfc3339DateTime(value: string): boolean {
  if (value.length < 20 || value.length > 35) return false;
  if (
    value[4] !== "-" ||
    value[7] !== "-" ||
    value[10] !== "T" ||
    value[13] !== ":" ||
    value[16] !== ":" ||
    !asciiDigits(value.slice(0, 4)) ||
    !asciiDigits(value.slice(5, 7)) ||
    !asciiDigits(value.slice(8, 10)) ||
    !asciiDigits(value.slice(11, 13)) ||
    !asciiDigits(value.slice(14, 16)) ||
    !asciiDigits(value.slice(17, 19))
  ) {
    return false;
  }

  let zoneStart = 19;
  if (value[zoneStart] === ".") {
    zoneStart += 1;
    const fractionStart = zoneStart;
    while (zoneStart < value.length && asciiDigit(value[zoneStart])) {
      zoneStart += 1;
    }
    const fractionLength = zoneStart - fractionStart;
    if (fractionLength < 1 || fractionLength > 9) return false;
  }

  const zone = value.slice(zoneStart);
  const validZone =
    zone === "Z" ||
    (zone.length === 6 &&
      (zone[0] === "+" || zone[0] === "-") &&
      zone[3] === ":" &&
      asciiDigits(zone.slice(1, 3)) &&
      asciiDigits(zone.slice(4, 6)));
  if (!validZone || Number.isNaN(Date.parse(value))) return false;

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  const second = Number(value.slice(17, 19));
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }
  if (zone !== "Z") {
    const zoneHour = Number(zone.slice(1, 3));
    const zoneMinute = Number(zone.slice(4, 6));
    if (zoneHour > 23 || zoneMinute > 59) return false;
  }
  return true;
}

export function asciiDigits(value: string): boolean {
  if (value.length === 0) return false;
  for (const character of value) {
    if (!asciiDigit(character)) return false;
  }
  return true;
}

export function asciiDigit(value: string | undefined): boolean {
  return value !== undefined && value >= "0" && value <= "9";
}

export function inputPath(key: string): string {
  return `$.inputs.${key}`;
}

export function handlePath(key: string): string {
  return `$.credentialHandleRefs.${key}`;
}

export function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function issue(
  code: FlowRuntimeInputIssueCode,
  path: string,
  message: string,
): FlowRuntimeInputIssue {
  return { code, path, message };
}
