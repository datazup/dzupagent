import type {
  AgentNode,
  AgentOnInvalidOutput,
  AgentOutput,
  AgentPolicy,
  AgentRetry,
  AgentStop,
  AgentTemplateRef,
  AgentValidation,
  AgentValidationCommand,
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
import {
  isPositiveFinitePolicyNumber,
  isNonNegativeNumber,
  isPositiveFiniteNumber,
} from "../policy-numbers.js";

export function validateAgent(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues);
  let ok = true;

  const agentId = obj["agentId"];
  if (typeof agentId !== "string" || agentId.length === 0) {
    issues.push({
      path: joinPath(path, "agentId"),
      code: "MISSING_REQUIRED_FIELD",
      message: `agent.agentId is required (non-empty string), received ${describeJsType(
        agentId,
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
    issues,
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
        instructions,
      )}`,
    });
    ok = false;
  } else if (instructions !== undefined && typeof instructions !== "string") {
    issues.push({
      path: joinPath(path, "instructions"),
      code: "MISSING_REQUIRED_FIELD",
      message: `agent.instructions must be a string when present, received ${describeJsType(
        instructions,
      )}`,
    });
    ok = false;
  }

  const output = validateAgentOutput(
    obj["output"],
    joinPath(path, "output"),
    issues,
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
    issues,
  );
  if (onInvalidOutput !== undefined) node.onInvalidOutput = onInvalidOutput;

  const retry = validateAgentRetry(
    obj["retry"],
    joinPath(path, "retry"),
    issues,
  );
  if (retry !== undefined) node.retry = retry;

  const validation = validateAgentValidation(
    obj["validation"],
    joinPath(path, "validation"),
    issues,
  );
  if (validation !== undefined) node.validation = validation;

  const policy = validateAgentPolicy(
    obj["policy"],
    joinPath(path, "policy"),
    issues,
  );
  if (policy !== undefined) node.policy = policy;

  return node;
}

export function validateValidateNode(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues);

  const ref = optionalString(obj, "ref", path, issues);
  const commands = validateValidationCommands(
    obj["commands"],
    joinPath(path, "commands"),
    issues,
    /* required */ false,
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
          repairRaw,
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

// ── Helpers (agent-local; not promoted to shared.ts because they encode
//    agent-node-specific shape constraints) ───────────────────────────────────

function validateAgentOutput(
  raw: unknown,
  path: string,
  issues: SchemaIssue[],
): AgentOutput | null {
  if (!isPlainObject(raw)) {
    issues.push({
      path,
      code: "MISSING_REQUIRED_FIELD",
      message: `agent.output is required (object), received ${describeJsType(
        raw,
      )}`,
    });
    return null;
  }
  const key = raw["key"];
  if (typeof key !== "string" || key.length === 0) {
    issues.push({
      path: joinPath(path, "key"),
      code: "MISSING_REQUIRED_FIELD",
      message: "agent.output.key is required (non-empty string)",
    });
    return null;
  }
  const schemaRef = raw["schemaRef"];
  const schema = raw["schema"];
  if (schemaRef === undefined && schema === undefined) {
    issues.push({
      path,
      code: "MISSING_REQUIRED_FIELD",
      message: "agent.output requires either `schemaRef` or inline `schema`",
    });
    return null;
  }
  if (schemaRef !== undefined && typeof schemaRef !== "string") {
    issues.push({
      path: joinPath(path, "schemaRef"),
      code: "MISSING_REQUIRED_FIELD",
      message: "agent.output.schemaRef must be a string when present",
    });
    return null;
  }
  if (schema !== undefined && !isPlainObject(schema)) {
    issues.push({
      path: joinPath(path, "schema"),
      code: "MISSING_REQUIRED_FIELD",
      message: "agent.output.schema must be an object when present",
    });
    return null;
  }
  const out: AgentOutput = { key };
  if (typeof schemaRef === "string") out.schemaRef = schemaRef;
  if (isPlainObject(schema)) out.schema = schema;
  return out;
}

function validateAgentStop(
  raw: unknown,
  path: string,
  issues: SchemaIssue[],
): AgentStop | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    issues.push({
      path,
      code: "MISSING_REQUIRED_FIELD",
      message: `agent.stop must be an object when present, received ${describeJsType(
        raw,
      )}`,
    });
    return undefined;
  }
  const stop: AgentStop = {};
  if (raw["maxIterations"] !== undefined) {
    if (typeof raw["maxIterations"] !== "number") {
      issues.push({
        path: joinPath(path, "maxIterations"),
        code: "MISSING_REQUIRED_FIELD",
        message: "agent.stop.maxIterations must be a number",
      });
    } else {
      stop.maxIterations = raw["maxIterations"];
    }
  }
  if (raw["maxToolCalls"] !== undefined) {
    if (!isPositiveFinitePolicyNumber(raw["maxToolCalls"])) {
      issues.push({
        path: joinPath(path, "maxToolCalls"),
        code: "MISSING_REQUIRED_FIELD",
        message: "agent.stop.maxToolCalls must be a positive integer",
      });
    } else {
      stop.maxToolCalls = raw["maxToolCalls"];
    }
  }
  if (raw["requireFinalSchema"] !== undefined) {
    if (typeof raw["requireFinalSchema"] !== "boolean") {
      issues.push({
        path: joinPath(path, "requireFinalSchema"),
        code: "MISSING_REQUIRED_FIELD",
        message: "agent.stop.requireFinalSchema must be a boolean",
      });
    } else {
      stop.requireFinalSchema = raw["requireFinalSchema"];
    }
  }
  return stop;
}

