/**
 * Membership conformance pin for `visitFlow` (capability-manifest/hashing.ts).
 *
 * `visitFlow` deliberately keeps its own hand-rolled iteration instead of
 * delegating to flow-ast's canonical walk: its visit ORDER feeds
 * `semanticHash` and is load-bearing for persisted capability-manifest
 * digests, so it must not change when the canonical child-field list gains a
 * member. What it MUST track is key MEMBERSHIP — a child container the
 * canonical walk follows but visitFlow skips would silently drop that
 * subtree's node kinds from requirement summaries.
 *
 * The chain here: the literal pin of FLOW_CHILD_CONTAINER_FIELDS fails when
 * the canonical list grows, forcing the fixture to cover the new field; the
 * coverage assertion then fails until visitFlow follows it too. The order
 * pin freezes today's digest-feeding visitation order in the open.
 */
import { describe, expect, it } from "vitest";

import type { FlowNode } from "@dzupagent/flow-ast";
import {
  FLOW_CHILD_CONTAINER_FIELDS,
  walkFlowNodes,
} from "@dzupagent/flow-ast/node-traversal";
import { visitFlow } from "../capability-manifest/hashing.js";

/**
 * One child under every canonical child container: nodes, body (for_each,
 * persona, route, try_catch, loop), then, else, onApprove, onReject, catch,
 * and parallel branches.
 */
const FIXTURE: FlowNode = {
  type: "sequence",
  id: "root",
  nodes: [
    {
      type: "branch",
      id: "b",
      condition: "true",
      then: [{ type: "complete", id: "then0" }],
      else: [{ type: "complete", id: "else0" }],
    },
    {
      type: "approval",
      id: "a",
      question: "ok?",
      onApprove: [{ type: "complete", id: "approve0" }],
      onReject: [{ type: "complete", id: "reject0" }],
    },
    {
      type: "try_catch",
      id: "tc",
      errorVar: "e",
      body: [
        {
          type: "for_each",
          id: "fe",
          source: "state.items",
          as: "item",
          body: [{ type: "complete", id: "feBody0" }],
        },
      ],
      catch: [{ type: "complete", id: "catch0" }],
    },
    {
      type: "parallel",
      id: "p",
      branches: [
        [{ type: "complete", id: "branch00" }],
        [{ type: "complete", id: "branch10" }],
      ],
    },
    {
      type: "persona",
      id: "pe",
      personaId: "qa",
      body: [{ type: "complete", id: "peBody0" }],
    },
    {
      type: "route",
      id: "ro",
      strategy: "fixed-provider",
      provider: "openai",
      body: [{ type: "complete", id: "roBody0" }],
    },
    {
      type: "loop",
      id: "lp",
      body: [{ type: "complete", id: "lpBody0" }],
    },
  ],
} as FlowNode;

describe("visitFlow conformance against the canonical child-field contract", () => {
  it("pins the canonical container list the fixture must cover", () => {
    // When this literal pin fails, the canonical walk learned a new child
    // container: extend FIXTURE to nest a node under it, then make visitFlow
    // follow it (appending AFTER its existing order — see the order pin).
    expect([...FLOW_CHILD_CONTAINER_FIELDS]).toEqual([
      "nodes",
      "body",
      "then",
      "else",
      "onApprove",
      "onReject",
      "catch",
      "branches",
    ]);
  });

  it("visits exactly the node set the canonical walk visits", () => {
    const canonical: string[] = [];
    walkFlowNodes(FIXTURE, (node) => {
      canonical.push(node.id as string);
    });
    const visited: string[] = [];
    visitFlow(FIXTURE, (node) => {
      visited.push(node.id as string);
    });
    expect([...visited].sort()).toEqual([...canonical].sort());
  });

  it("freezes visitFlow's digest-feeding visitation order", () => {
    // This order feeds semanticHash and persisted capability-manifest
    // digests. It is FROZEN: a failure here means visitFlow's iteration
    // changed, which invalidates persisted hashes — do not "fix" the
    // expectation without a golden-digest corpus pin landing first.
    const visited: string[] = [];
    visitFlow(FIXTURE, (node) => {
      visited.push(node.id as string);
    });
    expect(visited).toEqual([
      "root",
      "b",
      "then0",
      "else0",
      "a",
      "approve0",
      "reject0",
      "tc",
      "fe",
      "feBody0",
      "catch0",
      "p",
      "branch00",
      "branch10",
      "pe",
      "peBody0",
      "ro",
      "roBody0",
      "lp",
      "lpBody0",
    ]);
  });
});
