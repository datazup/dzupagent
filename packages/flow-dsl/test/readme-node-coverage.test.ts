import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { FLOW_NODE_KINDS } from "@dzupagent/flow-ast";

const README_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../README.md"
);
const README = readFileSync(README_PATH, "utf8");
const LINES = README.split(/\r?\n/);
const CURRENT_STATE_DOC = "DZUPFLOW_DSL_CURRENT_2026-10-07.md";

/** Heading level of a line outside fenced code, or 0 when it is not a heading. */
function headingLevels(lines: readonly string[]): number[] {
  let inFence = false;
  return lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return 0;
    }
    if (inFence) return 0;
    const match = /^(#{1,6}) /.exec(line);
    return match === null ? 0 : match[1]!.length;
  });
}

const LEVELS = headingLevels(LINES);

/**
 * Text from the heading line selected by `matches` up to (excluding) the next
 * heading at the same or a higher level. Headings inside code fences are
 * ignored.
 */
function section(level: number, matches: (line: string) => boolean): string {
  const start = LINES.findIndex(
    (line, index) => LEVELS[index] === level && matches(line)
  );
  expect(start, `README heading not found at level ${level}`).toBeGreaterThan(
    -1
  );
  let end = LINES.length;
  for (let index = start + 1; index < LINES.length; index++) {
    const lineLevel = LEVELS[index]!;
    if (lineLevel !== 0 && lineLevel <= level) {
      end = index;
      break;
    }
  }
  return LINES.slice(start, end).join("\n");
}

function h2(title: string): string {
  return section(2, (line) => line.trim() === `## ${title}`);
}

function nodeSection(kind: string): string {
  return section(3, (line) => line.startsWith(`### \`${kind}\``));
}

/** `text` without fenced code blocks, so only prose and inline code remain. */
function withoutFences(text: string): string {
  return text.replace(/^[ \t]*```[\s\S]*?^[ \t]*```[^\n]*$/gm, "");
}

/** Node kinds with no heading, table-row label or wrapper-mapping bullet. */
function missingNodeKindEntries(
  text: string,
  expected: readonly string[]
): string[] {
  const lines = withoutFences(text).split("\n");
  const wrapperTargets = new Set(
    lines.flatMap((line) => {
      const m = /^- `(?:group|if|clarify)` → `([a-z_.0-9-]+)`\s*$/.exec(line);
      return m ? [m[1]] : [];
    })
  );
  const listed = new Set(
    lines.flatMap((line) => {
      const head = /^#{3,4}\s+(.*)$/.exec(line)?.[1];
      const cell = /^\|\s*([^|]*)\|/.exec(line)?.[1];
      const label = head ?? cell ?? "";
      return [...label.matchAll(/`([a-z_.0-9-]+)`/g)].map((m) => m[1]);
    })
  );
  return expected.filter(
    (token) => !listed.has(token) && !wrapperTargets.has(token)
  );
}

/** Tokens from `expected` that never appear as an exact inline-code span. */
function missingBacktickTokens(
  text: string,
  expected: readonly string[]
): string[] {
  const prose = withoutFences(text);
  return expected.filter((token) => !prose.includes(`\`${token}\``));
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ");
}

function expectAbsent(text: string, needle: string): void {
  expect(text).not.toContain(needle);
  expect(collapse(text)).not.toContain(needle);
}