function validateOnInvalidOutput(
  raw: unknown,
  path: string,
  issues: SchemaIssue[],
): AgentOnInvalidOutput | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    issues.push({
      path,
      code: "MISSING_REQUIRED_FIELD",
      message: `agent.onInvalidOutput must be an object, received ${describeJsType(
        raw,
      )}`,
    });
    return undefined;
  }
  const retry = raw["retry"];
  if (!isNonNegativeNumber(retry)) {
    issues.push({
      path: joinPath(path, "retry"),
      code: "MISSING_REQUIRED_FIELD",
      message: "agent.onInvalidOutput.retry is required (non-negative number)",
    });
    return undefined;
  }
  const out: AgentOnInvalidOutput = { retry };
  if (raw["repairPrompt"] !== undefined) {
    if (typeof raw["repairPrompt"] !== "boolean") {
      issues.push({
        path: joinPath(path, "repairPrompt"),
        code: "MISSING_REQUIRED_FIELD",
        message: "agent.onInvalidOutput.repairPrompt must be a boolean",
      });
    } else {
      out.repairPrompt = raw["repairPrompt"];
    }
  }
  if (raw["failAfterRetries"] !== undefined) {
    if (typeof raw["failAfterRetries"] !== "boolean") {
      issues.push({
        path: joinPath(path, "failAfterRetries"),
        code: "MISSING_REQUIRED_FIELD",
        message: "agent.onInvalidOutput.failAfterRetries must be a boolean",
      });
    } else {
      out.failAfterRetries = raw["failAfterRetries"];
    }
  }
  return out;
}

