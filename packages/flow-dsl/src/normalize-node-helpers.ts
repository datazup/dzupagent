import type { FlowNode } from "@dzupagent/flow-ast";

import { DSL_ERROR } from "./errors.js";
import {
  normalizeAction,
  normalizeApproval,
  normalizeClarify,
  normalizeForEach,
  normalizeIf,
  normalizeParallel,
} from "./normalize-nodes-action.js";
import {
  normalizeCheckpoint,
  normalizeClassify,
  normalizeComplete,
  normalizePersona,
  normalizeRestore,
  normalizeRoute,
} from "./normalize-nodes-routing.js";
import {
  normalizeEmit,
  normalizeHttp,
  normalizeMemory,
  normalizePrompt,
  normalizeReturnTo,
  normalizeSpawn,
  normalizeSubflow,
  normalizeWait,
} from "./normalize-nodes-spawn-emit-memory.js";
import {
  normalizeLoop,
  normalizeTryCatch,
} from "./normalize-nodes-structural.js";
import { normalizeSet } from "./normalize-nodes-set.js";
import { normalizeAgent, normalizeValidate } from "./normalize-nodes-agent.js";
import { normalizeWorkerDispatch } from "./normalize-nodes-worker-dispatch.js";
import { normalizeAdapterRun } from "./normalize-nodes-adapter-run.js";
import { normalizeAdapterRace } from "./normalize-nodes-adapter-race.js";
import { normalizeAdapterParallel } from "./normalize-nodes-adapter-parallel.js";
import { normalizeAdapterSupervisor } from "./normalize-nodes-adapter-supervisor.js";
import {
  normalizeFleetContractNet,
  normalizeFleetDispatch,
  normalizeFleetGather,
  normalizeKnowledgeQuery,
  normalizeKnowledgeWrite,
} from "./normalize-nodes-fleet.js";
import { isPlainObject } from "./normalize-value-helpers.js";
import type { DslDiagnostic } from "./types.js";

export function normalizeSteps(
  raw: unknown,
  path: string,
  diagnostics: DslDiagnostic[]
): FlowNode[] {
  if (!Array.isArray(raw)) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: "steps must be an array",
      path,
    });
    return [];
  }
  const nodes: FlowNode[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const node = normalizeNodeWrapper(raw[i], `${path}[${i}]`, diagnostics);
    if (node) nodes.push(node);
  }
  return nodes;
}

export function normalizeNodeWrapper(
  raw: unknown,
  path: string,
  diagnostics: DslDiagnostic[]
): FlowNode | null {
  if (!isPlainObject(raw)) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: "step item must be an object wrapper",
      path,
    });
    return null;
  }

  const keys = Object.keys(raw);
  if (keys.length !== 1) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: "each step item must contain exactly one node wrapper key",
      path,
    });
    return null;
  }

  const kind = keys[0]!;
  const value = raw[kind];
  if (!isPlainObject(value)) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: `node wrapper "${kind}" must contain an object`,
      path,
    });
    return null;
  }

  switch (kind) {
    case "action":
      return normalizeAction(value, path, diagnostics);
    case "if":
      return normalizeIf(value, path, diagnostics, normalizeSteps);
    case "parallel":
      return normalizeParallel(value, path, diagnostics, normalizeSteps);
    case "for_each":
      return normalizeForEach(value, path, diagnostics, normalizeSteps);
    case "approval":
      return normalizeApproval(value, path, diagnostics, normalizeSteps);
    case "clarify":
      return normalizeClarify(value, path, diagnostics);
    case "persona":
      return normalizePersona(value, path, diagnostics, normalizeSteps);
    case "route":
      return normalizeRoute(value, path, diagnostics, normalizeSteps);
    case "complete":
      return normalizeComplete(value, path, diagnostics);
    case "classify":
      return normalizeClassify(value, path, diagnostics);
    case "checkpoint":
      return normalizeCheckpoint(value, path, diagnostics);
    case "restore":
      return normalizeRestore(value, path, diagnostics);
    case "spawn":
      return normalizeSpawn(value, path, diagnostics);
    case "emit":
      return normalizeEmit(value, path, diagnostics);
    case "memory":
      return normalizeMemory(value, path, diagnostics);
    case "set":
      return normalizeSet(value, path, diagnostics);
    case "try_catch":
      return normalizeTryCatch(value, path, diagnostics, normalizeSteps);
    case "loop":
      return normalizeLoop(value, path, diagnostics, normalizeSteps);
    case "http":
      return normalizeHttp(value, path, diagnostics);
    case "wait":
      return normalizeWait(value, path, diagnostics);
    case "subflow":
      return normalizeSubflow(value, path, diagnostics);
    case "prompt":
      return normalizePrompt(value, path, diagnostics);
    case "return_to":
      return normalizeReturnTo(value, path, diagnostics);
    case "agent":
      return normalizeAgent(value, path, diagnostics);
    case "validate":
      return normalizeValidate(value, path, diagnostics);
    case "worker.dispatch":
      return normalizeWorkerDispatch(value, path, diagnostics);
    case "fleet.dispatch":
      return normalizeFleetDispatch(value, path, diagnostics);
    case "fleet.gather":
      return normalizeFleetGather(value, path, diagnostics);
    case "fleet.contract-net":
      return normalizeFleetContractNet(value, path, diagnostics);
    case "knowledge.write":
      return normalizeKnowledgeWrite(value, path, diagnostics);
    case "knowledge.query":
      return normalizeKnowledgeQuery(value, path, diagnostics);
    case "adapter.run":
      return normalizeAdapterRun(value, path, diagnostics);
    case "adapter.race":
      return normalizeAdapterRace(value, path, diagnostics);
    case "adapter.parallel":
      return normalizeAdapterParallel(value, path, diagnostics);
    case "adapter.supervisor":
      return normalizeAdapterSupervisor(value, path, diagnostics);
    default:
      diagnostics.push({
        phase: "normalize",
        code: DSL_ERROR.UNKNOWN_NODE_TYPE,
        message: `Unknown node type "${kind}"`,
        path,
      });
      return null;
  }
}
