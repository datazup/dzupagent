import type { distributedValidators } from "./shape-validate-rules-distributed.js";
import {
  emptyBody,
  isNonEmptyString,
  isPlainObject,
  missing,
  type ShapeRulePartial,
  type ShapeRuleTable,
} from "./shape-validate-shared.js";

/**
 * Control-flow + leaf structural validation rules (RF-9 / CODE-M-08 +
 * ARCH-M-06). The former ~36-branch `visit()` switch is now a data-driven rule
 * table: each FlowNode kind maps to a pure rule that pushes its own EMPTY_BODY /
 * MISSING_REQUIRED_FIELD defects and recurses into its child slices via
 * `ctx.visit`. The fleet/knowledge/worker/adapter rules live in
 * `shape-validate-rules-distributed.ts`; `shape-validate.ts` assembles both into
 * one exhaustive `ShapeRuleTable`. Pure refactor — behaviour is unchanged.
 */
export type ControlAndLeafKind = Exclude<
  keyof ShapeRuleTable,
  keyof typeof distributedValidators
>;

export const controlAndLeafValidators: ShapeRulePartial<ControlAndLeafKind> = {
  sequence: (node, { path, errors, visit }) => {
    if (node.nodes.length === 0) {
      errors.push(
        emptyBody(
          node.type,
          path,
          "sequence.nodes must contain at least one node",
        ),
      );
    }
    node.nodes.forEach((child, idx) => visit(child, `${path}.nodes[${idx}]`));
  },
  action: (node, { path, errors }) => {
    if (!isNonEmptyString(node.toolRef)) {
      errors.push(
        missing(
          node.type,
          path,
          "action.toolRef is required (non-empty string)",
        ),
      );
    }
    if (!isPlainObject(node.input)) {
      errors.push(
        missing(
          node.type,
          path,
          "action.input is required (object, may be empty)",
        ),
      );
    }
  },
  for_each: (node, { path, errors, visit }) => {
    if (!isNonEmptyString(node.source)) {
      errors.push(
        missing(
          node.type,
          path,
          "for_each.source is required (non-empty string)",
        ),
      );
    }
    if (!isNonEmptyString(node.as)) {
      errors.push(
        missing(node.type, path, "for_each.as is required (non-empty string)"),
      );
    }
    if (node.body.length === 0) {
      errors.push(
        emptyBody(
          node.type,
          path,
          "for_each.body must contain at least one node",
        ),
      );
    }
    node.body.forEach((child, idx) => visit(child, `${path}.body[${idx}]`));
  },
  branch: (node, { path, errors, visit }) => {
    if (!isNonEmptyString(node.condition)) {
      errors.push(
        missing(
          node.type,
          path,
          "branch.condition is required (non-empty string)",
        ),
      );
    }
    if (node.then.length === 0) {
      errors.push(
        emptyBody(
          node.type,
          path,
          "branch.then must contain at least one node",
        ),
      );
    }
    node.then.forEach((child, idx) => visit(child, `${path}.then[${idx}]`));
    if (node.else !== undefined) {
      if (node.else.length === 0) {
        errors.push(
          emptyBody(
            node.type,
            path,
            "branch.else, when present, must contain at least one node",
          ),
        );
      }
      node.else.forEach((child, idx) => visit(child, `${path}.else[${idx}]`));
    }
  },
  parallel: (node, { path, errors, visit }) => {
    if (node.branches.length === 0) {
      errors.push(
        emptyBody(
          node.type,
          path,
          "parallel.branches must contain at least one branch",
        ),
      );
    }
    node.branches.forEach((branch, bIdx) => {
      if (branch.length === 0) {
        errors.push(
          emptyBody(
            node.type,
            `${path}.branches[${bIdx}]`,
            "parallel.branches[*] must contain at least one node",
          ),
        );
      }
      branch.forEach((child, idx) =>
        visit(child, `${path}.branches[${bIdx}][${idx}]`),
      );
    });
  },
  approval: (node, { path, errors, visit }) => {
    if (!isNonEmptyString(node.question)) {
      errors.push(
        missing(
          node.type,
          path,
          "approval.question is required (non-empty string)",
        ),
      );
    }
    if (node.onApprove.length === 0) {
      errors.push(
        emptyBody(
          node.type,
          path,
          "approval.onApprove must contain at least one node",
        ),
      );
    }
    node.onApprove.forEach((child, idx) =>
      visit(child, `${path}.onApprove[${idx}]`),
    );
    if (node.onReject !== undefined) {
      if (node.onReject.length === 0) {
        errors.push(
          emptyBody(
            node.type,
            path,
            "approval.onReject, when present, must contain at least one node",
          ),
        );
      }
      node.onReject.forEach((child, idx) =>
        visit(child, `${path}.onReject[${idx}]`),
      );
    }
  },
  clarification: (node, { path, errors }) => {
    if (!isNonEmptyString(node.question)) {
      errors.push(
        missing(
          node.type,
          path,
          "clarification.question is required (non-empty string)",
        ),
      );
    }
    if (node.expected === "choice") {
      if (!Array.isArray(node.choices) || node.choices.length === 0) {
        errors.push(
          missing(
            node.type,
            path,
            "clarification.choices is required (non-empty array) when expected='choice'",
          ),
        );
      }
    }
  },
  persona: (node, { path, errors, visit }) => {
    if (!isNonEmptyString(node.personaId)) {
      errors.push(
        missing(
          node.type,
          path,
          "persona.personaId is required (non-empty string)",
        ),
      );
    }
    if (node.body.length === 0) {
      errors.push(
        emptyBody(
          node.type,
          path,
          "persona.body must contain at least one node",
        ),
      );
    }
    node.body.forEach((child, idx) => visit(child, `${path}.body[${idx}]`));
  },
  route: (node, { path, errors, visit }) => {
    if (node.strategy === "fixed-provider") {
      if (!isNonEmptyString(node.provider)) {
        errors.push(
          missing(
            node.type,
            path,
            "route.provider is required (non-empty string) when strategy='fixed-provider'",
          ),
        );
      }
    } else if (node.strategy === "capability") {
      if (!Array.isArray(node.tags) || node.tags.length === 0) {
        errors.push(
          missing(
            node.type,
            path,
            "route.tags is required (non-empty array) when strategy='capability'",
          ),
        );
      }
    }
    if (node.body.length === 0) {
      errors.push(
        emptyBody(node.type, path, "route.body must contain at least one node"),
      );
    }
    node.body.forEach((child, idx) => visit(child, `${path}.body[${idx}]`));
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
          "spawn.templateRef is required (non-empty string)",
        ),
      );
    }
  },
  classify: (node, { path, errors }) => {
    if (!isNonEmptyString(node.prompt)) {
      errors.push(
        missing(
          node.type,
          path,
          "classify.prompt is required (non-empty string)",
        ),
      );
    }
    if (!Array.isArray(node.choices) || node.choices.length === 0) {
      errors.push(
        missing(
          node.type,
          path,
          "classify.choices is required (non-empty array)",
        ),
      );
    }
    if (!isNonEmptyString(node.outputKey)) {
      errors.push(
        missing(
          node.type,
          path,
          "classify.outputKey is required (non-empty string)",
        ),
      );
    }
    if (node.defaultChoice !== undefined) {
      if (!isNonEmptyString(node.defaultChoice)) {
        errors.push(
          missing(
            node.type,
            path,
            "classify.defaultChoice must be a non-empty string when present",
          ),
        );
      } else if (
        !Array.isArray(node.choices) ||
        !node.choices.includes(node.defaultChoice)
      ) {
        errors.push(
          missing(
            node.type,
            path,
            "classify.defaultChoice must match one of classify.choices",
          ),
        );
      }
    }
  },
  emit: (node, { path, errors }) => {
    if (!isNonEmptyString(node.event)) {
      errors.push(
        missing(node.type, path, "emit.event is required (non-empty string)"),
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
          "checkpoint.captureOutputOf is required (non-empty string)",
        ),
      );
    }
  },
  restore: (node, { path, errors }) => {
    if (!isNonEmptyString(node.checkpointLabel)) {
      errors.push(
        missing(
          node.type,
          path,
          "restore.checkpointLabel is required (non-empty string)",
        ),
      );
    }
  },
  try_catch: (node, { path, errors, visit }) => {
    if (node.body.length === 0) {
      errors.push(
        emptyBody(
          node.type,
          path,
          "try_catch.body must contain at least one node",
        ),
      );
    }
    node.body.forEach((child, idx) => visit(child, `${path}.body[${idx}]`));
    node.catch.forEach((child, idx) => visit(child, `${path}.catch[${idx}]`));
  },
  loop: (node, { path, errors, visit }) => {
    if (!isNonEmptyString(node.condition)) {
      errors.push(
        missing(
          node.type,
          path,
          "loop.condition is required (non-empty string)",
        ),
      );
    }
    if (node.body.length === 0) {
      errors.push(
        emptyBody(node.type, path, "loop.body must contain at least one node"),
      );
    }
    node.body.forEach((child, idx) => visit(child, `${path}.body[${idx}]`));
  },
  http: (node, { path, errors }) => {
    if (!isNonEmptyString(node.url)) {
      errors.push(
        missing(node.type, path, "http.url is required (non-empty string)"),
      );
    }
  },
  wait: (node, { path, errors }) => {
    if (typeof node.durationMs !== "number" || node.durationMs < 0) {
      errors.push(
        missing(
          node.type,
          path,
          "wait.durationMs is required (non-negative number)",
        ),
      );
    }
  },
  subflow: (node, { path, errors }) => {
    if (!isNonEmptyString(node.flowRef)) {
      errors.push(
        missing(
          node.type,
          path,
          "subflow.flowRef is required (non-empty string)",
        ),
      );
    }
  },
  prompt: (node, { path, errors }) => {
    if (!isNonEmptyString(node.userPrompt)) {
      errors.push(
        missing(
          node.type,
          path,
          "prompt.userPrompt is required (non-empty string)",
        ),
      );
    }
  },
  return_to: (node, { path, errors }) => {
    if (!isNonEmptyString(node.targetId)) {
      errors.push(
        missing(
          node.type,
          path,
          "return_to.targetId is required (non-empty string)",
        ),
      );
    }
    if (!isNonEmptyString(node.condition)) {
      errors.push(
        missing(
          node.type,
          path,
          "return_to.condition is required (non-empty string)",
        ),
      );
    }
  },
  agent: (node, { path, errors }) => {
    if (!isNonEmptyString(node.agentId)) {
      errors.push(
        missing(
          node.type,
          path,
          "agent.agentId is required (non-empty string)",
        ),
      );
    }
    if (!isNonEmptyString(node.instructions)) {
      errors.push(
        missing(
          node.type,
          path,
          "agent.instructions is required (non-empty string)",
        ),
      );
    }
    if (!isPlainObject(node.output) || !isNonEmptyString(node.output.key)) {
      errors.push(
        missing(
          node.type,
          path,
          "agent.output.key is required (non-empty string)",
        ),
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
          "agent.output requires either schemaRef or inline schema",
        ),
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
          "validate node requires either ref or non-empty commands",
        ),
      );
    }
  },
};