function validateAgentRetry(
  raw: unknown,
  path: string,
  issues: SchemaIssue[],
): AgentRetry | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    issues.push({
      path,
      code: "MISSING_REQUIRED_FIELD",
      message: `agent.retry must be an object, received ${describeJsType(raw)}`,
    });
    return undefined;
  }
  const out: AgentRetry = {};
  const onInvalidOutput = raw["onInvalidOutput"];
  if (isPlainObject(onInvalidOutput)) {
    const attempts = onInvalidOutput["attempts"];
    if (!isNonNegativeNumber(attempts)) {
      issues.push({
        path: joinPath(path, "onInvalidOutput.attempts"),
        code: "MISSING_REQUIRED_FIELD",
        message:
          "retry.onInvalidOutput.attempts is required (non-negative number)",
      });
    } else {
      const branch: NonNullable<AgentRetry["onInvalidOutput"]> = { attempts };
      if (typeof onInvalidOutput["repairPrompt"] === "boolean") {
        branch.repairPrompt = onInvalidOutput["repairPrompt"];
      }
      out.onInvalidOutput = branch;
    }
  } else if (onInvalidOutput !== undefined) {
    issues.push({
      path: joinPath(path, "onInvalidOutput"),
      code: "MISSING_REQUIRED_FIELD",
      message: "retry.onInvalidOutput must be an object",
    });
  }
  const onToolError = raw["onToolError"];
  if (isPlainObject(onToolError)) {
    const attempts = onToolError["attempts"];
    if (!isNonNegativeNumber(attempts)) {
      issues.push({
        path: joinPath(path, "onToolError.attempts"),
        code: "MISSING_REQUIRED_FIELD",
        message: "retry.onToolError.attempts is required (non-negative number)",
      });
    } else {
      out.onToolError = { attempts };
    }
  } else if (onToolError !== undefined) {
    issues.push({
      path: joinPath(path, "onToolError"),
      code: "MISSING_REQUIRED_FIELD",
      message: "retry.onToolError must be an object",
    });
  }
  const onValidationFailure = raw["onValidationFailure"];
  if (isPlainObject(onValidationFailure)) {
    const attempts = onValidationFailure["attempts"];
    if (!isNonNegativeNumber(attempts)) {
      issues.push({
        path: joinPath(path, "onValidationFailure.attempts"),
        code: "MISSING_REQUIRED_FIELD",
        message:
          "retry.onValidationFailure.attempts is required (non-negative number)",
      });
    } else {
      const branch: NonNullable<AgentRetry["onValidationFailure"]> = {
        attempts,
      };
      if (typeof onValidationFailure["fullLoop"] === "boolean") {
        branch.fullLoop = onValidationFailure["fullLoop"];
      }
      out.onValidationFailure = branch;
    }
  } else if (onValidationFailure !== undefined) {
    issues.push({
      path: joinPath(path, "onValidationFailure"),
      code: "MISSING_REQUIRED_FIELD",
      message: "retry.onValidationFailure must be an object",
    });
  }
  const onModelUnavailable = raw["onModelUnavailable"];
  if (isPlainObject(onModelUnavailable)) {
    const attempts = onModelUnavailable["attempts"];
    if (!isNonNegativeNumber(attempts)) {
      issues.push({
        path: joinPath(path, "onModelUnavailable.attempts"),
        code: "MISSING_REQUIRED_FIELD",
        message:
          "retry.onModelUnavailable.attempts is required (non-negative number)",
      });
    } else {
      const branch: NonNullable<AgentRetry["onModelUnavailable"]> = {
        attempts,
      };
      if (typeof onModelUnavailable["fallbackProfile"] === "string") {
        branch.fallbackProfile = onModelUnavailable["fallbackProfile"];
      }
      out.onModelUnavailable = branch;
    }
  } else if (onModelUnavailable !== undefined) {
    issues.push({
      path: joinPath(path, "onModelUnavailable"),
      code: "MISSING_REQUIRED_FIELD",
      message: "retry.onModelUnavailable must be an object",
    });
  }
  return out;
}

function validateAgentValidation(
  raw: unknown,
  path: string,
  issues: SchemaIssue[],
): AgentValidation | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    issues.push({
      path,
      code: "MISSING_REQUIRED_FIELD",
      message: `agent.validation must be an object, received ${describeJsType(
        raw,
      )}`,
    });
    return undefined;
  }
  const required = validateValidationCommands(
    raw["required"],
    joinPath(path, "required"),
    issues,
    /* required */ true,
  );
  if (required === undefined) return undefined;
  const out: AgentValidation = { required };
  if (raw["repair"] !== undefined) {
    if (!isPlainObject(raw["repair"])) {
      issues.push({
        path: joinPath(path, "repair"),
        code: "MISSING_REQUIRED_FIELD",
        message: "agent.validation.repair must be an object",
      });
    } else {
      const max = raw["repair"]["maxAttempts"];
      if (!isNonNegativeNumber(max)) {
        issues.push({
          path: joinPath(path, "repair.maxAttempts"),
          code: "MISSING_REQUIRED_FIELD",
          message:
            "agent.validation.repair.maxAttempts is required (non-negative number)",
        });
      } else {
        out.repair = { maxAttempts: max };
      }
    }
  }
  return out;
}

