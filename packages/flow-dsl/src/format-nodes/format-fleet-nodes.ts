import {
  formatScalar,
  indentFor,
  pushCommon,
  quote,
  type FormatContext,
  type NodeOf,
} from "./format-helpers.js";

/** Worker dispatch, fleet orchestration, knowledge, shell, and evidence nodes. */
export function formatFleetNode(
  ctx: FormatContext,
  node: NodeOf<
    | "worker.dispatch"
    | "fleet.dispatch"
    | "fleet.gather"
    | "fleet.contract-net"
    | "knowledge.write"
    | "knowledge.query"
    | "shell.run"
    | "evidence.write"
    | "validate.schema"
  >,
  indentLevel: number
): void {
  const { lines } = ctx;
  const indent = indentFor(indentLevel);
  const childIndent = indentFor(indentLevel + 2);
  switch (node.type) {
    case "worker.dispatch":
      lines.push(`${indent}- worker.dispatch:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}dispatchId: ${node.dispatchId}`);
      lines.push(`${childIndent}provider: ${node.provider}`);
      if (node.model) lines.push(`${childIndent}model: ${node.model}`);
      if (node.systemPrompt)
        lines.push(`${childIndent}systemPrompt: ${quote(node.systemPrompt)}`);
      lines.push(`${childIndent}instructions: ${quote(node.instructions)}`);
      if (node.input)
        lines.push(`${childIndent}input: ${formatScalar(node.input)}`);
      if (node.commandSurface)
        lines.push(`${childIndent}commandSurface: ${node.commandSurface}`);
      if (node.commandAllowlist && node.commandAllowlist.length > 0) {
        lines.push(
          `${childIndent}commandAllowlist: [${node.commandAllowlist
            .map(quote)
            .join(", ")}]`
        );
      }
      if (node.validationCommand)
        lines.push(
          `${childIndent}validationCommand: ${quote(node.validationCommand)}`
        );
      lines.push(`${childIndent}outputKey: ${node.outputKey}`);
      if (node.resultFormat)
        lines.push(`${childIndent}resultFormat: ${node.resultFormat}`);
      if (node.resultSchema)
        lines.push(`${childIndent}resultSchema: ${quote(node.resultSchema)}`);
      return;
    case "fleet.dispatch":
      lines.push(`${indent}- fleet.dispatch:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}mode: ${node.mode}`);
      lines.push(`${childIndent}repos: ${formatScalar(node.repos)}`);
      lines.push(`${childIndent}task: ${formatScalar(node.task)}`);
      if (node.on_contract_change)
        lines.push(
          `${childIndent}on_contract_change: ${node.on_contract_change}`
        );
      if (node.output) lines.push(`${childIndent}output: ${node.output}`);
      return;
    case "fleet.gather":
      lines.push(`${indent}- fleet.gather:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}source: ${node.source}`);
      if (node.strategy) lines.push(`${childIndent}strategy: ${node.strategy}`);
      if (node.output) lines.push(`${childIndent}output: ${node.output}`);
      return;
    case "fleet.contract-net":
      lines.push(`${indent}- fleet.contract-net:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}repos: ${formatScalar(node.repos)}`);
      lines.push(`${childIndent}task: ${formatScalar(node.task)}`);
      if (node.output) lines.push(`${childIndent}output: ${node.output}`);
      return;
    case "knowledge.write":
      lines.push(`${indent}- knowledge.write:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}scope: ${node.scope}`);
      lines.push(`${childIndent}entry: ${formatScalar(node.entry)}`);
      return;
    case "knowledge.query":
      lines.push(`${indent}- knowledge.query:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}filter: ${formatScalar(node.filter)}`);
      lines.push(`${childIndent}output: ${node.output}`);
      return;
    case "shell.run":
      lines.push(`${indent}- shell.run:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}command: ${quote(node.command)}`);
      if (node.cwd) lines.push(`${childIndent}cwd: ${quote(node.cwd)}`);
      if (node.timeoutMs !== undefined)
        lines.push(`${childIndent}timeoutMs: ${node.timeoutMs}`);
      if (node.required !== undefined)
        lines.push(`${childIndent}required: ${String(node.required)}`);
      if (node.allowFailure !== undefined)
        lines.push(`${childIndent}allowFailure: ${String(node.allowFailure)}`);
      lines.push(`${childIndent}output: ${node.output}`);
      if (node.effectClass)
        lines.push(`${childIndent}effectClass: ${node.effectClass}`);
      if (node.idempotency)
        lines.push(`${childIndent}idempotency: ${node.idempotency}`);
      return;
    case "evidence.write":
      lines.push(`${indent}- evidence.write:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}source: ${quote(node.source)}`);
      lines.push(`${childIndent}output: ${node.output}`);
      if (node.redact !== undefined)
        lines.push(`${childIndent}redact: ${String(node.redact)}`);
      if (node.effectClass)
        lines.push(`${childIndent}effectClass: ${node.effectClass}`);
      if (node.idempotency)
        lines.push(`${childIndent}idempotency: ${node.idempotency}`);
      return;
    case "validate.schema":
      lines.push(`${indent}- validate.schema:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}source: ${quote(node.source)}`);
      lines.push(`${childIndent}schema: ${formatScalar(node.schema)}`);
      lines.push(`${childIndent}output: ${node.output}`);
      if (node.effectClass)
        lines.push(`${childIndent}effectClass: ${node.effectClass}`);
      if (node.idempotency)
        lines.push(`${childIndent}idempotency: ${node.idempotency}`);
      return;
    default: {
      const _exhaustive: never = node;
      void _exhaustive;
    }
  }
}