describe("flow-dsl README node coverage", () => {
  it("documents every canonical node kind in the Nodes section", () => {
    expect(FLOW_NODE_KINDS).toHaveLength(52);
    const missing = missingNodeKindEntries(h2("Nodes"), FLOW_NODE_KINDS);
    expect(
      missing,
      `README "## Nodes" section is missing node kinds: ${missing.join(", ")}`
    ).toEqual([]);
  });

  it("states the authored-to-canonical wrapper mappings in the Nodes introduction", () => {
    const nodes = h2("Nodes");
    const firstSubsection = nodes.search(/^### /m);
    expect(firstSubsection).toBeGreaterThan(0);
    const intro = nodes.slice(0, firstSubsection);

    for (const [authored, canonical] of [
      ["group", "sequence"],
      ["if", "branch"],
      ["clarify", "clarification"],
    ] as const) {
      expect(
        intro,
        `Nodes introduction must map \`${authored}\` to \`${canonical}\` on one line`
      ).toMatch(new RegExp(`\`${authored}\`[^\\n]*\`${canonical}\``));
    }

    expect(intro).not.toMatch(/canonical[^.\n]{0,20}`(group|if|clarify)`/i);
    expect(intro).not.toMatch(
      /`(group|if|clarify)`[^.\n]{0,20}\b(is|are)\s+(a\s+)?canonical/i
    );
  });

  it("documents for_each collect as { from, into } with a flow-ast anchor", () => {
    const forEach = nodeSection("for_each");
    expect(forEach).toContain("collect: { from, into }");
    expect(forEach).toMatch(/types\/nodes\.ts:\d+/);
  });

  it("describes the agent node without the v1alpha-agent gate", () => {
    const agent = nodeSection("agent");
    expectAbsent(agent, "Available under `dsl: dzupflow/v1alpha-agent`");
    expect(README).toContain("template.ref");
    expect(README).toMatch(/validate\/agent\.ts:\d+/);

    const paragraphs = README.split(/\n\s*\n/);
    expect(
      paragraphs.some(
        (paragraph) =>
          /src\/normalize\.ts:\d+/.test(paragraph) &&
          paragraph.includes("dzupflow/v1alpha-agent")
      ),
      "README must cite src/normalize.ts:<line> next to dzupflow/v1alpha-agent"
    ).toBe(true);
  });

  it("carries the Codev host caveat in the approval section", () => {
    const approval = nodeSection("approval");
    for (const needle of [
      "onApprove",
      "onReject",
      "release-strict",
      "G01",
      "G07",
      CURRENT_STATE_DOC,
    ]) {
      expect(approval, `approval section must mention ${needle}`).toContain(
        needle
      );
    }
    expect(approval).toMatch(/\bP1\b/);
  });
});

describe("flow-dsl README corrections", () => {
  it("points to the current-state document before the Usage section", () => {
    const usageStart = LINES.findIndex(
      (line, index) => LEVELS[index] === 2 && line.trim() === "## Usage"
    );
    expect(usageStart).toBeGreaterThan(0);
    expect(LINES.slice(0, usageStart).join("\n")).toContain(CURRENT_STATE_DOC);
  });

  it("removes stale resolver and phase claims", () => {
    for (const stale of ["resolveDeep", "collectInto", "three phases"]) {
      expectAbsent(README, stale);
    }
    expect(README).toContain("resolveFlowTemplateExpression");
    expect(README).toMatch(/condition-expression\.ts:\d+/);
  });

  it("documents the five parse phases in the Usage section", () => {
    const usage = h2("Usage");
    expect(usage).toContain("five phases");
    expect(usage).toContain("dzupflow/v2");
    expect(usage).toMatch(/src\/parse-dsl\.ts:\d+/);
  });

  it("documents strict and compat reference roots and policies", () => {
    const templates = h2("Template expressions");
    const roots = [
      "inputs",
      "state",
      "steps",
      "loop",
      "context",
      "secrets",
      "artifacts",
      "params",
      "input",
      "output",
      "node",
      "last_agent",
      "item",
      "ctx",
    ];
    const missing = missingBacktickTokens(templates, roots);
    expect(
      missing,
      `Template expressions section is missing roots: ${missing.join(", ")}`
    ).toEqual([]);
    expect(templates).toContain("compat-v1");
    expect(templates).toContain("strict");
    expect(templates).toMatch(/reference-expression\/types\.ts:\d+/);
    expect(templates).toMatch(/stages\/semantic\.ts:\d+/);
  });

  it("documents the v2 kernel subset and pipeline target adoption", () => {
    const bounded = h2("Bounded dzupflow/v2 frontend");
    for (const needle of [
      "core.loop@1",
      "pipeline",
      "flow.control.typed-condition@1",
      "targetCapabilities",
      "flow-compiler/README.md",
    ]) {
      expect(bounded, `v2 section must mention ${needle}`).toContain(needle);
    }
    expect(bounded).toMatch(/\bunguarded\b/);
    expect(bounded).toMatch(/\btop-level\b/);
    expect(bounded).toMatch(/lower-v2-kernel\.ts:\d+/);
    expect(bounded).toMatch(/v2-target-gates\.ts:\d+/);
    expectAbsent(bounded, "No generic compiler target has adopted");
  });
});
