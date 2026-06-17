/**
 * DSL normalization for `adapter.parallel` nodes (adapter-DSL study Phase 3.2,
 * spec §5.2). Fans the same prompt out to ≥2 providers concurrently and merges
 * per `merge` (default `all`, applied at runtime — not injected here, so the
 * round-trip stays lossless). Mirrors `normalize-nodes-adapter-race.ts`;
 * `idempotency` is a first-class typed field kept off `node.meta`.
 */

import type { AdapterParallelNode } from "@dzupagent/flow-ast";

import { DSL_ERROR } from "./errors.js";
import {
  COMMON_NODE_KEYS,
  normalizeObject,
  normalizeCommonNodeFields,
  reportUnsupportedFields,
} from "./normalize-value-helpers.js";
import type { DslDiagnostic } from "./types.js";

type ParallelProvider = AdapterParallelNode["providers"][number];

const ADAPTER_PARALLEL_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  "providers",
  "merge",
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

const VALID_PROVIDERS = new Set<ParallelProvider>([
  "claude",
  "codex",
  "gemini",
  "qwen",
  "goose",
  "crush",
]);

const VALID_MERGE = new Set<NonNullable<AdapterParallelNode["merge"]>>([
  "first-wins",
  "all",
  "best-of-n",
]);

const VALID_REASONING = new Set<NonNullable<AdapterParallelNode["reasoning"]>>([
  "low",
  "medium",
  "high",
]);

const VALID_PROMPT_PREP = new Set<
  NonNullable<AdapterParallelNode["promptPrep"]>
>(["auto", "raw"]);

const VALID_IDEMPOTENCY = new Set<
  NonNullable<AdapterParallelNode["idempotency"]>
>(["idempotent", "at-least-once", "exactly-once-required"]);

export function normalizeAdapterParallel(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[]
): AdapterParallelNode {
  reportUnsupportedFields(raw, ADAPTER_PARALLEL_KEYS, path, diagnostics);
  const { idempotency: _rawIdempotency, ...rawForCommon } = raw;
  const base = normalizeCommonNodeFields(rawForCommon, path, diagnostics);

  const instructions =
    typeof raw.instructions === "string" ? raw.instructions : "";
  const output = typeof raw.output === "string" ? raw.output : "";

  let providers: ParallelProvider[] = [];
  if (
    Array.isArray(raw.providers) &&
    raw.providers.length >= 2 &&
    raw.providers.every(
      (v): v is ParallelProvider =>
        typeof v === "string" && VALID_PROVIDERS.has(v as ParallelProvider)
    )
  ) {
    providers = raw.providers as ParallelProvider[];
  } else {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: `adapter.parallel.providers must be an array of at least 2 providers from ${[
        ...VALID_PROVIDERS,
      ].join("|")}`,
      path: `${path}.providers`,
    });
  }

  if (instructions.length === 0) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: "adapter.parallel.instructions is required",
      path: `${path}.instructions`,
    });
  }
  if (output.length === 0) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: "adapter.parallel.output is required",
      path: `${path}.output`,
    });
  }

  const node: AdapterParallelNode = {
    type: "adapter.parallel",
    ...base,
    providers,
    instructions,
    output,
  };

  if (raw.merge !== undefined) {
    if (
      typeof raw.merge === "string" &&
      VALID_MERGE.has(raw.merge as NonNullable<AdapterParallelNode["merge"]>)
    ) {
      node.merge = raw.merge as NonNullable<AdapterParallelNode["merge"]>;
    } else {
      diagnostics.push({
        phase: "normalize",
        code: DSL_ERROR.INVALID_ENUM_VALUE,
        message:
          'adapter.parallel.merge must be "first-wins", "all", or "best-of-n"',
        path: `${path}.merge`,
      });
    }
  }

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
        raw.reasoning as NonNullable<AdapterParallelNode["reasoning"]>
      )
    ) {
      node.reasoning = raw.reasoning as NonNullable<
        AdapterParallelNode["reasoning"]
      >;
    } else {
      diagnostics.push({
        phase: "normalize",
        code: DSL_ERROR.INVALID_ENUM_VALUE,
        message:
          'adapter.parallel.reasoning must be "low", "medium", or "high"',
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
        raw.promptPrep as NonNullable<AdapterParallelNode["promptPrep"]>
      )
    ) {
      node.promptPrep = raw.promptPrep as NonNullable<
        AdapterParallelNode["promptPrep"]
      >;
    } else {
      diagnostics.push({
        phase: "normalize",
        code: DSL_ERROR.INVALID_ENUM_VALUE,
        message: 'adapter.parallel.promptPrep must be "auto" or "raw"',
        path: `${path}.promptPrep`,
      });
    }
  }

  if (raw.idempotency !== undefined) {
    if (
      typeof raw.idempotency === "string" &&
      VALID_IDEMPOTENCY.has(
        raw.idempotency as NonNullable<AdapterParallelNode["idempotency"]>
      )
    ) {
      node.idempotency = raw.idempotency as NonNullable<
        AdapterParallelNode["idempotency"]
      >;
    } else {
      diagnostics.push({
        phase: "normalize",
        code: DSL_ERROR.INVALID_ENUM_VALUE,
        message:
          'adapter.parallel.idempotency must be "idempotent", "at-least-once", or "exactly-once-required"',
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
