import {
  formatScalar,
  indentFor,
  pushCommon,
  pushObjectBlock,
  pushTextField,
  quote,
  type FormatContext,
  type NodeOf,
} from "./format-helpers.js";

/** Interfaces lack index signatures; bridge them into `pushObjectBlock`. */
function asRecord(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}

/** Agent, validation, and multi-provider adapter node categories. */
export function formatAgentNode(
  ctx: FormatContext,
  node: NodeOf<
    | "agent"
    | "validate"
    | "adapter.run"
    | "adapter.race"
    | "adapter.parallel"
    | "adapter.supervisor"
  >,
  indentLevel: number
): void {
  const { lines } = ctx;
  const indent = indentFor(indentLevel);
  const childIndent = indentFor(indentLevel + 2);
  switch (node.type) {
    case "agent":
      lines.push(`${indent}- agent:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}agentId: ${node.agentId}`);
      if (node.profile) lines.push(`${childIndent}profile: ${node.profile}`);
      if (node.toolset) lines.push(`${childIndent}toolset: ${node.toolset}`);
      if (node.tools)
        lines.push(`${childIndent}tools: ${formatScalar(node.tools)}`);
      if (node.model) lines.push(`${childIndent}model: ${node.model}`);
      if (node.provider) lines.push(`${childIndent}provider: ${node.provider}`);
      pushTextField(lines, indentLevel + 2, "instructions", node.instructions);
      if (node.input)
        pushObjectBlock(lines, indentLevel + 2, "input", node.input);
      if (node.stop)
        pushObjectBlock(lines, indentLevel + 2, "stop", asRecord(node.stop));
      lines.push(`${childIndent}output:`);
      lines.push(`${childIndent}  key: ${node.output.key}`);
      if (node.output.schemaRef)
        lines.push(`${childIndent}  schemaRef: ${node.output.schemaRef}`);
      if (node.output.schema)
        pushObjectBlock(lines, indentLevel + 3, "schema", node.output.schema);
      if (node.onInvalidOutput)
        pushObjectBlock(
          lines,
          indentLevel + 2,
          "onInvalidOutput",
          asRecord(node.onInvalidOutput)
        );
      if (node.retry)
        pushObjectBlock(lines, indentLevel + 2, "retry", asRecord(node.retry));
      if (node.validation)
        pushObjectBlock(
          lines,
          indentLevel + 2,
          "validation",
          asRecord(node.validation)
        );
      if (node.policy)
        pushObjectBlock(
          lines,
          indentLevel + 2,
          "policy",
          asRecord(node.policy)
        );
      return;
    case "validate":
      lines.push(`${indent}- validate:`);
      pushCommon(lines, node, indentLevel + 2);
      if (node.ref) lines.push(`${childIndent}ref: ${node.ref}`);
      if (node.commands && node.commands.length > 0) {
        lines.push(`${childIndent}commands:`);
        for (const cmd of node.commands) {
          lines.push(`${childIndent}  - command: ${quote(cmd.command)}`);
          if (cmd.id) lines.push(`${childIndent}    id: ${cmd.id}`);
        }
      }
      if (node.repair) {
        lines.push(`${childIndent}repair:`);
        lines.push(`${childIndent}  maxAttempts: ${node.repair.maxAttempts}`);
        if (node.repair.onFailure)
          lines.push(`${childIndent}  onFailure: ${node.repair.onFailure}`);
      }
      return;
    case "adapter.run":
      lines.push(`${indent}- adapter.run:`);
      pushCommon(lines, node, indentLevel + 2);
      if (node.provider) lines.push(`${childIndent}provider: ${node.provider}`);
      if (node.tags && node.tags.length > 0) {
        lines.push(`${childIndent}tags: [${node.tags.map(quote).join(", ")}]`);
      }
      if (node.model) lines.push(`${childIndent}model: ${node.model}`);
      if (node.systemPrompt)
        pushTextField(
          lines,
          indentLevel + 2,
          "systemPrompt",
          node.systemPrompt
        );
      pushTextField(lines, indentLevel + 2, "instructions", node.instructions);
      if (node.input)
        lines.push(`${childIndent}input: ${formatScalar(node.input)}`);
      if (node.persona) lines.push(`${childIndent}persona: ${node.persona}`);
      if (node.reasoning)
        lines.push(`${childIndent}reasoning: ${node.reasoning}`);
      if (node.outputSchema !== undefined)
        lines.push(
          `${childIndent}outputSchema: ${
            typeof node.outputSchema === "string"
              ? node.outputSchema
              : formatScalar(node.outputSchema)
          }`
        );
      if (node.promptPrep)
        lines.push(`${childIndent}promptPrep: ${node.promptPrep}`);
      if (node.policy)
        lines.push(`${childIndent}policy: ${formatScalar(node.policy)}`);
      lines.push(`${childIndent}output: ${node.output}`);
      return;
    case "adapter.race":
      lines.push(`${indent}- adapter.race:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(
        `${childIndent}providers: [${node.providers.map(quote).join(", ")}]`
      );
      if (node.model) lines.push(`${childIndent}model: ${node.model}`);
      if (node.systemPrompt)
        pushTextField(
          lines,
          indentLevel + 2,
          "systemPrompt",
          node.systemPrompt
        );
      pushTextField(lines, indentLevel + 2, "instructions", node.instructions);
      if (node.input)
        lines.push(`${childIndent}input: ${formatScalar(node.input)}`);
      if (node.persona) lines.push(`${childIndent}persona: ${node.persona}`);
      if (node.reasoning)
        lines.push(`${childIndent}reasoning: ${node.reasoning}`);
      if (node.outputSchema !== undefined)
        lines.push(
          `${childIndent}outputSchema: ${
            typeof node.outputSchema === "string"
              ? node.outputSchema
              : formatScalar(node.outputSchema)
          }`
        );
      if (node.promptPrep)
        lines.push(`${childIndent}promptPrep: ${node.promptPrep}`);
      if (node.policy)
        lines.push(`${childIndent}policy: ${formatScalar(node.policy)}`);
      lines.push(`${childIndent}output: ${node.output}`);
      return;
    case "adapter.parallel":
      lines.push(`${indent}- adapter.parallel:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(
        `${childIndent}providers: [${node.providers.map(quote).join(", ")}]`
      );
      if (node.merge) lines.push(`${childIndent}merge: ${node.merge}`);
      if (node.model) lines.push(`${childIndent}model: ${node.model}`);
      if (node.systemPrompt)
        pushTextField(
          lines,
          indentLevel + 2,
          "systemPrompt",
          node.systemPrompt
        );
      pushTextField(lines, indentLevel + 2, "instructions", node.instructions);
      if (node.input)
        lines.push(`${childIndent}input: ${formatScalar(node.input)}`);
      if (node.persona) lines.push(`${childIndent}persona: ${node.persona}`);
      if (node.reasoning)
        lines.push(`${childIndent}reasoning: ${node.reasoning}`);
      if (node.outputSchema !== undefined)
        lines.push(
          `${childIndent}outputSchema: ${
            typeof node.outputSchema === "string"
              ? node.outputSchema
              : formatScalar(node.outputSchema)
          }`
        );
      if (node.promptPrep)
        lines.push(`${childIndent}promptPrep: ${node.promptPrep}`);
      if (node.policy)
        lines.push(`${childIndent}policy: ${formatScalar(node.policy)}`);
      lines.push(`${childIndent}output: ${node.output}`);
      return;
    case "adapter.supervisor":
      lines.push(`${indent}- adapter.supervisor:`);
      pushCommon(lines, node, indentLevel + 2);
      pushTextField(lines, indentLevel + 2, "goal", node.goal);
      if (node.specialists && node.specialists.length > 0) {
        lines.push(
          `${childIndent}specialists: [${node.specialists
            .map(quote)
            .join(", ")}]`
        );
      }
      if (node.model) lines.push(`${childIndent}model: ${node.model}`);
      if (node.systemPrompt)
        pushTextField(
          lines,
          indentLevel + 2,
          "systemPrompt",
          node.systemPrompt
        );
      if (node.input)
        lines.push(`${childIndent}input: ${formatScalar(node.input)}`);
      if (node.persona) lines.push(`${childIndent}persona: ${node.persona}`);
      if (node.reasoning)
        lines.push(`${childIndent}reasoning: ${node.reasoning}`);
      if (node.outputSchema !== undefined)
        lines.push(
          `${childIndent}outputSchema: ${
            typeof node.outputSchema === "string"
              ? node.outputSchema
              : formatScalar(node.outputSchema)
          }`
        );
      if (node.promptPrep)
        lines.push(`${childIndent}promptPrep: ${node.promptPrep}`);
      if (node.policy)
        lines.push(`${childIndent}policy: ${formatScalar(node.policy)}`);
      lines.push(`${childIndent}output: ${node.output}`);
      return;
    default: {
      const _exhaustive: never = node;
      void _exhaustive;
    }
  }
}
