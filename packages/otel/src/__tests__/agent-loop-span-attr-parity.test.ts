import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AgentLoopSpanAttr } from "../agent-loop-trace-contracts.js";
import { ForgeSpanAttr } from "../span-attributes.js";

/**
 * Cross-stack span-attribute parity (ADR-0001 C4 / L3).
 *
 * The lab's `agent-loop-otel-adapter.js` and this package independently
 * declare the agent-loop span vocabulary. They currently agree on every
 * shared key — measured, not assumed — but nothing enforced that agreement,
 * so a rename on either side would silently split one trace view into two
 * incompatible ones. That is what C4 asks for, and a drift guard is what
 * closes it: the lab already conforms, so the remaining work is keeping it
 * that way rather than migrating anything.
 *
 * The lab's `ATTR` table is module-private, so it is read from source rather
 * than imported. If that parse ever stops finding a table, the guard fails
 * loudly instead of passing vacuously — a silently-empty comparison is the
 * failure mode this kind of test is most prone to.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

function findLabAdapter(): string {
  const relative = join(
    "scripts",
    "flow-prompt-lab",
    "lib",
    "agent-loop-otel-adapter.js",
  );
  let dir = HERE;

  for (let i = 0; i < 10; i += 1) {
    const candidate = join(dir, relative);
    if (existsSync(candidate)) return candidate;

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(
    "Flow Lab agent-loop OTel adapter not found by walking up from the otel package",
  );
}

const LAB_ADAPTER_PATH = findLabAdapter();

/** Parse the lab's private `ATTR = Object.freeze({...})` table. */
async function readLabAttributes(): Promise<Record<string, string>> {
  const source = await readFile(LAB_ADAPTER_PATH, "utf8");
  const start = source.indexOf("const ATTR = Object.freeze({");
  if (start === -1) {
    throw new Error(
      "lab ATTR table not found — the adapter was restructured and this guard needs updating",
    );
  }
  const body = source.slice(start, source.indexOf("});", start));
  // Values may wrap onto their own line, so allow a newline after the colon.
  const entries = [...body.matchAll(/(\w+):\s*\n?\s*"([a-z0-9_.]+)"/g)].map(
    (match) => [match[1], match[2]] as const,
  );
  return Object.fromEntries(entries);
}

describe("agent-loop span attribute parity with the lab emitter", () => {
  it("finds a non-trivial ATTR table in the lab adapter", async () => {
    // Anti-vacuity: every assertion below is over this table, so an empty or
    // near-empty parse would make them all trivially true.
    const lab = await readLabAttributes();

    expect(Object.keys(lab).length).toBeGreaterThan(30);
    expect(lab.EVENT).toBe("forge.agent_loop.event");
  });

  it("agrees with the lab on every shared agent-loop attribute", async () => {
    const lab = await readLabAttributes();

    const shared = Object.keys(AgentLoopSpanAttr).filter((key) => key in lab);
    expect(shared.length).toBe(Object.keys(AgentLoopSpanAttr).length);

    for (const key of shared) {
      expect(lab[key], `lab and framework disagree on ${key}`).toBe(
        AgentLoopSpanAttr[key as keyof typeof AgentLoopSpanAttr],
      );
    }
  });

  it("sources every remaining lab attribute from the framework vocabulary", async () => {
    // The lab keys outside AgentLoopSpanAttr must not be inventions; they are
    // the general run/cost/GenAI attributes, which ForgeSpanAttr owns.
    const lab = await readLabAttributes();
    const forgeValues = new Set<string>(Object.values(ForgeSpanAttr));

    const unaccounted = Object.entries(lab)
      .filter(([key]) => !(key in AgentLoopSpanAttr))
      .filter(([, value]) => !forgeValues.has(value))
      .map(([key, value]) => `${key}=${value}`);

    expect(unaccounted).toEqual([]);
  });

  it("keeps the lab from inventing gen_ai.* keys outside the OTel semconv", async () => {
    // gen_ai.* is a published OpenTelemetry namespace; a lab-local key there
    // would be non-conformant to the standard, not merely inconsistent.
    const lab = await readLabAttributes();
    const forgeValues = new Set<string>(Object.values(ForgeSpanAttr));

    const labGenAi = Object.values(lab).filter((value) =>
      value.startsWith("gen_ai."),
    );
    expect(labGenAi.length).toBeGreaterThan(0);
    for (const value of labGenAi) {
      expect(forgeValues.has(value), `${value} is not in ForgeSpanAttr`).toBe(
        true,
      );
    }
  });

  it("shares one span-projection schema string across both stacks", async () => {
    const source = await readFile(LAB_ADAPTER_PATH, "utf8");
    const { AGENT_LOOP_SPAN_PROJECTION_SCHEMA } =
      await import("../agent-loop-trace-contracts.js");

    expect(source).toContain(`"${AGENT_LOOP_SPAN_PROJECTION_SCHEMA}"`);
  });
});
