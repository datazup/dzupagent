import type { FlowDocumentV1, FlowNode } from "@dzupagent/flow-ast";

export function formatDocumentToDsl(document: FlowDocumentV1): string {
  const lines: string[] = [];
  pushField(lines, 0, "dsl", "dzupflow/v1");
  pushField(lines, 0, "id", document.id);
  if (document.title) pushField(lines, 0, "title", document.title);
  if (document.description)
    pushField(
      lines,
      0,
      "description",
      document.description.includes("\n") ? "|" : document.description
    );
  if (document.description?.includes("\n")) {
    for (const line of document.description.split("\n")) {
      lines.push(`  ${line}`);
    }
  }
  pushField(lines, 0, "version", document.version);
  if (document.inputs && Object.keys(document.inputs).length > 0) {
    lines.push("inputs:");
    for (const [key, spec] of Object.entries(document.inputs)) {
      if (
        spec.required === true &&
        spec.description === undefined &&
        spec.default === undefined
      ) {
        lines.push(`  ${key}: ${spec.type}`);
      } else {
        lines.push(`  ${key}:`);
        lines.push(`    type: ${spec.type}`);
        if (spec.required !== undefined)
          lines.push(`    required: ${String(spec.required)}`);
        if (spec.description !== undefined)
          lines.push(`    description: ${quote(spec.description)}`);
      }
    }
  }
  if (document.defaults && Object.keys(document.defaults).length > 0) {
    lines.push("defaults:");
    if (document.defaults.personaRef)
      lines.push(`  persona: ${document.defaults.personaRef}`);
    if (document.defaults.timeoutMs !== undefined)
      lines.push(`  timeout_ms: ${document.defaults.timeoutMs}`);
    if (document.defaults.retry) {
      lines.push("  retry:");
      lines.push(`    attempts: ${document.defaults.retry.attempts}`);
      if (document.defaults.retry.delayMs !== undefined) {
        lines.push(`    delayMs: ${document.defaults.retry.delayMs}`);
      }
    }
  }
  if (document.tags && document.tags.length > 0) {
    lines.push(`tags: [${document.tags.map(quote).join(", ")}]`);
  }
  if (document.meta && Object.keys(document.meta).length > 0) {
    lines.push("meta:");
    for (const [key, value] of Object.entries(document.meta)) {
      lines.push(`  ${key}: ${formatScalar(value)}`);
    }
  }

  lines.push("steps:");
  for (const node of document.root.nodes) {
    formatNode(lines, node, 1);
  }
  return lines.join("\n");
}

