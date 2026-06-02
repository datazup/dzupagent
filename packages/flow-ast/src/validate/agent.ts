import type {
  AgentNode,
  AgentOutput,
  FlowNode,
  ValidateNode,
} from "../types.js";
import {
  describeJsType,
  isPlainObject,
  joinPath,
} from "../validation-helpers.js";
import { validateCommonNodeFields } from "./shared.js";
import type { SchemaIssue } from "./shared.js";
import { isNonNegativeNumber } from "../policy-numbers.js";
import {
  optionalObject,
  optionalString,
  optionalStringArray,
} from "./agent-fields.js";
import {
  validateAgentOutput,
  validateAgentRetry,
  validateAgentStop,
  validateOnInvalidOutput,
} from "./agent-loop.js";
import {
  validateAgentValidation,
  validateValidationCommands,
} from "./agent-validation.js";
import {
  validateAgentPolicy,
  validateAgentTemplateRef,
} from "./agent-policy.js";

export function validateAgent(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[]
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues);
  let ok = true;

  const agentId = obj["agentId"];
  if (typeof agentId !== "string" || agentId.length === 0) {
    issues.push({
      path: joinPath(path, "agentId"),
      code: "MISSING_REQUIRED_FIELD",
      message: `agent.agentId is required (non-empty string), received ${describeJsType(
        agentId
      )}`,
    });
    ok = false;
  }

  // Parse the optional `template` field early so we know whether to require
  // `instructions`. When `template.ref` is present, instructions may be absent
  // at parse time — the synthesis pass fills them in before execution.
  const templateRef = validateAgentTemplateRef(
    obj["template"],
    joinPath(path, "template"),
    issues
  );

  const instructions = obj["instructions"];
  const hasTemplateRef =
    templateRef !== undefined &&
    typeof templateRef.ref === "string" &&
    templateRef.ref.length > 0;
  if (
    !hasTemplateRef &&
    (typeof instructions !== "string" || instructions.length === 0)
  ) {
    issues.push({
      path: joinPath(path, "instructions"),
      code: "MISSING_REQUIRED_FIELD",
      message: `agent.instructions is required (non-empty string) when template.ref is absent, received ${describeJsType(
        instructions
      )}`,
    });
    ok = false;
  } else if (instructions !== undefined && typeof instructions !== "string") {
    issues.push({
      path: joinPath(path, "instructions"),
      code: "MISSING_REQUIRED_FIELD",
      message: `agent.instructions must be a string when present, received ${describeJsType(
        instructions
      )}`,
    });
    ok = false;
  }

  const output = validateAgentOutput(
    obj["output"],
    joinPath(path, "output"),
    issues
  );
  if (output === null) ok = false;

  if (!ok) return null;

  // When instructions is absent (template-ref mode), use a sentinel that the
  // synthesis pass will replace before execution. This satisfies the AgentNode
  // type contract at parse time without exposing an empty string to the runtime.
  const resolvedInstructions =
    typeof instructions === "string" && instructions.length > 0
      ? instructions
      : ""; // synthesis pass must fill this before execution

  const node: AgentNode = {
    type: "agent",
    ...common,
    agentId: agentId as string,
    instructions: resolvedInstructions,
    output: output as AgentOutput,
  };

  if (templateRef !== undefined) node.template = templateRef;

  const profile = optionalString(obj, "profile", path, issues);
  if (profile !== undefined) node.profile = profile;

  const toolset = optionalString(obj, "toolset", path, issues);
  if (toolset !== undefined) node.toolset = toolset;

  const tools = optionalStringArray(obj, "tools", path, issues);
  if (tools !== undefined) node.tools = tools;

  const model = optionalString(obj, "model", path, issues);
  if (model !== undefined) node.model = model;

  const provider = optionalString(obj, "provider", path, issues);
  if (provider !== undefined) node.provider = provider;

  const input = optionalObject(obj, "input", path, issues);
  if (input !== undefined) node.input = input;

  const stop = validateAgentStop(obj["stop"], joinPath(path, "stop"), issues);
  if (stop !== undefined) node.stop = stop;

  const onInvalidOutput = validateOnInvalidOutput(
    obj["onInvalidOutput"],
    joinPath(path, "onInvalidOutput"),
    issues
  );
  if (onInvalidOutput !== undefined) node.onInvalidOutput = onInvalidOutput;

  const retry = validateAgentRetry(
    obj["retry"],
    joinPath(path, "retry"),
    issues
  );
  if (retry !== undefined) node.retry = retry;

  const validation = validateAgentValidation(
    obj["validation"],
    joinPath(path, "validation"),
    issues
  );
  if (validation !== undefined) node.validation = validation;

  const policy = validateAgentPolicy(
    obj["policy"],
    joinPath(path, "policy"),
    issues
  );
  if (policy !== undefined) node.policy = policy;

  return node;
}

export function validateValidateNode(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[]
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues);

  const ref = optionalString(obj, "ref", path, issues);
  const commands = validateValidationCommands(
    obj["commands"],
    joinPath(path, "commands"),
    issues,
    /* required */ false
  );

  if (ref === undefined && (commands === undefined || commands.length === 0)) {
    issues.push({
      path,
      code: "MISSING_REQUIRED_FIELD",
      message:
        "validate node requires either `ref` or a non-empty `commands` array",
    });
    return null;
  }

  const node: ValidateNode = {
    type: "validate",
    ...common,
  };
  if (ref !== undefined) node.ref = ref;
  if (commands !== undefined) node.commands = commands;

  if ("repair" in obj && obj["repair"] !== undefined) {
    const repairRaw = obj["repair"];
    if (!isPlainObject(repairRaw)) {
      issues.push({
        path: joinPath(path, "repair"),
        code: "MISSING_REQUIRED_FIELD",
        message: `validate.repair must be an object, received ${describeJsType(
          repairRaw
        )}`,
      });
    } else {
      const maxAttempts = repairRaw["maxAttempts"];
      if (!isNonNegativeNumber(maxAttempts)) {
        issues.push({
          path: joinPath(path, "repair.maxAttempts"),
          code: "MISSING_REQUIRED_FIELD",
          message:
            "validate.repair.maxAttempts is required (non-negative number)",
        });
      } else {
        const repair: NonNullable<ValidateNode["repair"]> = { maxAttempts };
        const onFailure = repairRaw["onFailure"];
        if (onFailure === "retry-prior-agent" || onFailure === "stop") {
          repair.onFailure = onFailure;
        } else if (onFailure !== undefined) {
          issues.push({
            path: joinPath(path, "repair.onFailure"),
            code: "MISSING_REQUIRED_FIELD",
            message:
              'validate.repair.onFailure must be "retry-prior-agent" or "stop"',
          });
        }
        node.repair = repair;
      }
    }
  }

  return node;
}