function validateValidationCommands(
  raw: unknown,
  path: string,
  issues: SchemaIssue[],
  required: boolean,
): AgentValidationCommand[] | undefined {
  if (raw === undefined) {
    if (required) {
      issues.push({
        path,
        code: "MISSING_REQUIRED_FIELD",
        message: `${path} is required (array of {command} objects)`,
      });
    }
    return undefined;
  }
  if (!Array.isArray(raw)) {
    issues.push({
      path,
      code: "MISSING_REQUIRED_FIELD",
      message: `${path} must be an array, received ${describeJsType(raw)}`,
    });
    return undefined;
  }
  if (required && raw.length === 0) {
    issues.push({
      path,
      code: "MISSING_REQUIRED_FIELD",
      message: `${path} must contain at least one entry`,
    });
    return undefined;
  }
  const out: AgentValidationCommand[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    const itemPath = `${path}[${i}]`;
    if (!isPlainObject(item)) {
      issues.push({
        path: itemPath,
        code: "MISSING_REQUIRED_FIELD",
        message: `${itemPath} must be an object`,
      });
      continue;
    }
    const command = item["command"];
    if (typeof command !== "string" || command.length === 0) {
      issues.push({
        path: joinPath(itemPath, "command"),
        code: "MISSING_REQUIRED_FIELD",
        message: `${itemPath}.command is required (non-empty string)`,
      });
      continue;
    }
    const entry: AgentValidationCommand = { command };
    if (typeof item["id"] === "string" && item["id"].length > 0)
      entry.id = item["id"];
    out.push(entry);
  }
  return out;
}

function validateAgentPolicy(
  raw: unknown,
  path: string,
  issues: SchemaIssue[],
): AgentPolicy | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    issues.push({
      path,
      code: "MISSING_REQUIRED_FIELD",
      message: `agent.policy must be an object, received ${describeJsType(
        raw,
      )}`,
    });
    return undefined;
  }
  const policy: AgentPolicy = {};
  if (raw["timeoutMs"] !== undefined) {
    if (!isPositiveFiniteNumber(raw["timeoutMs"])) {
      issues.push({
        path: joinPath(path, "timeoutMs"),
        code: "MISSING_REQUIRED_FIELD",
        message: "agent.policy.timeoutMs must be a positive number",
      });
    } else {
      policy.timeoutMs = raw["timeoutMs"];
    }
  }
  if (raw["budgetCents"] !== undefined) {
    if (typeof raw["budgetCents"] !== "number") {
      issues.push({
        path: joinPath(path, "budgetCents"),
        code: "MISSING_REQUIRED_FIELD",
        message: "agent.policy.budgetCents must be a number",
      });
    } else {
      policy.budgetCents = raw["budgetCents"];
    }
  }
  if (raw["maxToolCalls"] !== undefined) {
    if (!isPositiveFinitePolicyNumber(raw["maxToolCalls"])) {
      issues.push({
        path: joinPath(path, "maxToolCalls"),
        code: "MISSING_REQUIRED_FIELD",
        message: "agent.policy.maxToolCalls must be a positive integer",
      });
    } else {
      policy.maxToolCalls = raw["maxToolCalls"];
    }
  }
  if (raw["workingDirectory"] !== undefined) {
    if (typeof raw["workingDirectory"] !== "string") {
      issues.push({
        path: joinPath(path, "workingDirectory"),
        code: "MISSING_REQUIRED_FIELD",
        message: "agent.policy.workingDirectory must be a string",
      });
    } else {
      policy.workingDirectory = raw["workingDirectory"];
    }
  }
  if (raw["approval"] !== undefined) {
    if (!isPlainObject(raw["approval"])) {
      issues.push({
        path: joinPath(path, "approval"),
        code: "MISSING_REQUIRED_FIELD",
        message: "agent.policy.approval must be an object",
      });
    } else {
      const requiredFor = raw["approval"]["requiredFor"];
      if (requiredFor === undefined) {
        policy.approval = {};
      } else if (
        Array.isArray(requiredFor) &&
        requiredFor.every((v): v is string => typeof v === "string")
      ) {
        policy.approval = { requiredFor };
      } else {
        issues.push({
          path: joinPath(path, "approval.requiredFor"),
          code: "MISSING_REQUIRED_FIELD",
          message:
            "agent.policy.approval.requiredFor must be an array of strings",
        });
      }
    }
  }
  if (raw["audit"] !== undefined) {
    if (!isPlainObject(raw["audit"])) {
      issues.push({
        path: joinPath(path, "audit"),
        code: "MISSING_REQUIRED_FIELD",
        message: "agent.policy.audit must be an object",
      });
    } else {
      const audit: NonNullable<AgentPolicy["audit"]> = {};
      if (typeof raw["audit"]["captureToolCalls"] === "boolean") {
        audit.captureToolCalls = raw["audit"]["captureToolCalls"];
      }
      if (typeof raw["audit"]["captureDiffs"] === "boolean") {
        audit.captureDiffs = raw["audit"]["captureDiffs"];
      }
      policy.audit = audit;
    }
  }
  return policy;
}

