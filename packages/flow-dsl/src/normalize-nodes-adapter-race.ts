/**
 * DSL normalization for `adapter.race` nodes (adapter-DSL study Phase 3.1,
 * spec §5.1). Races the same prompt across ≥2 providers; the first successful
 * result wins. Mirrors `normalize-nodes-adapter-run.ts`: no normalize-time
 * field defaults so the DSL round-trip is lossless, and `idempotency` (a
 * generic-metadata key) is treated as a first-class typed node field — hidden
 * from the common-field metadata sweep so it lands on `node.idempotency`.
 */

import type { AdapterRaceNode } from "@dzupagent/flow-ast";

import { DSL_ERROR } from "./errors.js";
import {
  COMMON_NODE_KEYS,
  normalizeObject,
  normalizeCommonNodeFields,
  reportUnsupportedFields,
} from "./normalize-value-helpers.js";
import type { DslDiagnostic } from "./types.js";

type RaceProvider = AdapterRaceNode["providers"][number];

const ADAPTER_RACE_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  "providers",
  "model",
  "systemPrompt",
  "instructions",
  "input",
  "persona",
  "reasoning",
  "outputSchema",
  "promptPrep",
  "idempotency",
  "policy",
  "output",
]);

const VALID_PROVIDERS = new Set<RaceProvider>([
  "claude",
  "codex",
  "gemini",
  "qwen",
  "goose",
  "crush",
]);

const VALID_REASONING = new Set<NonNullable<AdapterRaceNode["reasoning"]>>([
  "low",
  "medium",
  "high",
]);

const VALID_PROMPT_PREP = new Set<NonNullable<AdapterRaceNode["promptPrep"]>>([
  "auto",
  "raw",
]);

const VALID_IDEMPOTENCY = new Set<NonNullable<AdapterRaceNode["idempotency"]>>([
  "idempotent",
  "at-least-once",
  "exactly-once-required",
]);

export function normalizeAdapterRace(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[]
): AdapterRaceNode {
  reportUnsupportedFields(raw, ADAPTER_RACE_KEYS, path, diagnostics);
  // `idempotency` is a first-class typed field here (spec §3), not generic
  // metadata — keep it off `node.meta`.
  const { idempotency: _rawIdempotency, ...rawForCommon } = raw;
  const base = normalizeCommonNodeFields(rawForCommon, path, diagnostics);

  const instructions =
    typeof raw.instructions === "string" ? raw.instructions : "";
  const output = typeof raw.output === "string" ? raw.output : "";

  let providers: RaceProvider[] = [];
  if (
    Array.isArray(raw.providers) &&
    raw.providers.length >= 2 &&
    raw.providers.every(
      (v): v is RaceProvider =>
        typeof v === "string" && VALID_PROVIDERS.has(v as RaceProvider)
    )
  ) {
    providers = raw.providers as RaceProvider[];
  } else {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: `adapter.race.providers must be an array of at least 2 providers from ${[
        ...VALID_PROVIDERS,
      ].join("|")}`,
      path: `${path}.providers`,
    });
  }

  if (instructions.length === 0) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: "adapter.race.instructions is required",
      path: `${path}.instructions`,
    });
  }
  if (output.length === 0) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: "adapter.race.output is required",
      path: `${path}.output`,
    });
  }

  const node: AdapterRaceNode = {
    type: "adapter.race",
    ...base,
    providers,
    instructions,
    output,
  };

  if (typeof raw.model === "string") node.model = raw.model;
  if (typeof raw.systemPrompt === "string")
    node.systemPrompt = raw.systemPrompt;
  if (typeof raw.persona === "string") node.persona = raw.persona;

  if (raw.input !== undefined) {
    const input = normalizeObject(raw.input, `${path}.input`, diagnostics);
    if (input !== undefined) node.input = input;
  }

  if (raw.reasoning !== undefined) {
    if (
      typeof raw.reasoning === "string" &&
      VALID_REASONING.has(
        raw.reasoning as NonNullable<AdapterRaceNode["reasoning"]>
      )
    ) {
      node.reasoning = raw.reasoning as NonNullable<
        AdapterRaceNode["reasoning"]
      >;
    } else {
      diagnostics.push({
        phase: "normalize",
        code: DSL_ERROR.INVALID_ENUM_VALUE,
        message: 'adapter.race.reasoning must be "low", "medium", or "high"',
        path: `${path}.reasoning`,
      });
    }
  }

  if (raw.outputSchema !== undefined) {
    if (typeof raw.outputSchema === "string") {
      node.outputSchema = raw.outputSchema;
    } else {
      const schema = normalizeObject(
        raw.outputSchema,
        `${path}.outputSchema`,
        diagnostics
      );
      if (schema !== undefined) node.outputSchema = schema;
    }
  }

  if (raw.promptPrep !== undefined) {
    if (
      typeof raw.promptPrep === "string" &&
      VALID_PROMPT_PREP.has(
        raw.promptPrep as NonNullable<AdapterRaceNode["promptPrep"]>
      )
    ) {
      node.promptPrep = raw.promptPrep as NonNullable<
        AdapterRaceNode["promptPrep"]
      >;
    } else {
      diagnostics.push({
        phase: "normalize",
        code: DSL_ERROR.INVALID_ENUM_VALUE,
        message: 'adapter.race.promptPrep must be "auto" or "raw"',
        path: `${path}.promptPrep`,
      });
    }
  }

  if (raw.idempotency !== undefined) {
    if (
      typeof raw.idempotency === "string" &&
      VALID_IDEMPOTENCY.has(
        raw.idempotency as NonNullable<AdapterRaceNode["idempotency"]>
      )
    ) {
      node.idempotency = raw.idempotency as NonNullable<
        AdapterRaceNode["idempotency"]
      >;
    } else {
      diagnostics.push({
        phase: "normalize",
        code: DSL_ERROR.INVALID_ENUM_VALUE,
        message:
          'adapter.race.idempotency must be "idempotent", "at-least-once", or "exactly-once-required"',
        path: `${path}.idempotency`,
      });
    }
  }

  if (raw.policy !== undefined) {
    const policy = normalizeObject(raw.policy, `${path}.policy`, diagnostics);
    if (policy !== undefined) node.policy = policy;
  }

  return node;
}
