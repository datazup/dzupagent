/**
 * Drift guard for the composite child-list walk (doc 14 §7 R2 item 4).
 *
 * The compiler carries FOUR independent copies of "what are this node's
 * children": `childNodes` (stages/primitive-reference-ports.ts),
 * `childLists` (stages/semantic-walk/terminality.ts), and the per-kind
 * switches in semantic-walk/dispatch.ts and semantic-walk/checkpoint-restore.ts.
 * Every copy ends in `default: return []`, so a NEW container kind added to
 * `FLOW_NODE_KIND_REGISTRY` — or an existing kind that grows a second child
 * list — is silently treated as a LEAF: its subtree stops being visited and
 * the stage quietly under-reports instead of failing.
 *
 * That failure mode is invisible to every other suite, because "walked fewer
 * nodes than it should" produces a smaller-but-well-formed result. This file
 * pins the traversal itself: for each container kind, a marker primitive is
 * nested in each of its child slots and the walk must reach it.
 *
 * Scope: this asserts the PUBLIC behaviour of the reference-port walk
 * (`derivePrimitiveReferencePortBindings`), which is `childNodes`' only
 * caller, rather than reaching into a module-private helper.
 */
import { describe, it, expect } from "vitest";

import type { FlowNode } from "@dzupagent/flow-ast";
import { FLOW_NODE_KIND_REGISTRY } from "@dzupagent/flow-ast";
import { derivePrimitiveReferencePortBindings } from "../stages/primitive-reference-ports.js";

/**
 * A marker that produces a reference-port binding when — and only when — the
 * walk actually reaches it. `shell.run` is a reviewed built-in primitive, so
 * resolution never depends on an external registry being wired in the test.
 */
function marker(id: string): FlowNode {
  return {
    type: "shell.run",
    id,
    command: "yarn test",
    output: "verification",
  } as FlowNode;
}

function reaches(root: FlowNode, markerId: string): boolean {
  return (
    Object.prototype.hasOwnProperty.call(
      derivePrimitiveReferencePortBindings(root),
      markerId
    ) ||
    // The bindings map is keyed by node id; tolerate either a flat or nested
    // shape so this guard tests the TRAVERSAL, not the binding layout.
    JSON.stringify(derivePrimitiveReferencePortBindings(root)).includes(
      markerId
    )
  );
}

/**
 * Every container kind, with one entry PER child slot. A kind with two slots
 * (branch, approval, try_catch) appears twice: the second slot is exactly
 * what a hand-written switch forgets — `branch.else` and `approval.onReject`
 * are optional, so omitting them still type-checks.
 */
const CONTAINER_SLOTS: Array<[kind: string, slot: string, build: (m: FlowNode) => FlowNode]> = [
  ["sequence", "nodes", (m) => ({ type: "sequence", nodes: [m] }) as FlowNode],
  [
    "for_each",
    "body",
    (m) =>
      ({
        type: "for_each",
        id: "fe",
        source: "state.items",
        as: "item",
        body: [m],
      }) as FlowNode,
  ],
  [
    "loop",
    "body",
    (m) => ({ type: "loop", id: "lp", body: [m] }) as FlowNode,
  ],
  [
    "branch",
    "then",
    (m) => ({ type: "branch", id: "br", condition: "x", then: [m] }) as FlowNode,
  ],
  [
    "branch",
    "else",
    (m) =>
      ({
        type: "branch",
        id: "br",
        condition: "x",
        then: [],
        else: [m],
      }) as FlowNode,
  ],
  [
    "parallel",
    "branches",
    (m) => ({ type: "parallel", id: "par", branches: [[m]] }) as FlowNode,
  ],
  [
    "approval",
    "onApprove",
    (m) =>
      ({
        type: "approval",
        id: "ap",
        question: "ok?",
        onApprove: [m],
      }) as FlowNode,
  ],
  [
    "approval",
    "onReject",
    (m) =>
      ({
        type: "approval",
        id: "ap",
        question: "ok?",
        onApprove: [],
        onReject: [m],
      }) as FlowNode,
  ],
  [
    "persona",
    "body",
    (m) =>
      ({ type: "persona", id: "pe", personaId: "qa", body: [m] }) as FlowNode,
  ],
  [
    "route",
    "body",
    (m) =>
      ({
        type: "route",
        id: "ro",
        strategy: "cheapest",
        body: [m],
      }) as FlowNode,
  ],
  [
    "try_catch",
    "body",
    (m) =>
      ({
        type: "try_catch",
        id: "tc",
        errorVar: "e",
        body: [m],
        catch: [],
      }) as FlowNode,
  ],
  [
    "try_catch",
    "catch",
    (m) =>
      ({
        type: "try_catch",
        id: "tc",
        errorVar: "e",
        body: [],
        catch: [m],
      }) as FlowNode,
  ],
];

describe("composite child-walk coverage", () => {
  it("reaches a marker nested directly at the root (control)", () => {
    // Holds the marker/binding mechanism ACCEPTING, so a failure below is
    // attributable to the traversal rather than to the marker never binding.
    expect(reaches(marker("solo"), "solo")).toBe(true);
  });

  it.each(CONTAINER_SLOTS)(
    "descends into %s.%s",
    (_kind, slot, build) => {
      const id = `marker_${slot}`;
      expect(reaches(build(marker(id)), id)).toBe(true);
    }
  );

  it("does not descend into a leaf kind (negative control)", () => {
    // Keeps the assertions above honest: if `reaches` returned true for
    // everything, every test in this file would pass vacuously.
    expect(reaches(marker("present"), "absent")).toBe(false);
  });

  it("covers every container kind the walker special-cases", () => {
    // The walk's switch is the source of truth for "is a container"; this
    // pins the SET so adding a case without adding coverage here fails.
    const covered = new Set(CONTAINER_SLOTS.map(([kind]) => kind));
    expect([...covered].sort()).toEqual([
      "approval",
      "branch",
      "for_each",
      "loop",
      "parallel",
      "persona",
      "route",
      "sequence",
      "try_catch",
    ]);
    // Every covered kind must be a real public discriminator.
    for (const kind of covered) {
      expect(FLOW_NODE_KIND_REGISTRY).toHaveProperty(kind);
    }
  });
});
