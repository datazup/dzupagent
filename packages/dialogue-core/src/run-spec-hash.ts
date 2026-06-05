import { createHash } from "node:crypto";

import type { RunSpec } from "./types/run-spec.js";
import { TURN_VERBS } from "./types/turn-verb.js";

type CanonicalJsonValue =
  | string
  | number
  | boolean
  | null
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

const RUN_SPEC_HASH_KEYS = [
  "mode",
  "participants",
  "turns",
  "loops",
  "decidePolicy",
  "budget",
  "maxIterations",
  "allowEscape",
  "dirtyPolicy",
] as const;

export function normalizeRunSpecForHash(
  runSpec: RunSpec,
): Record<(typeof RUN_SPEC_HASH_KEYS)[number], unknown> {
  assertValidRunSpec(runSpec);

  return {
    mode: runSpec.mode,
    participants: runSpec.participants,
    turns: runSpec.turns,
    loops: runSpec.loops,
    decidePolicy: runSpec.decidePolicy,
    budget: runSpec.budget,
    maxIterations: runSpec.maxIterations,
    allowEscape: runSpec.allowEscape ?? false,
    dirtyPolicy: runSpec.dirtyPolicy,
  };
}

export function canonicalizeRunSpec(runSpec: RunSpec): string {
  return JSON.stringify(canonicalizeValue(normalizeRunSpecForHash(runSpec)));
}

export function hashRunSpec(runSpec: RunSpec): `sha256:${string}` {
  const canonicalRunSpec = canonicalizeRunSpec(runSpec);
  const digest = createHash("sha256")
    .update(canonicalRunSpec, "utf8")
    .digest("hex");

  return `sha256:${digest}`;
}

export function assertValidRunSpec(runSpec: RunSpec): void {
  if (runSpec.mode !== "deliberate" && runSpec.mode !== "build") {
    throw new TypeError("RunSpec mode must be deliberate or build.");
  }

  if (!Array.isArray(runSpec.participants)) {
    throw new TypeError("RunSpec participants must be an array.");
  }

  if (!Array.isArray(runSpec.turns)) {
    throw new TypeError("RunSpec turns must be an array.");
  }

  for (const turn of runSpec.turns) {
    if (!TURN_VERBS.includes(turn.verb)) {
      throw new TypeError(`Unsupported RunSpec turn verb: ${String(turn.verb)}.`);
    }
  }

  if (
    runSpec.allowEscape !== undefined &&
    typeof runSpec.allowEscape !== "boolean"
  ) {
    throw new TypeError("RunSpec allowEscape must be a boolean when provided.");
  }
}

function canonicalizeValue(value: unknown): CanonicalJsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeValue(item) ?? null);
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("RunSpec hashing only supports finite numbers.");
    }

    return value;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "object") {
    return canonicalizeObject(value);
  }

  throw new TypeError(`Unsupported RunSpec value type: ${typeof value}.`);
}

function canonicalizeObject(value: object): { [key: string]: CanonicalJsonValue } {
  return Object.keys(value)
    .sort()
    .reduce<{ [key: string]: CanonicalJsonValue }>((canonical, key) => {
      const item = canonicalizeValue(value[key as keyof typeof value]);

      if (item !== undefined) {
        canonical[key] = item;
      }

      return canonical;
    }, {});
}
