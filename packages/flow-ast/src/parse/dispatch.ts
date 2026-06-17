/**
 * Top-level FlowNode dispatcher and the recursive `parseNodeArray` helper.
 * Per-kind parsers live in sibling files and are wired in here.
 *
 * Recursive child parsing is passed through `ParseContext` so per-kind files
 * never import this dispatcher back and create module cycles.
 */

import type { FlowNode } from "../types.js";
import {
  type ParseContext,
  KNOWN_NODE_TYPES,
  describeJsType,
  isPlainObject,
  joinPointer,
} from "./shared.js";
import { parseSequence } from "./sequence.js";
import { parseAction } from "./action.js";
import { parseForEach } from "./for-each.js";
import { parseBranch } from "./branch.js";
import { parseApproval } from "./approval.js";
import { parseClarification } from "./clarification.js";
import { parsePersona } from "./persona.js";
import { parseRoute } from "./route.js";
import { parseParallel } from "./parallel.js";
import { parseComplete } from "./complete.js";
import { parseSpawn } from "./spawn.js";
import { parseClassify } from "./classify.js";
import { parseEmit } from "./emit.js";
import { parseMemory } from "./memory.js";
import { parseSet } from "./set.js";
import { parseCheckpoint } from "./checkpoint.js";
import { parseRestore } from "./restore.js";
import { parseTryCatch } from "./try-catch.js";
import { parseLoop } from "./loop.js";
import { parseHttp } from "./http.js";
import { parseWait } from "./wait.js";
import { parseSubflow } from "./subflow.js";
import { parsePrompt } from "./prompt.js";
import { parseReturnTo } from "./return-to.js";
import { parseAgent, parseValidateNode } from "./agent.js";
import { parseWorkerDispatch } from "./worker-dispatch.js";
import {
  parseFleetDispatch,
  parseFleetGather,
  parseFleetContractNet,
} from "./fleet.js";
import { parseKnowledgeWrite, parseKnowledgeQuery } from "./knowledge.js";
import { parseAdapterRun } from "./adapter-run.js";
import { parseAdapterRace } from "./adapter-race.js";
import { parseAdapterParallel } from "./adapter-parallel.js";
import { parseAdapterSupervisor } from "./adapter-supervisor.js";

export function parseNode(
  value: unknown,
  pointer: string,
  ctx: ParseContext
): FlowNode | null {
  if (!isPlainObject(value)) {
    ctx.errors.push({
      code: "EXPECTED_OBJECT",
      message: `Expected node object, received ${describeJsType(value)}`,
      pointer,
    });
    return null;
  }

  if (!("type" in value)) {
    ctx.errors.push({
      code: "MISSING_TYPE",
      message: 'Node is missing required "type" discriminator',
      pointer,
    });
    return null;
  }

  const typeValue = value.type;
  if (typeof typeValue !== "string") {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: `Field "type" must be a string, received ${describeJsType(
        typeValue
      )}`,
      pointer: joinPointer(pointer, "type"),
    });
    return null;
  }

  if (!KNOWN_NODE_TYPES.has(typeValue)) {
    ctx.errors.push({
      code: "UNKNOWN_NODE_TYPE",
      message: `Unknown node type "${typeValue}"`,
      pointer,
    });
    return null;
  }

  switch (typeValue) {
    case "sequence":
      return parseSequence(value, pointer, ctx);
    case "action":
      return parseAction(value, pointer, ctx);
    case "for_each":
      return parseForEach(value, pointer, ctx);
    case "branch":
      return parseBranch(value, pointer, ctx);
    case "approval":
      return parseApproval(value, pointer, ctx);
    case "clarification":
      return parseClarification(value, pointer, ctx);
    case "persona":
      return parsePersona(value, pointer, ctx);
    case "route":
      return parseRoute(value, pointer, ctx);
    case "parallel":
      return parseParallel(value, pointer, ctx);
    case "complete":
      return parseComplete(value, pointer, ctx);
    case "spawn":
      return parseSpawn(value, pointer, ctx);
    case "classify":
      return parseClassify(value, pointer, ctx);
    case "emit":
      return parseEmit(value, pointer, ctx);
    case "memory":
      return parseMemory(value, pointer, ctx);
    case "set":
      return parseSet(value, pointer, ctx);
    case "checkpoint":
      return parseCheckpoint(value, pointer, ctx);
    case "restore":
      return parseRestore(value, pointer, ctx);
    case "try_catch":
      return parseTryCatch(value, pointer, ctx);
    case "loop":
      return parseLoop(value, pointer, ctx);
    case "http":
      return parseHttp(value, pointer, ctx);
    case "wait":
      return parseWait(value, pointer, ctx);
    case "subflow":
      return parseSubflow(value, pointer, ctx);
    case "prompt":
      return parsePrompt(value, pointer, ctx);
    case "return_to":
      return parseReturnTo(value, pointer, ctx);
    case "agent":
      return parseAgent(value, pointer, ctx);
    case "validate":
      return parseValidateNode(value, pointer, ctx);
    case "worker.dispatch":
      return parseWorkerDispatch(value, pointer, ctx);
    case "fleet.dispatch":
      return parseFleetDispatch(value, pointer, ctx);
    case "fleet.gather":
      return parseFleetGather(value, pointer, ctx);
    case "fleet.contract-net":
      return parseFleetContractNet(value, pointer, ctx);
    case "knowledge.write":
      return parseKnowledgeWrite(value, pointer, ctx);
    case "knowledge.query":
      return parseKnowledgeQuery(value, pointer, ctx);
    case "adapter.run":
      return parseAdapterRun(value, pointer, ctx);
    case "adapter.race":
      return parseAdapterRace(value, pointer, ctx);
    case "adapter.parallel":
      return parseAdapterParallel(value, pointer, ctx);
    case "adapter.supervisor":
      return parseAdapterSupervisor(value, pointer, ctx);
    default:
      // Defensive — KNOWN_NODE_TYPES is the source of truth above.
      ctx.errors.push({
        code: "UNKNOWN_NODE_TYPE",
        message: `Unknown node type "${typeValue}"`,
        pointer,
      });
      return null;
  }
}

export function parseNodeArray(
  items: unknown[],
  basePointer: string,
  ctx: ParseContext
): FlowNode[] {
  const out: FlowNode[] = [];
  for (let i = 0; i < items.length; i++) {
    const child = parseNode(items[i], joinPointer(basePointer, String(i)), ctx);
    if (child) out.push(child);
  }
  return out;
}
