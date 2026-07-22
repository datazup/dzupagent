import {
  isNonEmptyString,
  isPlainObject,
  missing,
  type ShapeRulePartial,
} from "../shape-validate-shared.js";

/**
 * Structural rules for the leaf FlowNode kinds — nodes with no child slices
 * (no traversal recursion), so their rules only emit MISSING_REQUIRED_FIELD
 * defects (plus the no-op leaves that carry no required fields beyond `type`).
 * Split out of `shape-validate-rules.ts` for the ARCH-M-06 / MJ-01 god-module
 * decomposition.
 *
 * Pure refactor: behaviour (defect codes, messages) is unchanged.
 */
export type LeafKind =
  | "action"
  | "clarification"
  | "complete"
  | "spawn"
  | "classify"
  | "emit"
  | "memory"
  | "set"
  | "checkpoint"
  | "restore"
  | "http"
  | "wait"
  | "subflow"
  | "prompt"
  | "return_to"
  | "agent"
  | "validate";

export const leafValidators: ShapeRulePartial<LeafKind> = {
  action: (node, { path, errors }) => {
    if (!isNonEmptyString(node.toolRef)) {
      errors.push(
        missing(
          node.type,
          path,
          "action.toolRef is required (non-empty string)"
        )
      );
    }
    if (!isPlainObject(node.input)) {
      errors.push(
        missing(
          node.type,
          path,
          "action.input is required (object, may be empty)"
        )
      );
    }
  },
  clarification: (node, { path, errors }) => {
    if (!isNonEmptyString(node.question)) {
      errors.push(
        missing(
          node.type,
          path,
          "clarification.question is required (non-empty string)"
        )
      );
    }
    if (node.expected === "choice") {
      if (!Array.isArray(node.choices) || node.choices.length === 0) {
        errors.push(
          missing(
            node.type,
            path,
            "clarification.choices is required (non-empty array) when expected='choice'"
          )
        );
      }
    }
  },
  complete: () => {
    // Leaf — no required fields beyond `type`.
  },
  spawn: (node, { path, errors }) => {
    if (!isNonEmptyString(node.templateRef)) {
      errors.push(
        missing(
          node.type,
          path,
          "spawn.templateRef is required (non-empty string)"
        )
      );
    }
  },
  classify: (node, { path, errors }) => {
    if (!isNonEmptyString(node.prompt)) {
      errors.push(
        missing(
          node.type,
          path,
          "classify.prompt is required (non-empty string)"
        )
      );
    }
    if (!Array.isArray(node.choices) || node.choices.length === 0) {
      errors.push(
        missing(
          node.type,
          path,
          "classify.choices is required (non-empty array)"
        )
      );
    }
    if (!isNonEmptyString(node.outputKey)) {
      errors.push(
        missing(
          node.type,
          path,
          "classify.outputKey is required (non-empty string)"
        )
      );
    }
    if (node.defaultChoice !== undefined) {
      if (!isNonEmptyString(node.defaultChoice)) {
        errors.push(
          missing(
            node.type,
            path,
            "classify.defaultChoice must be a non-empty string when present"
          )
        );
      } else if (
        !Array.isArray(node.choices) ||
        !node.choices.includes(node.defaultChoice)
      ) {
        errors.push(
          missing(
            node.type,
            path,
            "classify.defaultChoice must match one of classify.choices"
          )
        );
      }
    }
  },
  emit: (node, { path, errors }) => {
    if (!isNonEmptyString(node.event)) {
      errors.push(
        missing(node.type, path, "emit.event is required (non-empty string)")
      );
    }
  },
  memory: () => {},
  set: (node, { path, errors }) => {
    if (!isPlainObject(node.assign)) {
      errors.push(missing(node.type, path, "set.assign is required (object)"));
    }
  },
  checkpoint: (node, { path, errors }) => {
    if (!isNonEmptyString(node.captureOutputOf)) {
      errors.push(
        missing(
          node.type,
          path,
          "checkpoint.captureOutputOf is required (non-empty string)"
        )
      );
    }
  },
  restore: (node, { path, errors }) => {
    if (!isNonEmptyString(node.checkpointLabel)) {
      errors.push(
        missing(
          node.type,
          path,
          "restore.checkpointLabel is required (non-empty string)"
        )
      );
    }
  },
  http: (node, { path, errors }) => {
    if (!isNonEmptyString(node.url)) {
      errors.push(
        missing(node.type, path, "http.url is required (non-empty string)")
      );
    }
  },
  wait: (node, { path, errors }) => {
    if (typeof node.durationMs !== "number" || node.durationMs < 0) {
      errors.push(
        missing(
          node.type,
          path,
          "wait.durationMs is required (non-negative number)"
        )
      );
    }
  },
  subflow: (node, { path, errors }) => {
    if (!isNonEmptyString(node.flowRef)) {
      errors.push(
        missing(
          node.type,
          path,
          "subflow.flowRef is required (non-empty string)"
        )
      );
    }
  },
  prompt: (node, { path, errors }) => {
    if (!isNonEmptyString(node.userPrompt)) {
      errors.push(
        missing(
          node.type,
          path,
          "prompt.userPrompt is required (non-empty string)"
        )
      );
    }
  },
  return_to: (node, { path, errors }) => {
    if (!isNonEmptyString(node.targetId)) {
      errors.push(
        missing(
          node.type,
          path,
          "return_to.targetId is required (non-empty string)"
        )
      );
    }
    if (!isNonEmptyString(node.condition)) {
      errors.push(
        missing(
          node.type,
          path,
          "return_to.condition is required (non-empty string)"
        )
      );
    }
  },
  agent: (node, { path, errors }) => {
    if (!isNonEmptyString(node.agentId)) {
      errors.push(
        missing(node.type, path, "agent.agentId is required (non-empty string)")
      );
    }
    if (!isNonEmptyString(node.instructions)) {
      errors.push(
        missing(
          node.type,
          path,
          "agent.instructions is required (non-empty string)"
        )
      );
    }
    if (!isPlainObject(node.output) || !isNonEmptyString(node.output.key)) {
      errors.push(
        missing(
          node.type,
          path,
          "agent.output.key is required (non-empty string)"
        )
      );
    }
    if (
      isPlainObject(node.output) &&
      node.output.schemaRef === undefined &&
      node.output.schema === undefined
    ) {
      errors.push(
        missing(
          node.type,
          path,
          "agent.output requires either schemaRef or inline schema"
        )
      );
    }
  },
  validate: (node, { path, errors }) => {
    const hasRef = isNonEmptyString(node.ref);
    const hasCommands =
      Array.isArray(node.commands) && node.commands.length > 0;
    if (!hasRef && !hasCommands) {
      errors.push(
        missing(
          node.type,
          path,
          "validate node requires either ref or non-empty commands"
        )
      );
    }
  },
};
