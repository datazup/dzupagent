/**
 * Contract tests pinning the documented no-op of
 * `ParticipantDefinition.capabilities` — and its deliberate separation from the
 * enforced, bid-side capability filter.
 *
 * The docstring on that field (see `team-definition.ts`) states plainly that the
 * field is RESERVED AND CURRENTLY UNUSED: it is accepted, carried on the
 * definition, and never consulted by any routing, matching, or bid-evaluation
 * path.
 *
 * These tests are deliberately *negative*: they assert that capabilities have no
 * effect on which participant is selected or on what the team produces. If
 * someone later wires a real capability-matching semantic (a hard filter on
 * bidders, a rank bonus in bid evaluation, a routing tag source, ...) these fail
 * loudly, so the "unused" docs get corrected rather than silently rotting into
 * the exact false claim they replaced.
 *
 * They also pin the two adjacent surfaces the docstring warns not to confuse
 * this field with, so the disambiguation itself cannot rot:
 *   - `contractNet.requiredCapabilities` IS enforced (announced in the CFP and
 *     applied as a subset filter on bids), but it matches what a bidder
 *     self-reports in its bid — never this field.
 *   - `AgentSpec.tags` (what `RuleBasedRouting` really matches on) is populated
 *     from `metadata.tags`, never from participant `capabilities`.
 *
 * The gap between those two is the point: a participant may declare
 * `capabilities: ['sql']` and still lose a CFP requiring `sql`, because nothing
 * propagates the definition into the bid. That is deliberate — see the
 * docstring's trust argument — and the tests below pin it.
 */
import { describe, expect, it, vi } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { DzupAgent } from "../../../agent/dzip-agent.js";
import { TeamRuntime } from "../team-runtime.js";
import { toAgentSpecs } from "../../specialist-selection.js";
import type { AgentExecutionSpec } from "@dzupagent/core/persistence";
import type {
  ParticipantDefinition,
  TeamDefinition,
} from "../team-definition.js";
import type { TeamSpawnedAgent } from "../team-workspace.js";
import type { TeamPolicies } from "../team-policy.js";

/**
 * A bid that is valid, cheap, and identifies its bidder in `approach`.
 *
 * `declaredCapabilities` is what the capability filter matches on — the
 * bidder's own claim, which is a different surface from the participant
 * definition's `capabilities` field these tests are about.
 */
function bidJson(
  agentId: string,
  costCents: number,
  declaredCapabilities?: string[]
): string {
  return JSON.stringify({
    estimatedCostCents: costCents,
    estimatedDurationMs: 10,
    qualityEstimate: 0.9,
    confidence: 0.9,
    approach: `approach-by-${agentId}`,
    ...(declaredCapabilities ? { capabilities: declaredCapabilities } : {}),
  });
}

/**
 * Agent whose bid cost is fixed per-id, so the contract-net winner is fully
 * determined by cost — and therefore observably independent of capabilities.
 * Records every prompt it receives so prompt-level assertions are possible.
 */
function createBiddingAgent(
  id: string,
  costCents: number,
  prompts: string[],
  declaredCapabilities?: string[]
): DzupAgent {
  const model: BaseChatModel = {
    invoke: vi.fn(async (messages: BaseMessage[]) => {
      const text = messages.map((m) => String(m.content)).join("\n");
      prompts.push(text);
      // The bid prompt asks for JSON; the execution prompt does not.
      if (text.includes("Respond ONLY with a JSON object")) {
        return new AIMessage({
          content: bidJson(id, costCents, declaredCapabilities),
          response_metadata: {},
        });
      }
      return new AIMessage({
        content: `${id}-executed`,
        response_metadata: {},
      });
    }),
    bindTools: vi.fn(function (this: BaseChatModel) {
      return this;
    }),
    _modelType: () => "base_chat_model",
    _llmType: () => "mock",
  } as unknown as BaseChatModel;
  return new DzupAgent({ id, name: id, instructions: `You are ${id}.`, model });
}

function buildContractNetTeam(
  participants: ParticipantDefinition[]
): TeamDefinition {
  return {
    id: "cap-team",
    name: "cap-team",
    coordinatorPattern: "contract_net",
    participants,
  };
}

function makeRuntime(
  definition: TeamDefinition,
  agentsById: Map<string, DzupAgent>,
  policies?: TeamPolicies
): TeamRuntime {
  return new TeamRuntime({
    definition,
    ...(policies ? { policies } : {}),
    resolveParticipant: async (participant): Promise<TeamSpawnedAgent> => ({
      agent: agentsById.get(participant.id)!,
      status: "idle",
      role: participant.role as TeamSpawnedAgent["role"],
      tags: [],
      spawnedAt: Date.now(),
    }),
  });
}

/**
 * Build a contract-net team of one supervisor + two specialists, where
 * `cheap` always underbids `pricey`. `capabilitiesFor` decides what (if
 * anything) each specialist declares.
 */
