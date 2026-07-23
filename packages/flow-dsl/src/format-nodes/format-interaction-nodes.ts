import {
  formatScalar,
  indentFor,
  pushCommon,
  quote,
  type FormatContext,
  type NodeOf,
} from "./format-helpers.js";

/** Interaction, routing, state, and I/O node categories. */
export function formatInteractionNode(
  ctx: FormatContext,
  node: NodeOf<
    | "approval"
    | "clarification"
    | "persona"
    | "route"
    | "complete"
    | "spawn"
    | "classify"
    | "emit"
    | "memory"
    | "set"
    | "checkpoint"
    | "restore"
    | "http"
    | "subflow"
    | "prompt"
  >,
  indentLevel: number
): void {
  const { lines, formatNode } = ctx;
  const indent = indentFor(indentLevel);
  const childIndent = indentFor(indentLevel + 2);
  switch (node.type) {
    case "approval":
      lines.push(`${indent}- approval:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}question: ${quote(node.question)}`);
      if (node.options && node.options.length > 0) {
        lines.push(
          `${childIndent}options: [${node.options.map(quote).join(", ")}]`
        );
      }
      lines.push(`${childIndent}on_approve:`);
      for (const child of node.onApprove)
        formatNode(lines, child, indentLevel + 3);
      if (node.onReject && node.onReject.length > 0) {
        lines.push(`${childIndent}on_reject:`);
        for (const child of node.onReject)
          formatNode(lines, child, indentLevel + 3);
      }
      return;
    case "clarification":
      lines.push(`${indent}- clarify:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}question: ${quote(node.question)}`);
      if (node.expected) lines.push(`${childIndent}expected: ${node.expected}`);
      if (node.choices && node.choices.length > 0) {
        lines.push(
          `${childIndent}choices: [${node.choices.map(quote).join(", ")}]`
        );
      }
      return;
    case "persona":
      lines.push(`${indent}- persona:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}ref: ${node.personaId}`);
      lines.push(`${childIndent}body:`);
      for (const child of node.body) formatNode(lines, child, indentLevel + 3);
      return;
    case "route":
      lines.push(`${indent}- route:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}strategy: ${node.strategy}`);
      if (node.provider) lines.push(`${childIndent}provider: ${node.provider}`);
      if (node.tags && node.tags.length > 0) {
        lines.push(`${childIndent}tags: [${node.tags.map(quote).join(", ")}]`);
      }
      lines.push(`${childIndent}body:`);
      for (const child of node.body) formatNode(lines, child, indentLevel + 3);
      return;
    case "complete":
      lines.push(`${indent}- complete:`);
      pushCommon(lines, node, indentLevel + 2);
      if (node.result !== undefined)
        lines.push(`${childIndent}result: ${quote(node.result)}`);
      return;
    case "spawn":
      lines.push(`${indent}- spawn:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}template: ${node.templateRef}`);
      if (node.waitForCompletion !== undefined)
        lines.push(`${childIndent}wait: ${node.waitForCompletion}`);
      return;
    case "classify":
      lines.push(`${indent}- classify:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}prompt: ${quote(node.prompt)}`);
      lines.push(
        `${childIndent}choices: [${node.choices.map(quote).join(", ")}]`
      );
      lines.push(`${childIndent}output: ${node.outputKey}`);
      if (node.defaultChoice)
        lines.push(`${childIndent}default: ${quote(node.defaultChoice)}`);
      return;
    case "emit":
      lines.push(`${indent}- emit:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}event: ${quote(node.event)}`);
      if (node.payload && Object.keys(node.payload).length > 0) {
        lines.push(`${childIndent}payload:`);
        for (const [key, value] of Object.entries(node.payload)) {
          lines.push(`${childIndent}  ${key}: ${formatScalar(value)}`);
        }
      }
      return;
    case "memory":
      lines.push(`${indent}- memory:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}operation: ${node.operation}`);
      lines.push(`${childIndent}tier: ${node.tier}`);
      if (node.key) lines.push(`${childIndent}key: ${quote(node.key)}`);
      if (node.outputVar) lines.push(`${childIndent}output: ${node.outputVar}`);
      return;
    case "set":
      lines.push(`${indent}- set:`);
      pushCommon(lines, node, indentLevel + 2);
      if (Object.keys(node.assign).length > 0) {
        lines.push(`${childIndent}assign:`);
        for (const [key, value] of Object.entries(node.assign)) {
          lines.push(`${childIndent}  ${key}: ${formatScalar(value)}`);
        }
      } else {
        lines.push(`${childIndent}assign: {}`);
      }
      return;
    case "checkpoint":
      lines.push(`${indent}- checkpoint:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(
        `${childIndent}captureOutputOf: ${quote(node.captureOutputOf)}`
      );
      if (node.label !== undefined)
        lines.push(`${childIndent}label: ${quote(node.label)}`);
      return;
    case "restore":
      lines.push(`${indent}- restore:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(
        `${childIndent}checkpointLabel: ${quote(node.checkpointLabel)}`
      );
      if (node.onNotFound !== undefined)
        lines.push(`${childIndent}onNotFound: ${node.onNotFound}`);
      return;
    case "http":
      lines.push(`${indent}- http:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}url: ${quote(node.url)}`);
      if (node.method) lines.push(`${childIndent}method: ${node.method}`);
      if (node.auth) {
        lines.push(`${childIndent}auth:`);
        lines.push(`${childIndent}  scheme: ${node.auth.scheme}`);
        lines.push(
          `${childIndent}  credential: ${quote(node.auth.credential)}`
        );
        lines.push(`${childIndent}  provider: ${quote(node.auth.provider)}`);
        lines.push(
          `${childIndent}  scopes: [${node.auth.scopes
            .map((scope) => quote(scope))
            .join(", ")}]`
        );
        if (node.auth.headerName) {
          lines.push(
            `${childIndent}  headerName: ${quote(node.auth.headerName)}`
          );
        }
      }
      if (node.outputVar) lines.push(`${childIndent}output: ${node.outputVar}`);
      return;
    case "subflow":
      lines.push(`${indent}- subflow:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}flowRef: ${quote(node.flowRef)}`);
      if (node.outputVar) lines.push(`${childIndent}output: ${node.outputVar}`);
      return;
    case "prompt":
      lines.push(`${indent}- prompt:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}userPrompt: ${quote(node.userPrompt)}`);
      if (node.systemPrompt)
        lines.push(`${childIndent}systemPrompt: ${quote(node.systemPrompt)}`);
      if (node.outputKey)
        lines.push(`${childIndent}outputKey: ${node.outputKey}`);
      if (node.provider) lines.push(`${childIndent}provider: ${node.provider}`);
      if (node.model) lines.push(`${childIndent}model: ${node.model}`);
      if (node.tools) lines.push(`${childIndent}tools: true`);
      return;
    default: {
      const _exhaustive: never = node;
      void _exhaustive;
    }
  }
}
