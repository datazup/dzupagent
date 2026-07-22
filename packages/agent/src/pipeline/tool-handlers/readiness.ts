import type { PipelineDefinition, ToolNode } from "@dzupagent/core/pipeline";

import type { RuntimeToolHandlers } from "../pipeline-runtime-types.js";
import { isRecord, optionalString } from "./arg-helpers.js";
import { RUNTIME_TOOL_NAMES } from "./constants.js";
import { isRuntimeSetNode, isRuntimeToolNode } from "./node-predicates.js";

export interface RuntimeToolReadinessNode {
  nodeId: string;
  toolName: string;
  ready: boolean;
  builtIn: boolean;
  stateWriteKeys: string[];
}

export interface RuntimeToolReadinessResult {
  ready: boolean;
  requiredToolNames: string[];
  missingToolNames: string[];
  builtInToolNames: string[];
  expectedStateWriteKeys: string[];
  nodes: RuntimeToolReadinessNode[];
}

export function getRuntimeToolReadiness(
  definition: PipelineDefinition,
  handlers: RuntimeToolHandlers | undefined
): RuntimeToolReadinessResult {
  const nodes: RuntimeToolReadinessNode[] = [];
  const requiredToolNames: string[] = [];
  const missingToolNames: string[] = [];
  const builtInToolNames: string[] = [];
  const expectedStateWriteKeys: string[] = [];
  const seenRequired = new Set<string>();
  const seenMissing = new Set<string>();
  const seenBuiltIn = new Set<string>();
  const seenStateWrite = new Set<string>();

  for (const node of definition.nodes) {
    if (!isRuntimeToolNode(node)) continue;
    const builtInReady = isRuntimeSetNode(node);
    const stateWriteKeys = runtimeToolStateWriteKeys(node);

    if (!seenRequired.has(node.toolName)) {
      seenRequired.add(node.toolName);
      requiredToolNames.push(node.toolName);
    }
    if (builtInReady && !seenBuiltIn.has(node.toolName)) {
      seenBuiltIn.add(node.toolName);
      builtInToolNames.push(node.toolName);
    }
    for (const key of stateWriteKeys) {
      if (seenStateWrite.has(key)) continue;
      seenStateWrite.add(key);
      expectedStateWriteKeys.push(key);
    }

    const ready = builtInReady || handlers?.[node.toolName] !== undefined;
    nodes.push({
      nodeId: node.id,
      toolName: node.toolName,
      ready,
      builtIn: builtInReady,
      stateWriteKeys,
    });

    if (!ready && !seenMissing.has(node.toolName)) {
      seenMissing.add(node.toolName);
      missingToolNames.push(node.toolName);
    }
  }

  return {
    ready: missingToolNames.length === 0,
    requiredToolNames,
    missingToolNames,
    builtInToolNames,
    expectedStateWriteKeys,
    nodes,
  };
}

function runtimeToolStateWriteKeys(node: ToolNode): string[] {
  const args = node.arguments ?? {};
  if (node.toolName === RUNTIME_TOOL_NAMES.set) {
    const assign = args["assign"];
    return isRecord(assign) ? Object.keys(assign) : [];
  }

  const keyName = runtimeToolStateKeyArgumentName(node.toolName);
  if (keyName === undefined) return [];
  const key = optionalString(args, keyName);
  if (key !== undefined) return [key];

  if (node.toolName === RUNTIME_TOOL_NAMES.prompt) {
    return [node.id];
  }
  return [];
}

function runtimeToolStateKeyArgumentName(toolName: string): string | undefined {
  switch (toolName) {
    case RUNTIME_TOOL_NAMES.prompt:
      return "outputKey";
    case RUNTIME_TOOL_NAMES.workerDispatch:
      return "outputKey";
    case RUNTIME_TOOL_NAMES.shellRun:
    case RUNTIME_TOOL_NAMES.validateSchema:
    case RUNTIME_TOOL_NAMES.adapterRun:
    case RUNTIME_TOOL_NAMES.adapterRace:
    case RUNTIME_TOOL_NAMES.adapterParallel:
    case RUNTIME_TOOL_NAMES.adapterSupervisor:
      return "output";
    default:
      return undefined;
  }
}

export function formatRuntimeToolReadinessError(
  readiness: RuntimeToolReadinessResult
): string {
  const missingNodes = readiness.nodes.filter((node) => !node.ready);
  if (missingNodes.length === 0) return "Runtime tool handlers are ready.";

  const details = missingNodes
    .map(
      (node) =>
        `missing handler for "${node.toolName}" used by node "${node.nodeId}"`
    )
    .join("; ");
  return `Runtime tool handlers are not ready: ${details}`;
}

export function formatRuntimeToolReadinessReport(
  readiness: RuntimeToolReadinessResult
): string {
  const lines = [
    `Runtime tool readiness: ${readiness.ready ? "ready" : "not ready"}`,
    `Required tools: ${formatList(readiness.requiredToolNames)}`,
    `Built-in tools: ${formatList(readiness.builtInToolNames)}`,
    `Missing handlers: ${formatList(readiness.missingToolNames)}`,
    `Expected state writes: ${formatList(readiness.expectedStateWriteKeys)}`,
    "Nodes:",
  ];

  for (const node of readiness.nodes) {
    const readinessLabel = node.ready ? "ready" : "missing";
    const ownershipLabel = node.builtIn ? "built-in" : "host";
    lines.push(
      `- ${node.nodeId}: ${
        node.toolName
      } [${readinessLabel}, ${ownershipLabel}] writes ${formatList(
        node.stateWriteKeys
      )}`
    );
  }

  return lines.join("\n");
}

function formatList(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}
