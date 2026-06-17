/**
 * DSL normalization for `adapter.supervisor` nodes (adapter-DSL study Phase 3.3,
 * spec §5.3). Decomposes a `goal` into subtasks (LLM-driven; OQ-1 resolved) and
 * delegates to an optional `specialists` pool (default: registry routing).
 * Mirrors the other adapter normalizers: no normalize-time field defaults for a
 * lossless round-trip, and `idempotency` is a first-class typed field kept off
 * `node.meta`. Carries `goal` rather than the common `instructions`.
 */

import type { AdapterSupervisorNode } from "@dzupagent/flow-ast";

import { DSL_ERROR } from "./errors.js";
import {
  COMMON_NODE_KEYS,
  normalizeObject,
  normalizeStringArray,
  normalizeCommonNodeFields,
  reportUnsupportedFields,
} from "./normalize-value-helpers.js";
import type { DslDiagnostic } from "./types.js";

const ADAPTER_SUPERVISOR_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  "goal",
  "specialists",
  "model",
  "systemPrompt",
  "input",
  "persona",
  "reasoning",
  "outputSchema",
  "promptPrep",
  "idempotency",
  "policy",
  "output",
]);

const VALID_REASONING = new Set<
  NonNullable<AdapterSupervisorNode["reasoning"]>
>(["low", "medium", "high"]);

const VALID_PROMPT_PREP = new Set<
  NonNullable<AdapterSupervisorNode["promptPrep"]>
>(["auto", "raw"]);

const VALID_IDEMPOTENCY = new Set<
  NonNullable<AdapterSupervisorNode["idempotency"]>
>(["idempotent", "at-least-once", "exactly-once-required"]);

export function normalizeAdapterSupervisor(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[]
): AdapterSupervisorNode {
  reportUnsupportedFields(raw, ADAPTER_SUPERVISOR_KEYS, path, diagnostics);
  const { idempotency: _rawIdempotency, ...rawForCommon } = raw;
  const base = normalizeCommonNodeFields(rawForCommon, path, diagnostics);

  const goal = typeof raw.goal === "string" ? raw.goal : "";
  const output = typeof raw.output === "string" ? raw.output : "";

  if (goal.length === 0) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: "adapter.supervisor.goal is required",
      path: `${path}.goal`,
    });
  }
  if (output.length === 0) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: "adapter.supervisor.output is required",
      path: `${path}.output`,
    });
  }

  const node: AdapterSupervisorNode = {
    type: "adapter.supervisor",
    ...base,
    goal,
    output,
  };

  if (raw.specialists !== undefined) {
    const specialists = normalizeStringArray(
      raw.specialists,
      `${path}.specialists`,
      diagnostics
    );
    if (specialists !== undefined) node.specialists = specialists;
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
        raw.reasoning as NonNullable<AdapterSupervisorNode["reasoning"]>
      )
    ) {
      node.reasoning = raw.reasoning as NonNullable<
        AdapterSupervisorNode["reasoning"]
      >;
    } else {
      diagnostics.push({
        phase: "normalize",
        code: DSL_ERROR.INVALID_ENUM_VALUE,
        message:
          'adapter.supervisor.reasoning must be "low", "medium", or "high"',
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
        raw.promptPrep as NonNullable<AdapterSupervisorNode["promptPrep"]>
      )
    ) {
      node.promptPrep = raw.promptPrep as NonNullable<
        AdapterSupervisorNode["promptPrep"]
      >;
    } else {
      diagnostics.push({
        phase: "normalize",
        code: DSL_ERROR.INVALID_ENUM_VALUE,
        message: 'adapter.supervisor.promptPrep must be "auto" or "raw"',
        path: `${path}.promptPrep`,
      });
    }
  }

  if (raw.idempotency !== undefined) {
    if (
      typeof raw.idempotency === "string" &&
      VALID_IDEMPOTENCY.has(
        raw.idempotency as NonNullable<AdapterSupervisorNode["idempotency"]>
      )
    ) {
      node.idempotency = raw.idempotency as NonNullable<
        AdapterSupervisorNode["idempotency"]
      >;
    } else {
      diagnostics.push({
        phase: "normalize",
        code: DSL_ERROR.INVALID_ENUM_VALUE,
        message:
          'adapter.supervisor.idempotency must be "idempotent", "at-least-once", or "exactly-once-required"',
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
