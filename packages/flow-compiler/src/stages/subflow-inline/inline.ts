import type { FlowNode } from "@dzupagent/flow-ast";

import type {
  CompilationDiagnostic,
  FlowCompileSubflowEvidence,
  FlowDocumentResolver,
} from "../../types.js";
import { collectReferenceScope } from "./reference-scope.js";
import { instanceIdFor, rewriteValue } from "./rewrite.js";

// ---------------------------------------------------------------------------
// Subflow resolution + node inlining
// ---------------------------------------------------------------------------
// Recursively resolves `subflow` nodes against the document resolver, inlines
// their bodies (with cycle detection), and recurses through every control-flow
// container. Each inlined subflow is namespaced via the rewrite pass and
// recorded as evidence.

function diagnostic(
  code: "UNKNOWN_SUBFLOW_REF" | "SUBFLOW_CYCLE",
  message: string,
  nodePath: string
): CompilationDiagnostic {
  return {
    stage: 2,
    code,
    message,
    nodePath,
    category: "resolution",
  };
}

export async function inlineNode(
  node: FlowNode,
  resolver: FlowDocumentResolver,
  path: string,
  stack: string[],
  diagnostics: CompilationDiagnostic[],
  subflows: FlowCompileSubflowEvidence[]
): Promise<FlowNode[]> {
  if (node.type === "subflow") {
    if (stack.includes(node.flowRef)) {
      diagnostics.push(
        diagnostic(
          "SUBFLOW_CYCLE",
          `Subflow cycle detected: ${[...stack, node.flowRef].join(" -> ")}`,
          path
        )
      );
      return [];
    }

    const document = await resolver.resolve(node.flowRef);
    if (!document) {
      diagnostics.push(
        diagnostic(
          "UNKNOWN_SUBFLOW_REF",
          `Unknown subflow reference "${node.flowRef}"`,
          path
        )
      );
      return [];
    }

    const nested = await inlineSequence(
      document.root.nodes,
      resolver,
      `${path}.root.nodes`,
      [...stack, node.flowRef],
      diagnostics,
      subflows
    );
    const instanceId = instanceIdFor(node);
    const referenceScope = collectReferenceScope(nested);
    subflows.push({ flowRef: node.flowRef, instanceId, nodePath: path });
    return nested.map(
      (child) =>
        rewriteValue(
          child,
          instanceId,
          child.type,
          0,
          true,
          referenceScope
        ) as FlowNode
    );
  }

  if (node.type === "sequence") {
    return [
      {
        ...node,
        nodes: await inlineSequence(
          node.nodes,
          resolver,
          `${path}.nodes`,
          stack,
          diagnostics,
          subflows
        ),
      },
    ];
  }

  if (node.type === "branch") {
    return [
      {
        ...node,
        then: await inlineSequence(
          node.then,
          resolver,
          `${path}.then`,
          stack,
          diagnostics,
          subflows
        ),
        ...(node.else
          ? {
              else: await inlineSequence(
                node.else,
                resolver,
                `${path}.else`,
                stack,
                diagnostics,
                subflows
              ),
            }
          : {}),
      },
    ];
  }

  if (node.type === "parallel") {
    const branches = await Promise.all(
      node.branches.map((branch, index) =>
        inlineSequence(
          branch,
          resolver,
          `${path}.branches[${index}]`,
          stack,
          diagnostics,
          subflows
        )
      )
    );
    return [{ ...node, branches }];
  }

  if (node.type === "for_each") {
    return [
      {
        ...node,
        body: await inlineSequence(
          node.body,
          resolver,
          `${path}.body`,
          stack,
          diagnostics,
          subflows
        ),
      },
    ];
  }

  if (node.type === "approval") {
    return [
      {
        ...node,
        onApprove: await inlineSequence(
          node.onApprove,
          resolver,
          `${path}.onApprove`,
          stack,
          diagnostics,
          subflows
        ),
        ...(node.onReject
          ? {
              onReject: await inlineSequence(
                node.onReject,
                resolver,
                `${path}.onReject`,
                stack,
                diagnostics,
                subflows
              ),
            }
          : {}),
      },
    ];
  }

  if (
    node.type === "persona" ||
    node.type === "route" ||
    node.type === "loop"
  ) {
    return [
      {
        ...node,
        body: await inlineSequence(
          node.body,
          resolver,
          `${path}.body`,
          stack,
          diagnostics,
          subflows
        ),
      },
    ];
  }

  if (node.type === "try_catch") {
    return [
      {
        ...node,
        body: await inlineSequence(
          node.body,
          resolver,
          `${path}.body`,
          stack,
          diagnostics,
          subflows
        ),
        catch: await inlineSequence(
          node.catch,
          resolver,
          `${path}.catch`,
          stack,
          diagnostics,
          subflows
        ),
      },
    ];
  }

  return [node];
}

export async function inlineSequence(
  nodes: readonly FlowNode[],
  resolver: FlowDocumentResolver,
  path: string,
  stack: string[],
  diagnostics: CompilationDiagnostic[],
  subflows: FlowCompileSubflowEvidence[]
): Promise<FlowNode[]> {
  const output: FlowNode[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (!node) continue;
    output.push(
      ...(await inlineNode(
        node,
        resolver,
        `${path}[${index}]`,
        stack,
        diagnostics,
        subflows
      ))
    );
  }
  return output;
}