function validateAgentTemplateRef(
  raw: unknown,
  path: string,
  issues: SchemaIssue[],
): AgentTemplateRef | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    issues.push({
      path,
      code: "MISSING_REQUIRED_FIELD",
      message: `agent.template must be an object when present, received ${describeJsType(
        raw,
      )}`,
    });
    return undefined;
  }
  const ref = raw["ref"];
  if (typeof ref !== "string" || ref.length === 0) {
    issues.push({
      path: joinPath(path, "ref"),
      code: "MISSING_REQUIRED_FIELD",
      message: "agent.template.ref is required (non-empty string)",
    });
    return undefined;
  }
  const out: AgentTemplateRef = { ref };
  if (raw["inputDefaults"] !== undefined) {
    if (!isPlainObject(raw["inputDefaults"])) {
      issues.push({
        path: joinPath(path, "inputDefaults"),
        code: "MISSING_REQUIRED_FIELD",
        message: "agent.template.inputDefaults must be an object when present",
      });
    } else {
      out.inputDefaults = raw["inputDefaults"];
    }
  }
  return out;
}

function optionalString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: SchemaIssue[],
): string | undefined {
  if (!(key in obj) || obj[key] === undefined) return undefined;
  const v = obj[key];
  if (typeof v !== "string") {
    issues.push({
      path: joinPath(path, key),
      code: "MISSING_REQUIRED_FIELD",
      message: `${key} must be a string when present`,
    });
    return undefined;
  }
  return v;
}

function optionalStringArray(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: SchemaIssue[],
): string[] | undefined {
  if (!(key in obj) || obj[key] === undefined) return undefined;
  const v = obj[key];
  if (Array.isArray(v) && v.every((x): x is string => typeof x === "string"))
    return v;
  issues.push({
    path: joinPath(path, key),
    code: "MISSING_REQUIRED_FIELD",
    message: `${key} must be an array of strings when present`,
  });
  return undefined;
}

function optionalObject(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: SchemaIssue[],
): Record<string, unknown> | undefined {
  if (!(key in obj) || obj[key] === undefined) return undefined;
  const v = obj[key];
  if (isPlainObject(v)) return v;
  issues.push({
    path: joinPath(path, key),
    code: "MISSING_REQUIRED_FIELD",
    message: `${key} must be an object when present`,
  });
  return undefined;
}