function formatNode(
  lines: string[],
  node: FlowNode,
  indentLevel: number
): void {
  const indent = "  ".repeat(indentLevel);
  const childIndent = "  ".repeat(indentLevel + 2);
  switch (node.type) {
    case "action":
      lines.push(`${indent}- action:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}ref: ${node.toolRef}`);
      if (node.personaRef)
        lines.push(`${childIndent}persona: ${node.personaRef}`);
      lines.push(`${childIndent}input:`);
      for (const [key, value] of Object.entries(node.input)) {
        lines.push(`${childIndent}  ${key}: ${formatScalar(value)}`);
      }
      return;
    case "branch":
      lines.push(`${indent}- if:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}condition: ${quote(node.condition)}`);
      lines.push(`${childIndent}then:`);
      for (const child of node.then) formatNode(lines, child, indentLevel + 3);
      if (node.else && node.else.length > 0) {
        lines.push(`${childIndent}else:`);
        for (const child of node.else)
          formatNode(lines, child, indentLevel + 3);
      }
      return;
    case "parallel": {
      lines.push(`${indent}- parallel:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}branches:`);
      const branchNames = Array.isArray(node.meta?.["branchNames"])
        ? node.meta!["branchNames"].filter(
            (value): value is string => typeof value === "string"
          )
        : [];
      node.branches.forEach((branch, index) => {
        const name = branchNames[index] ?? `branch_${index + 1}`;
        lines.push(`${childIndent}  ${name}:`);
        for (const child of branch) formatNode(lines, child, indentLevel + 4);
      });
      return;
    }
    case "for_each":
      lines.push(`${indent}- for_each:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}source: ${quote(node.source)}`);
      lines.push(`${childIndent}as: ${node.as}`);
      lines.push(`${childIndent}body:`);
      for (const child of node.body) formatNode(lines, child, indentLevel + 3);
      return;
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
    case "sequence":
      for (const child of node.nodes) formatNode(lines, child, indentLevel);
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
    case "try_catch":
      lines.push(`${indent}- try_catch:`);
      pushCommon(lines, node, indentLevel + 2);
      if (node.errorVar)
        lines.push(`${childIndent}error_var: ${node.errorVar}`);
      lines.push(`${childIndent}body:`);
      for (const child of node.body) formatNode(lines, child, indentLevel + 3);
      lines.push(`${childIndent}catch:`);
      for (const child of node.catch) formatNode(lines, child, indentLevel + 3);
      return;
    case "loop":
      lines.push(`${indent}- loop:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}condition: ${quote(node.condition)}`);
      if (node.maxIterations !== undefined)
        lines.push(`${childIndent}max_iterations: ${node.maxIterations}`);
      lines.push(`${childIndent}body:`);
      for (const child of node.body) formatNode(lines, child, indentLevel + 3);
      return;
    case "http":
      lines.push(`${indent}- http:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}url: ${quote(node.url)}`);
      if (node.method) lines.push(`${childIndent}method: ${node.method}`);
      if (node.outputVar) lines.push(`${childIndent}output: ${node.outputVar}`);
      return;
    case "wait":
      lines.push(`${indent}- wait:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}durationMs: ${node.durationMs}`);
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
    case "return_to":
      lines.push(`${indent}- return_to:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}targetId: ${node.targetId}`);
      lines.push(`${childIndent}condition: ${quote(node.condition)}`);
      if (node.maxIterations !== undefined)
        lines.push(`${childIndent}maxIterations: ${node.maxIterations}`);
      return;
    case "agent":
      lines.push(`${indent}- agent:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}agentId: ${node.agentId}`);
      if (node.profile) lines.push(`${childIndent}profile: ${node.profile}`);
      if (node.toolset) lines.push(`${childIndent}toolset: ${node.toolset}`);
      if (node.model) lines.push(`${childIndent}model: ${node.model}`);
      lines.push(`${childIndent}instructions: ${quote(node.instructions)}`);
      lines.push(`${childIndent}output:`);
      lines.push(`${childIndent}  key: ${node.output.key}`);
      if (node.output.schemaRef)
        lines.push(`${childIndent}  schemaRef: ${node.output.schemaRef}`);
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
    case "fleet.dispatch":
    case "fleet.gather":
    case "fleet.contract-net":
    case "knowledge.write":
    case "knowledge.query":
      lines.push(`${indent}- ${node.type}:`);
      pushCommon(lines, node, indentLevel + 2);
      return;
    default: {
      const _exhaustive: never = node;
      void _exhaustive;
    }
  }
}

function pushCommon(
  lines: string[],
  node: FlowNode,
  indentLevel: number
): void {
  const indent = "  ".repeat(indentLevel);
  if (node.id) lines.push(`${indent}id: ${node.id}`);
  if (node.name) lines.push(`${indent}name: ${quote(node.name)}`);
  if (node.description)
    lines.push(`${indent}description: ${quote(node.description)}`);
  if (
    node.meta &&
    Object.keys(node.meta).length > 0 &&
    !(node.type === "parallel" && node.meta.branchNames)
  ) {
    lines.push(`${indent}meta:`);
    for (const [key, value] of Object.entries(node.meta)) {
      lines.push(`${indent}  ${key}: ${formatScalar(value)}`);
    }
  }
}

function pushField(
  lines: string[],
  indentLevel: number,
  key: string,
  value: string | number
): void {
  const indent = "  ".repeat(indentLevel);
  lines.push(
    `${indent}${key}: ${typeof value === "string" ? quote(value) : value}`
  );
}

function quote(value: string): string {
  if (/^[A-Za-z0-9_.\/:-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function formatScalar(value: unknown): string {
  if (typeof value === "string") return quote(value);
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(formatScalar).join(", ")}]`;
  return JSON.stringify(value);
}
