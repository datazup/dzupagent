import { describe, it, expect } from "vitest";

import {
  evaluateRuleDecision,
  parseDecisionBlock,
} from "../scheduler/decision-block.js";
// @ts-expect-error -- untyped test fakes shared with the .mjs suites
import { baseRunSpec, createPorts, fixedClock, loadDialogueCore } from "./fakes.mjs";

describe("parseDecisionBlock (DZUPAGENT-ERR-C-24)", () => {
  it("keeps the continue fallback for non-JSON output but marks it unparseable", () => {
    const decision = parseDecisionBlock('{"verdict":"rej');
    expect(decision.verdict).toBe("continue");
    expect(decision.diagnostic).toBe("unparseable");
    expect(decision.rationale).toBe('{"verdict":"rej');
  });

  it("marks JSON that is not an object as unparseable", () => {
    expect(parseDecisionBlock("[1,2]").diagnostic).toBe("unparseable");
    expect(parseDecisionBlock("null").diagnostic).toBe("unparseable");
    expect(parseDecisionBlock("plain prose").diagnostic).toBe("unparseable");
  });

  it("marks an object without a recognised verdict", () => {
    expect(parseDecisionBlock("{}").diagnostic).toBe("unrecognized-verdict");
    const decision = parseDecisionBlock(
      JSON.stringify({ decision: { verdict: "REJECT", rationale: "r" } })
    );
    expect(decision.verdict).toBe("continue");
    expect(decision.diagnostic).toBe("unrecognized-verdict");
  });

  it("adds no diagnostic for a well-formed decision, including an explicit continue", () => {
    const reject = parseDecisionBlock(
      JSON.stringify({
        verdict: "reject",
        criteria: [{ name: "tests", met: false }],
        rationale: "tests fail",
      })
    );
    expect(reject).toEqual({
      verdict: "reject",
      criteria: [{ name: "tests", met: false }],
      rationale: "tests fail",
    });
    const cont = parseDecisionBlock(JSON.stringify({ decision: { verdict: "continue" } }));
    expect(cont.verdict).toBe("continue");
    expect("diagnostic" in cont).toBe(false);
  });
});

describe("evaluateRuleDecision (DZUPAGENT-ERR-C-24)", () => {
  it("does not report an unevaluated rule as met", () => {
    const decision = evaluateRuleDecision("all-tests-green");
    expect(decision.verdict).toBe("continue");
    expect(decision.criteria).toEqual([{ name: "all-tests-green", met: false }]);
    expect(decision.criteria.some((c) => c.met)).toBe(false);
    expect(decision.diagnostic).toBe("rule-not-evaluated");
  });
});

describe("scheduler turn events carry the decision diagnostic", () => {
  it("a review turn with non-JSON output emits an event marked unparseable", async () => {
    const { DialogueScheduler } = await loadDialogueCore();
    const ports = createPorts({
      agent: { responses: [{ raw: '{"verdict":"reject","rationale":"trunc' }] },
    });
    const scheduler = new DialogueScheduler(ports, { clock: fixedClock() });
    await scheduler.run({
      runId: "malformed-review",
      runSpec: baseRunSpec({
        turns: [
          {
            id: "review",
            verb: "review",
            participantId: "critic",
            prompt: "review fake evidence",
          },
        ],
      }),
    });

    const [reviewEvent] = ports.tracePort.byVisibility("persisted");
    expect(reviewEvent.status).toBe("completed");
    expect(reviewEvent.decision.verdict).toBe("continue");
    expect(reviewEvent.decision.diagnostic).toBe("unparseable");
  });

  it("a rule decide policy emits a not-evaluated criterion, never met:true", async () => {
    const { DialogueScheduler } = await loadDialogueCore();
    const ports = createPorts();
    const scheduler = new DialogueScheduler(ports, { clock: fixedClock() });
    await scheduler.run({
      runId: "rule-decide",
      runSpec: baseRunSpec({
        decidePolicy: { kind: "rule", ruleId: "ship-it" },
        turns: [
          {
            id: "decide",
            verb: "decide",
            participantId: "planner",
            prompt: "decide",
          },
        ],
      }),
    });

    const [decideEvent] = ports.tracePort.byVisibility("persisted");
    expect(decideEvent.decision.criteria).toEqual([{ name: "ship-it", met: false }]);
    expect(decideEvent.decision.diagnostic).toBe("rule-not-evaluated");
  });
});
