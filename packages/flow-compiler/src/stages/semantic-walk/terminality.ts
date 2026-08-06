import type { FlowNode, ValidationError } from "@dzupagent/flow-ast";

// ---------------------------------------------------------------------------
// Terminal-continuation validation (DSL-03)
// ---------------------------------------------------------------------------

/**
 * A terminal node must never have a normal continuation. `complete` declares
 * the flow finished; any later sibling in the same child list is unreachable —
 * the lowerer refuses to wire an edge to it, so it silently never runs.
 *
 * Surface that at validation time, per admission profile:
 *   • interactive → non-fatal warning (authoring feedback), and
 *   • unattended  → hard error (dead work must not be admitted for
 *     autonomous execution).
 *
 * One diagnostic is emitted per child list, anchored on the first unreachable
 * sibling — mirroring the granularity of the lowering warning.
 */
export function validateTerminalContinuations(
  ast: FlowNode,
  errors: ValidationError[],
  warnings: ValidationError[],
  admissionProfile: "interactive" | "unattended"
): void {
  const sink = admissionProfile === "unattended" ? errors : warnings;
  walk(ast, "root", sink);
}

function walk(node: FlowNode, path: string, sink: ValidationError[]): void {
  for (const { list, pathFor } of childLists(node, path)) {
    checkList(list, pathFor, sink);
    for (let idx = 0; idx < list.length; idx++) {
      const child = list[idx];
      if (child !== undefined) {
        walk(child, pathFor(idx), sink);
      }
    }
  }
}

function checkList(
  list: readonly (FlowNode | undefined)[],
  pathFor: (idx: number) => string,
  sink: ValidationError[]
): void {
  for (let idx = 0; idx < list.length; idx++) {
    if (list[idx]?.type !== "complete") continue;
    for (let after = idx + 1; after < list.length; after++) {
      const unreachable = list[after];
      if (unreachable === undefined) continue;
      sink.push({
        nodeType: unreachable.type,
        nodePath: pathFor(after),
        code: "FLOW_UNREACHABLE_AFTER_TERMINAL",
        category: "control",
        message:
          `node is unreachable — it follows a terminal \`complete\` sibling at ` +
          `${pathFor(idx)} and can never execute; remove the dead node or the complete`,
      });
      return; // one diagnostic per list, on the first unreachable sibling
    }
    return; // trailing complete with no reachable sibling after it — fine
  }
}

interface ChildList {
  list: readonly (FlowNode | undefined)[];
  pathFor: (idx: number) => string;
}

/**
 * Every child list a composite owns, with its canonical path generator.
 * Kinds not listed here are leaves for control-flow purposes.
 */
function childLists(node: FlowNode, path: string): ChildList[] {
  switch (node.type) {
    case "sequence":
      return [{ list: node.nodes, pathFor: (i) => `${path}.nodes[${i}]` }];
    case "for_each":
      return [{ list: node.body, pathFor: (i) => `${path}.body[${i}]` }];
    case "loop":
      return [{ list: node.body, pathFor: (i) => `${path}.body[${i}]` }];
    case "branch": {
      const lists: ChildList[] = [
        { list: node.then, pathFor: (i) => `${path}.then[${i}]` },
      ];
      if (node.else !== undefined) {
        const elseList = node.else;
        lists.push({ list: elseList, pathFor: (i) => `${path}.else[${i}]` });
      }
      return lists;
    }
    case "parallel":
      return node.branches.map((branch, bIdx) => ({
        list: branch,
        pathFor: (i: number) => `${path}.branches[${bIdx}][${i}]`,
      }));
    case "approval": {
      const lists: ChildList[] = [
        { list: node.onApprove, pathFor: (i) => `${path}.onApprove[${i}]` },
      ];
      if (node.onReject !== undefined) {
        const rejectList = node.onReject;
        lists.push({
          list: rejectList,
          pathFor: (i) => `${path}.onReject[${i}]`,
        });
      }
      return lists;
    }
    case "persona":
    case "route":
      return [{ list: node.body, pathFor: (i) => `${path}.body[${i}]` }];
    case "try_catch":
      return [
        { list: node.body, pathFor: (i) => `${path}.body[${i}]` },
        { list: node.catch, pathFor: (i) => `${path}.catch[${i}]` },
      ];
    default:
      return [];
  }
}
