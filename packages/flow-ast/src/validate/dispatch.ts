/**
 * Top-level FlowNode dispatcher and the recursive `validateNodeArray`
 * helper. Per-kind validators live in sibling files and are wired in here.
 *
 * Recursive child validation is injected into per-kind validators so they do
 * not import this dispatcher back and create module cycles.
 */

import type { FlowNode } from "../types.js";
import {
  describeJsType,
  isPlainObject,
  joinPath,
} from "../validation-helpers.js";
import { KNOWN_NODE_TYPES } from "../validation-descriptors.js";
import type { SchemaIssue } from "./shared.js";
import { validateSequence } from "./sequence.js";
import { validateAction } from "./action.js";
import { validateForEach } from "./for-each.js";
import { validateBranch } from "./branch.js";
import { validateApproval } from "./approval.js";
import { validateClarification } from "./clarification.js";
import { validatePersona } from "./persona.js";
import { validateRoute } from "./route.js";
import { validateParallel } from "./parallel.js";
import { validateComplete } from "./complete.js";
import { validateSpawn } from "./spawn.js";
import { validateClassify } from "./classify.js";
import { validateEmit } from "./emit.js";
import { validateMemory } from "./memory.js";
import { validateSet } from "./set.js";
import { validateCheckpoint } from "./checkpoint.js";
import { validateRestore } from "./restore.js";
import { validateTryCatch } from "./try-catch.js";
import { validateLoop } from "./loop.js";
import { validateHttp } from "./http.js";
import { validateWait } from "./wait.js";
import { validateSubflow } from "./subflow.js";
import { validatePrompt } from "./prompt.js";
import { validateReturnTo } from "./return-to.js";
import { validateAgent, validateValidateNode } from "./agent.js";
import { validateWorkerDispatch } from "./worker-dispatch.js";
import {
  validateFleetDispatch,
  validateFleetGather,
  validateFleetContractNet,
} from "./fleet.js";
import { validateKnowledgeWrite, validateKnowledgeQuery } from "./knowledge.js";
import { validateAdapterRun } from "./adapter-run.js";
import { validateAdapterRace } from "./adapter-race.js";
import { validateAdapterParallel } from "./adapter-parallel.js";

export function validateFlowNode(
  value: unknown,
  path: string,
  issues: SchemaIssue[]
): FlowNode | null {
  if (!isPlainObject(value)) {
    issues.push({
      path,
      code: "MISSING_REQUIRED_FIELD",
      message: `Expected node object, received ${describeJsType(value)}`,
    });
    return null;
  }

  const typeVal = value["type"];
  if (typeof typeVal !== "string") {
    issues.push({
      path: joinPath(path, "type"),
      code: "MISSING_REQUIRED_FIELD",
      message: `Node.type is required (string), received ${describeJsType(
        typeVal
      )}`,
    });
    return null;
  }

  if (!KNOWN_NODE_TYPES.has(typeVal)) {
    issues.push({
      path,
      code: "MISSING_REQUIRED_FIELD",
      message: `Unknown node type "${typeVal}"`,
    });
    return null;
  }

  switch (typeVal) {
    case "sequence":
      return validateSequence(value, path, issues, validateNodeArray);
    case "action":
      return validateAction(value, path, issues);
    case "for_each":
      return validateForEach(value, path, issues, validateNodeArray);
    case "branch":
      return validateBranch(value, path, issues, validateNodeArray);
    case "approval":
      return validateApproval(value, path, issues, validateNodeArray);
    case "clarification":
      return validateClarification(value, path, issues);
    case "persona":
      return validatePersona(value, path, issues, validateNodeArray);
    case "route":
      return validateRoute(value, path, issues, validateNodeArray);
    case "parallel":
      return validateParallel(value, path, issues, validateNodeArray);
    case "complete":
      return validateComplete(value, path, issues);
    case "spawn":
      return validateSpawn(value, path, issues);
    case "classify":
      return validateClassify(value, path, issues);
    case "emit":
      return validateEmit(value, path, issues);
    case "memory":
      return validateMemory(value, path, issues);
    case "set":
      return validateSet(value, path, issues);
    case "checkpoint":
      return validateCheckpoint(value, path, issues);
    case "restore":
      return validateRestore(value, path, issues);
    case "try_catch":
      return validateTryCatch(value, path, issues, validateNodeArray);
    case "loop":
      return validateLoop(value, path, issues, validateNodeArray);
    case "http":
      return validateHttp(value, path, issues);
    case "wait":
      return validateWait(value, path, issues);
    case "subflow":
      return validateSubflow(value, path, issues);
    case "prompt":
      return validatePrompt(value, path, issues);
    case "return_to":
      return validateReturnTo(value, path, issues);
    case "agent":
      return validateAgent(value, path, issues);
    case "validate":
      return validateValidateNode(value, path, issues);
    case "worker.dispatch":
      return validateWorkerDispatch(value, path, issues);
    case "fleet.dispatch":
      return validateFleetDispatch(value, path, issues);
    case "fleet.gather":
      return validateFleetGather(value, path, issues);
    case "fleet.contract-net":
      return validateFleetContractNet(value, path, issues);
    case "knowledge.write":
      return validateKnowledgeWrite(value, path, issues);
    case "knowledge.query":
      return validateKnowledgeQuery(value, path, issues);
    case "adapter.run":
      return validateAdapterRun(value, path, issues);
    case "adapter.race":
      return validateAdapterRace(value, path, issues);
    case "adapter.parallel":
      return validateAdapterParallel(value, path, issues);
    default:
      issues.push({
        path,
        code: "MISSING_REQUIRED_FIELD",
        message: `Unknown node type "${typeVal}"`,
      });
      return null;
  }
}

export function validateNodeArray(
  value: unknown,
  path: string,
  issues: SchemaIssue[]
): FlowNode[] | null {
  if (!Array.isArray(value)) {
    issues.push({
      path,
      code: "MISSING_REQUIRED_FIELD",
      message: `Expected array of nodes at ${path}, received ${describeJsType(
        value
      )}`,
    });
    return null;
  }
  const out: FlowNode[] = [];
  for (let i = 0; i < value.length; i++) {
    const child = validateFlowNode(value[i], `${path}[${i}]`, issues);
    if (child !== null) out.push(child);
  }
  return out;
}
