/**
 * DSL normalization for `adapter.run` nodes (adapter-DSL study Phase 1.2).
 *
 * Mirrors `normalize-nodes-worker-dispatch.ts` style: declare allowed keys, run
 * the `reportUnsupportedFields` guard, normalize the common base, and emit
 * diagnostics for shape problems. An `adapter.run` node hands a single routed
 * in-process agent-adapter call to the runtime — the adapter is selected by an
 * explicit `provider` or by capability `tags` (exactly one is required). Unlike
 * `worker.dispatch`, no field defaults are injected at normalize time:
 * `promptPrep` (auto) and `idempotency` (idempotent) are runtime defaults, so
 * omitting them stays omitted and the DSL round-trip is lossless.
 */

import type { AdapterRunNode } from "@dzupagent/flow-ast";

import { DSL_ERROR } from "./errors.js";
import {
  COMMON_NODE_KEYS,
  normalizeObject,
  normalizeCommonNodeFields,
  reportUnsupportedFields,
} from "./normalize-value-helpers.js";
import type { DslDiagnostic } from "./types.js";

const ADAPTER_RUN_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  "provider",
  "tags",
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

const VALID_PROVIDERS = new Set<NonNullable<AdapterRunNode["provider"]>>([
  "claude",
  "codex",
  "gemini",
  "openai",
  "openrouter",
  "openrouter-crush",
  "qwen",
  "goose",
  "crush",
]);

const VALID_REASONING = new Set<NonNullable<AdapterRunNode["reasoning"]>>([
  "low",
  "medium",
  "high",
]);

const VALID_PROMPT_PREP = new Set<NonNullable<AdapterRunNode["promptPrep"]>>([
  "auto",
  "raw",
]);

const VALID_IDEMPOTENCY = new Set<NonNullable<AdapterRunNode["idempotency"]>>([
  "idempotent",
  "at-least-once",
  "exactly-once-required",
]);

function isAdapterProvider(
  value: unknown
): value is NonNullable<AdapterRunNode["provider"]> {
  return (
    typeof value === "string" &&
    VALID_PROVIDERS.has(value as NonNullable<AdapterRunNode["provider"]>)
  );
}

export function normalizeAdapterRun(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[]
): AdapterRunNode {
  reportUnsupportedFields(raw, ADAPTER_RUN_KEYS, path, diagnostics);
  // `idempotency` is a generic-metadata key, but on `adapter.run` it is a
  // first-class typed node field (spec §3). Hide it from the common-field
  // metadata sweep so it lands only on `node.idempotency`, never `node.meta`.
  const { idempotency: _rawIdempotency, ...rawForCommon } = raw;
  const base = normalizeCommonNodeFields(rawForCommon, path, diagnostics);

  const instructions =
    typeof raw.instructions === "string" ? raw.instructions : "";
  const output = typeof raw.output === "string" ? raw.output : "";

  if (instructions.length === 0) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: "adapter.run.instructions is required",
      path: `${path}.instructions`,
    });
  }
  if (output.length === 0) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: "adapter.run.output is required",
      path: `${path}.output`,
    });
  }

  const node: AdapterRunNode = {
    type: "adapter.run",
    ...base,
    instructions,
    output,
  };

  // Routing: exactly one of provider / tags is required.
  const hasProvider = raw.provider !== undefined;
  const hasTags = raw.tags !== undefined;

  if (hasProvider) {
    if (isAdapterProvider(raw.provider)) {
      node.provider = raw.provider;
    } else {
      diagnostics.push({
        phase: "normalize",
        code: DSL_ERROR.INVALID_ENUM_VALUE,
        message: `adapter.run.provider must be one of ${[
          ...VALID_PROVIDERS,
        ].join("|")}`,
        path: `${path}.provider`,
      });
    }
  }

  if (hasTags) {
    if (
      Array.isArray(raw.tags) &&
      raw.tags.length > 0 &&
      raw.tags.every((v): v is string => typeof v === "string")
    ) {
      node.tags = raw.tags;
    } else {
      diagnostics.push({
        phase: "normalize",
        code: DSL_ERROR.INVALID_NODE_SHAPE,
        message: "adapter.run.tags must be a non-empty array of strings",
        path: `${path}.tags`,
      });
    }
  }

  if (!hasProvider && !hasTags) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: "adapter.run requires one of provider or tags",
      path: `${path}.provider`,
    });
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
        raw.reasoning as NonNullable<AdapterRunNode["reasoning"]>
      )
    ) {
      node.reasoning = raw.reasoning as NonNullable<
        AdapterRunNode["reasoning"]
      >;
    } else {
      diagnostics.push({
        phase: "normalize",
        code: DSL_ERROR.INVALID_ENUM_VALUE,
        message: 'adapter.run.reasoning must be "low", "medium", or "high"',
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
        raw.promptPrep as NonNullable<AdapterRunNode["promptPrep"]>
      )
    ) {
      node.promptPrep = raw.promptPrep as NonNullable<
        AdapterRunNode["promptPrep"]
      >;
    } else {
      diagnostics.push({
        phase: "normalize",
        code: DSL_ERROR.INVALID_ENUM_VALUE,
        message: 'adapter.run.promptPrep must be "auto" or "raw"',
        path: `${path}.promptPrep`,
      });
    }
  }

  if (raw.idempotency !== undefined) {
    if (
      typeof raw.idempotency === "string" &&
      VALID_IDEMPOTENCY.has(
        raw.idempotency as NonNullable<AdapterRunNode["idempotency"]>
      )
    ) {
      node.idempotency = raw.idempotency as NonNullable<
        AdapterRunNode["idempotency"]
      >;
    } else {
      diagnostics.push({
        phase: "normalize",
        code: DSL_ERROR.INVALID_ENUM_VALUE,
        message:
          'adapter.run.idempotency must be "idempotent", "at-least-once", or "exactly-once-required"',
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
