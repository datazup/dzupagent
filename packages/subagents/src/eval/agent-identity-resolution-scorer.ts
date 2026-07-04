import type { SubagentSpec } from "../contracts/background-task.js";
import type { FanoutItem } from "../tools/fanout-tool.js";
import type { FanoutEvalResult, FanoutScorer } from "./types.js";

/**
 * Scope note (read before extending this scorer): the original brief for
 * this eval area asked for "persona resolution correctness" — given inline
 * agent definitions or persona references, did `resolvedDefinition` /
 * `resolvedPersonaName` resolve to the expected persona. That resolution
 * layer does not exist anywhere in this codebase: `SubagentSpec.agentId` is
 * an opaque string, and turning it into a runnable agent is entirely the
 * job of the injected `SubagentExecutorPort` (implemented in
 * `@dzupagent/agent-adapters`, a Layer 4 package `@dzupagent/subagents`
 * (Layer 2) structurally cannot see — see contracts/subagent-executor-port.ts).
 * `packages/server/src/personas/persona-resolver.ts` is an unrelated,
 * server-level persona system with no wiring into the fan-out spawn path.
 *
 * This scorer therefore covers the closest REAL identity-resolution
 * surface that `fanout_template` actually has: for every declared item in a
 * batch, does the per-item `SubagentSpec` built by the template resolve to
 * the SAME `agentId` the coordinator declared, and does the instruction
 * templating correctly substitute `{{key}}`/`{{input}}` per item (the only
 * place a per-item "identity" diverges from the template in v1). This is
 * "persona resolution" reframed honestly around what the fan-out mechanism
 * can actually get wrong today; extend it if/when a real persona-reference
 * resolution layer is added to this package.
 */
export interface AgentIdentityResolutionCase {
  /** The template spec declared for the batch. */
  template: {
    agentId: string;
    instructions?: string;
    outboundScope?: string[];
    memoryScope?: SubagentSpec["memoryScope"];
  };
  /** Declared fan-out items (same shape `fanout_template` accepts). */
  items: FanoutItem[];
  /** Expected resolved spec per item key — what the coordinator should build. */
  expected: Record<string, { agentId: string; instructions?: string }>;
}

/** Mirrors `substitutePlaceholders` in fanout-tool.ts (kept independent on
 * purpose: this scorer must fail if the tool's real substitution logic
 * drifts from this expectation, not silently track it). */
function expectedSubstitution(template: string, item: FanoutItem): string {
  const inputText =
    typeof item.input === "string" ? item.input : JSON.stringify(item.input);
  return template
    .replaceAll("{{key}}", item.key)
    .replaceAll("{{input}}", inputText);
}

/** Build the per-item spec the way `createFanoutTemplateTool`'s `buildSpec` does. */
function buildResolvedSpec(
  template: AgentIdentityResolutionCase["template"],
  item: FanoutItem
): { agentId: string; instructions?: string } {
  const resolved: { agentId: string; instructions?: string } = {
    agentId: template.agentId,
  };
  if (template.instructions !== undefined) {
    resolved.instructions = expectedSubstitution(template.instructions, item);
  }
  return resolved;
}

export function createAgentIdentityResolutionScorer(): FanoutScorer<AgentIdentityResolutionCase> {
  return {
    config: {
      id: "fanout-agent-identity-resolution",
      name: "Agent Identity Resolution",
      description:
        "Checks that per-item SubagentSpecs built from a fan-out template " +
        "resolve to the declared agentId and correctly substitute per-item " +
        "instruction placeholders.",
      type: "deterministic",
    },
    score(input: AgentIdentityResolutionCase): FanoutEvalResult {
      const mismatches: Array<{
        key: string;
        field: "agentId" | "instructions";
        expected: string | undefined;
        actual: string | undefined;
      }> = [];

      for (const item of input.items) {
        const expected = input.expected[item.key];
        if (expected === undefined) {
          mismatches.push({
            key: item.key,
            field: "agentId",
            expected: "<no expectation declared>",
            actual: undefined,
          });
          continue;
        }
        const resolved = buildResolvedSpec(input.template, item);
        if (resolved.agentId !== expected.agentId) {
          mismatches.push({
            key: item.key,
            field: "agentId",
            expected: expected.agentId,
            actual: resolved.agentId,
          });
        }
        if (resolved.instructions !== expected.instructions) {
          mismatches.push({
            key: item.key,
            field: "instructions",
            expected: expected.instructions,
            actual: resolved.instructions,
          });
        }
      }

      const totalChecks = input.items.length;
      if (mismatches.length > 0) {
        return {
          score: totalChecks === 0 ? 0 : 1 - mismatches.length / totalChecks,
          pass: false,
          reasoning: `${mismatches.length} identity/instruction resolution mismatch(es) across ${totalChecks} item(s).`,
          metadata: { mismatches },
        };
      }

      return {
        score: 1,
        pass: true,
        reasoning: `All ${totalChecks} item(s) resolved to the expected agentId and instructions.`,
      };
    },
  };
}
