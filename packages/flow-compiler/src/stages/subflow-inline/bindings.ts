import type {
  FlowDocumentV1,
  FlowNode,
  FlowValue,
  SubflowNode,
} from "@dzupagent/flow-ast";

import type { CompilationDiagnostic } from "../../types.js";
import { inputStateKey } from "./constants.js";
import { privateKey } from "./rewrite.js";

const EMPTY_INPUTS: Readonly<Record<string, never>> = Object.freeze({});

export interface SubflowBoundary {
  inputKeys: ReadonlySet<string>;
  before: FlowNode[];
  after: FlowNode[];
}

/**
 * Build the explicit compile-time boundary around an inlined document.
 *
 * Child inputs are materialized as private state keys before the inlined body;
 * a declared `meta.subflowOutput` is copied to the invocation's public
 * `outputVar` after the body. This keeps child internals hygienic while making
 * the two authored subflow boundary fields real compiler semantics.
 */
export function createSubflowBoundary(
  invocation: SubflowNode,
  document: FlowDocumentV1,
  instanceId: string,
  path: string,
  diagnostics: CompilationDiagnostic[],
): SubflowBoundary {
  const specs = document.inputs ?? EMPTY_INPUTS;
  const provided = invocation.input ?? EMPTY_INPUTS;
  const inputKeys = new Set(Object.keys(specs));

  for (const key of Object.keys(provided)) {
    if (Object.hasOwn(specs, key)) continue;
    diagnostics.push(
      boundaryDiagnostic(
        "SUBFLOW_INPUT_UNKNOWN",
        `Subflow "${invocation.flowRef}" does not declare input "${key}"`,
        `${path}.input.${key}`,
      ),
    );
  }

  const assign: Record<string, FlowValue> = {};
  for (const [key, spec] of Object.entries(specs)) {
    let value: unknown;
    if (Object.hasOwn(provided, key)) value = provided[key];
    else if (spec.default !== undefined) value = spec.default;
    else if (spec.required) {
      diagnostics.push(
        boundaryDiagnostic(
          "SUBFLOW_INPUT_REQUIRED",
          `Subflow "${invocation.flowRef}" requires input "${key}"`,
          `${path}.input.${key}`,
        ),
      );
      value = null;
    } else value = null;

    assign[privateKey(instanceId, inputStateKey(key))] = value as FlowValue;
  }

  const before: FlowNode[] =
    Object.keys(assign).length === 0
      ? []
      : [
          {
            type: "set",
            id: privateKey(instanceId, "bind_inputs"),
            assign,
          },
        ];

  const after: FlowNode[] = [];
  if (invocation.outputVar !== undefined) {
    const declaredOutput = document.meta?.["subflowOutput"];
    if (typeof declaredOutput !== "string" || declaredOutput.length === 0) {
      diagnostics.push(
        boundaryDiagnostic(
          "SUBFLOW_OUTPUT_UNDECLARED",
          `Subflow "${invocation.flowRef}" must declare meta.subflowOutput before invocation outputVar "${invocation.outputVar}" can be bound`,
          `${path}.outputVar`,
        ),
      );
    } else {
      after.push({
        type: "set",
        id: privateKey(instanceId, "export_output"),
        assign: {
          [invocation.outputVar]: `{{ state.${privateKey(instanceId, declaredOutput)} }}`,
        },
      });
    }
  }

  return { inputKeys, before, after };
}

function boundaryDiagnostic(
  code:
    | "SUBFLOW_INPUT_REQUIRED"
    | "SUBFLOW_INPUT_UNKNOWN"
    | "SUBFLOW_OUTPUT_UNDECLARED",
  message: string,
  nodePath: string,
): CompilationDiagnostic {
  return {
    stage: 2,
    code,
    message,
    nodePath,
    category: "resolution",
  };
}
