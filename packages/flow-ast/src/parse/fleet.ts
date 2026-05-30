import type {
  FleetDispatchNode,
  FleetGatherNode,
  FleetContractNetNode,
} from "../types.js";
import {
  type ParseContext,
  describeJsType,
  joinPointer,
  parseCommonNodeFields,
} from "./shared.js";

const FLEET_DISPATCH_MODES = new Set([
  "supervisor",
  "contract-net",
  "fan-out",
  "dependency",
]);

export function parseFleetDispatch(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext
): FleetDispatchNode | null {
  const common = parseCommonNodeFields(obj, pointer, ctx);

  const mode = obj.mode;
  if (typeof mode !== "string" || !FLEET_DISPATCH_MODES.has(mode)) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: `fleet.dispatch.mode must be one of supervisor|contract-net|fan-out|dependency, received ${describeJsType(
        mode
      )}`,
      pointer: joinPointer(pointer, "mode"),
    });
    return null;
  }

  if (!("repos" in obj)) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: "fleet.dispatch.repos is required",
      pointer: joinPointer(pointer, "repos"),
    });
    return null;
  }

  if (typeof obj.repos !== "string" && !Array.isArray(obj.repos)) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: `fleet.dispatch.repos must be a string or array, received ${describeJsType(
        obj.repos
      )}`,
      pointer: joinPointer(pointer, "repos"),
    });
    return null;
  }

  if (!("task" in obj)) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: "fleet.dispatch.task is required",
      pointer: joinPointer(pointer, "task"),
    });
    return null;
  }

  const node: FleetDispatchNode = {
    type: "fleet.dispatch",
    ...common,
    mode: mode as FleetDispatchNode["mode"],
    repos: obj.repos,
    task: obj.task,
  };

  if (typeof obj.on_contract_change === "string") {
    node.on_contract_change = obj.on_contract_change;
  }
  if (typeof obj.output === "string") {
    node.output = obj.output;
  }

  return node;
}

export function parseFleetGather(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext
): FleetGatherNode | null {
  const common = parseCommonNodeFields(obj, pointer, ctx);

  const source = obj.source;
  if (typeof source !== "string" || source.length === 0) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: `fleet.gather.source must be a non-empty string, received ${describeJsType(
        source
      )}`,
      pointer: joinPointer(pointer, "source"),
    });
    return null;
  }

  const node: FleetGatherNode = {
    type: "fleet.gather",
    ...common,
    source,
  };

  if (typeof obj.strategy === "string") node.strategy = obj.strategy;
  if (typeof obj.output === "string") node.output = obj.output;

  return node;
}

export function parseFleetContractNet(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext
): FleetContractNetNode | null {
  const common = parseCommonNodeFields(obj, pointer, ctx);

  if (!("repos" in obj)) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: "fleet.contract-net.repos is required",
      pointer: joinPointer(pointer, "repos"),
    });
    return null;
  }

  if (typeof obj.repos !== "string" && !Array.isArray(obj.repos)) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: `fleet.contract-net.repos must be a string or array, received ${describeJsType(
        obj.repos
      )}`,
      pointer: joinPointer(pointer, "repos"),
    });
    return null;
  }

  if (!("task" in obj)) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: "fleet.contract-net.task is required",
      pointer: joinPointer(pointer, "task"),
    });
    return null;
  }

  const node: FleetContractNetNode = {
    type: "fleet.contract-net",
    ...common,
    repos: obj.repos,
    task: obj.task,
  };

  if (typeof obj.output === "string") node.output = obj.output;

  return node;
}
