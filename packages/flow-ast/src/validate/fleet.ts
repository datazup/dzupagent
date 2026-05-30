import type {
  FlowNode,
  FleetDispatchNode,
  FleetGatherNode,
  FleetContractNetNode,
} from "../types.js";
import { describeJsType, joinPath } from "../validation-helpers.js";
import { validateCommonNodeFields } from "./shared.js";
import type { SchemaIssue } from "./shared.js";

const FLEET_DISPATCH_MODES = new Set([
  "supervisor",
  "contract-net",
  "fan-out",
  "dependency",
]);

export function validateFleetDispatch(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[]
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues);

  const mode = obj["mode"];
  if (typeof mode !== "string" || !FLEET_DISPATCH_MODES.has(mode)) {
    issues.push({
      path: joinPath(path, "mode"),
      code: "MISSING_REQUIRED_FIELD",
      message: `fleet.dispatch.mode must be one of supervisor|contract-net|fan-out|dependency, received ${describeJsType(
        mode
      )}`,
    });
    return null;
  }

  if (!("repos" in obj)) {
    issues.push({
      path: joinPath(path, "repos"),
      code: "MISSING_REQUIRED_FIELD",
      message: "fleet.dispatch.repos is required",
    });
    return null;
  }

  if (typeof obj["repos"] !== "string" && !Array.isArray(obj["repos"])) {
    issues.push({
      path: joinPath(path, "repos"),
      code: "MISSING_REQUIRED_FIELD",
      message: `fleet.dispatch.repos must be a string or array, received ${describeJsType(
        obj["repos"]
      )}`,
    });
    return null;
  }

  if (!("task" in obj)) {
    issues.push({
      path: joinPath(path, "task"),
      code: "MISSING_REQUIRED_FIELD",
      message: "fleet.dispatch.task is required",
    });
    return null;
  }

  const node: FleetDispatchNode = {
    type: "fleet.dispatch",
    ...common,
    mode: mode as FleetDispatchNode["mode"],
    repos: obj["repos"],
    task: obj["task"],
  };

  if (typeof obj["on_contract_change"] === "string") {
    node.on_contract_change = obj["on_contract_change"];
  }
  if (typeof obj["output"] === "string") {
    node.output = obj["output"];
  }

  return node;
}

export function validateFleetGather(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[]
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues);

  const source = obj["source"];
  if (typeof source !== "string" || source.length === 0) {
    issues.push({
      path: joinPath(path, "source"),
      code: "MISSING_REQUIRED_FIELD",
      message: `fleet.gather.source is required (non-empty string), received ${describeJsType(
        source
      )}`,
    });
    return null;
  }

  const node: FleetGatherNode = { type: "fleet.gather", ...common, source };
  if (typeof obj["strategy"] === "string") node.strategy = obj["strategy"];
  if (typeof obj["output"] === "string") node.output = obj["output"];
  return node;
}

export function validateFleetContractNet(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[]
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues);

  if (!("repos" in obj)) {
    issues.push({
      path: joinPath(path, "repos"),
      code: "MISSING_REQUIRED_FIELD",
      message: "fleet.contract-net.repos is required",
    });
    return null;
  }

  if (typeof obj["repos"] !== "string" && !Array.isArray(obj["repos"])) {
    issues.push({
      path: joinPath(path, "repos"),
      code: "MISSING_REQUIRED_FIELD",
      message: `fleet.contract-net.repos must be a string or array, received ${describeJsType(
        obj["repos"]
      )}`,
    });
    return null;
  }

  if (!("task" in obj)) {
    issues.push({
      path: joinPath(path, "task"),
      code: "MISSING_REQUIRED_FIELD",
      message: "fleet.contract-net.task is required",
    });
    return null;
  }

  const node: FleetContractNetNode = {
    type: "fleet.contract-net",
    ...common,
    repos: obj["repos"],
    task: obj["task"],
  };

  if (typeof obj["output"] === "string") node.output = obj["output"];
  return node;
}