async function runTeam(
  capabilitiesFor: (id: string) => string[] | undefined,
  policies?: TeamPolicies,
  /** What each bidder CLAIMS in its bid — the surface the filter reads. */
  declaresFor: (id: string) => string[] | undefined = () => undefined
): Promise<{ content: string; prompts: string[] }> {
  const prompts: string[] = [];
  const agentsById = new Map<string, DzupAgent>([
    ["boss", createBiddingAgent("boss", 999, prompts, declaresFor("boss"))],
    ["cheap", createBiddingAgent("cheap", 10, prompts, declaresFor("cheap"))],
    [
      "pricey",
      createBiddingAgent("pricey", 500, prompts, declaresFor("pricey")),
    ],
  ]);

  const participants: ParticipantDefinition[] = [
    { id: "boss", role: "supervisor", model: "mock" },
    { id: "cheap", role: "specialist", model: "mock" },
    { id: "pricey", role: "specialist", model: "mock" },
  ].map((p) => {
    const caps = capabilitiesFor(p.id);
    return (
      caps === undefined ? p : { ...p, capabilities: caps }
    ) as ParticipantDefinition;
  });

  const runtime = makeRuntime(
    buildContractNetTeam(participants),
    agentsById,
    policies
  );
  const result = await runtime.execute("do the work");
  return { content: result.content, prompts };
}

describe("ParticipantDefinition.capabilities is documented as unused", () => {
  it("does not change the contract-net winner when capabilities are absent vs. present", async () => {
    // Baseline: nobody declares capabilities. Cheapest bid wins.
    const withoutCaps = await runTeam(() => undefined);
    expect(withoutCaps.content).toBe("cheap-executed");

    // Now give the EXPENSIVE specialist a rich capability list and the cheap one
    // none. If capabilities were consulted at all, this is the case most likely
    // to flip the winner — a specialist advertising every relevant skill.
    const withCaps = await runTeam((id) =>
      id === "pricey"
        ? ["typescript", "sql", "security", "everything"]
        : undefined
    );

    // Unchanged: capabilities are inert, so cost alone still decides.
    expect(withCaps.content).toBe("cheap-executed");
    expect(withCaps.content).toBe(withoutCaps.content);
  });

  it("never leaks participant capabilities into the bid prompt", async () => {
    // The CFP prompt is the one place capability strings demonstrably DO reach
    // an agent (via policies.contractNet.requiredCapabilities). Participant
    // capabilities must not appear there — that is a different surface.
    const { prompts } = await runTeam((id) =>
      id === "pricey" ? ["telepathy"] : undefined
    );

    expect(prompts.length).toBeGreaterThan(0);
    for (const prompt of prompts) {
      expect(prompt).not.toContain("telepathy");
    }
  });

  it("routes capability strings into the CFP prompt ONLY via policies.contractNet.requiredCapabilities", async () => {
    // Positive control for the docstring's disambiguation: the policy field is
    // the live surface and it reaches bidders as prompt text.
    const { prompts } = await runTeam(
      () => undefined,
      { contractNet: { requiredCapabilities: ["clairvoyance"] } },
      // Both declare it, so the run completes and the assertion under test is
      // about prompt content rather than eligibility.
      () => ["clairvoyance"]
    );

    const bidPrompts = prompts.filter((p) =>
      p.includes("Respond ONLY with a JSON object")
    );
    expect(bidPrompts.length).toBeGreaterThan(0);
    for (const prompt of bidPrompts) {
      expect(prompt).toContain("Required capabilities: clairvoyance");
    }
  });

  it("does not let a participant's declared capabilities satisfy a CFP requirement", async () => {
    // The heart of the disambiguation. `pricey` declares the required
    // capability ON ITS PARTICIPANT DEFINITION but claims nothing in its bid.
    // If the definition leaked into bid matching, pricey would qualify and win
    // (it would be the only eligible bid). It must not: the negotiation fails
    // because no BID declared the capability.
    await expect(
      runTeam(
        (id) => (id === "pricey" ? ["clairvoyance"] : undefined),
        { contractNet: { requiredCapabilities: ["clairvoyance"] } },
        () => undefined
      )
    ).rejects.toThrow(/No bid met the required capabilities: clairvoyance/);
  });

  it("awards on declared bid capabilities, not on price, when a CFP requires them", async () => {
    // The defect this closes: `cheap` underbids 10 vs 500 but does not declare
    // the required capability, so it is filtered out before ranking and the
    // qualified-but-expensive bidder wins. Under the old prompt-text-only
    // behaviour `cheap` won regardless.
    const { content } = await runTeam(
      () => undefined,
      { contractNet: { requiredCapabilities: ["clairvoyance"] } },
      (id) => (id === "pricey" ? ["clairvoyance"] : undefined)
    );

    expect(content).toBe("pricey-executed");
  });

  it("does not populate AgentSpec.tags from capabilities (tags come from metadata.tags)", () => {
    // `toAgentSpecs` is what feeds RuleBasedRouting's tag matching. It reads
    // `metadata.tags` and has no access to ParticipantDefinition at all, which
    // is precisely why participant capabilities can never reach routing.
    const specialists = new Map<string, AgentExecutionSpec>([
      [
        "a",
        {
          name: "a",
          metadata: { tags: ["from-metadata"], capabilities: ["from-caps"] },
        } as unknown as AgentExecutionSpec,
      ],
    ]);

    const specs = toAgentSpecs(specialists);

    expect(specs[0]?.tags).toEqual(["from-metadata"]);
    expect(specs[0]?.tags).not.toContain("from-caps");
  });

  it("accepts and preserves capabilities on the definition without acting on them", async () => {
    // The field is still part of the public schema: it round-trips intact.
    // "Unused" means "no behaviour", not "rejected" or "stripped".
    const agentsById = new Map<string, DzupAgent>([
      ["solo", createBiddingAgent("solo", 1, [])],
    ]);
    const definition = buildContractNetTeam([
      { id: "solo", role: "supervisor", model: "mock", capabilities: ["kept"] },
    ]);
    const runtime = makeRuntime(definition, agentsById);

    expect(runtime.team.participants[0]?.capabilities).toEqual(["kept"]);
  });
});
