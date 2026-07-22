/**
 * DSL normalization for the `agent` node (dzupflow/v1alpha-agent).
 *
 * Mirrors `normalize-nodes-action.ts` style: declare allowed keys, run the
 * `reportUnsupportedFields` guard, normalize each field, and emit diagnostics
 * for shape problems. Shape constraints must agree with
 * `@dzupagent/flow-ast`'s `parse/agent.ts` and `validate/agent.ts`.
 */

import type { AgentNode, AgentOutput } from "@dzupagent/flow-ast";

import { DSL_ERROR } from "../errors.js";
import {
  COMMON_NODE_KEYS,
  normalizeCommonNodeFields,
  normalizeObject,
  reportUnsupportedFields,
} from "../normalize-value-helpers.js";
import type { DslDiagnostic } from "../types.js";
import {
  normalizeOnInvalidOutput,
  normalizeOutput,
  normalizeRetry,
  normalizeStop,
} from "./agent-output-retry-fields.js";
import {
  normalizePolicy,
  normalizeValidation,
} from "./agent-validation-policy-fields.js";

const AGENT_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  "agentId",
  "profile",
  "toolset",
  "tools",
  "model",
  "provider",
  "instructions",
  "input",
  "stop",
  "output",
  "onInvalidOutput",
  "retry",
  "validation",
  "policy",
]);

export function normalizeAgent(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[]
): AgentNode {
  reportUnsupportedFields(raw, AGENT_KEYS, path, diagnostics);
  const base = normalizeCommonNodeFields(raw, path, diagnostics);

  const agentId = typeof raw.agentId === "string" ? raw.agentId : "";
  const instructions =
    typeof raw.instructions === "string" ? raw.instructions : "";
  const output = normalizeOutput(raw.output, `${path}.output`, diagnostics);

  if (agentId.length === 0) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: "agent.agentId is required",
      path: `${path}.agentId`,
    });
  }
  if (instructions.length === 0) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: "agent.instructions is required",
      path: `${path}.instructions`,
    });
  }

  // Provide an output stub when missing so the AST is structurally complete;
  // diagnostics above ensure ok=false at the document level.
  const safeOutput: AgentOutput = output ?? { key: "" };

  const node: AgentNode = {
    type: "agent",
    ...base,
    agentId,
    instructions,
    output: safeOutput,
  };

  if (typeof raw.profile === "string") node.profile = raw.profile;
  if (typeof raw.toolset === "string") node.toolset = raw.toolset;
  if (typeof raw.model === "string") node.model = raw.model;
  if (typeof raw.provider === "string") node.provider = raw.provider;

  if (raw.tools !== undefined) {
    if (
      Array.isArray(raw.tools) &&
      raw.tools.every((v): v is string => typeof v === "string")
    ) {
      node.tools = raw.tools;
    } else {
      diagnostics.push({
        phase: "normalize",
        code: DSL_ERROR.INVALID_NODE_SHAPE,
        message: "agent.tools must be an array of strings",
        path: `${path}.tools`,
      });
    }
  }

  if (raw.input !== undefined) {
    const input = normalizeObject(raw.input, `${path}.input`, diagnostics);
    if (input !== undefined) node.input = input;
  }

  const stop = normalizeStop(raw.stop, `${path}.stop`, diagnostics);
  if (stop !== undefined) node.stop = stop;

  const onInvalidOutput = normalizeOnInvalidOutput(
    raw.onInvalidOutput,
    `${path}.onInvalidOutput`,
    diagnostics
  );
  if (onInvalidOutput !== undefined) node.onInvalidOutput = onInvalidOutput;

  const retry = normalizeRetry(raw.retry, `${path}.retry`, diagnostics);
  if (retry !== undefined) node.retry = retry;

  const validation = normalizeValidation(
    raw.validation,
    `${path}.validation`,
    diagnostics
  );
  if (validation !== undefined) node.validation = validation;

  const policy = normalizePolicy(raw.policy, `${path}.policy`, diagnostics);
  if (policy !== undefined) node.policy = policy;

  return node;
}
