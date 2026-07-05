import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { FlowFragmentV1, FlowNode } from "@dzupagent/flow-ast";
import { describe, expect, it } from "vitest";

import { createFragmentRegistry } from "../fragments/registry.js";
import { parseYamlSubset } from "../mini-yaml.js";
import { parseDslToDocument } from "../parse-dsl.js";

interface GoldenExpectation {
  ok: boolean;
  nodeIds?: string[];
  fragmentInstances?: string[];
  jsonContains?: string[];
  diagnostics?: string[];
}

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "golden-expansion",
);

function readFixture(caseName: string, fileName: string): string {
  return readFileSync(join(fixturesDir, caseName, fileName), "utf8");
}

function parseFragmentDefinitions(caseName: string): FlowFragmentV1[] {
  const parsed = parseYamlSubset(readFixture(caseName, "fragments.yaml"));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return [];

  const definitions = Array.isArray(parsed.value)
    ? parsed.value
    : [parsed.value];

  for (const definition of definitions) {
    expect(definition).toEqual(
      expect.objectContaining({ documentType: "fragment" }),
    );
  }

  return definitions as FlowFragmentV1[];
}

function parseExpectation(caseName: string): GoldenExpectation {
  return JSON.parse(readFixture(caseName, "expected.json")) as GoldenExpectation;
}

function collectNodeIds(nodes: readonly FlowNode[]): string[] {
  const ids: string[] = [];

  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;

    const maybeNode = value as { id?: unknown; type?: unknown };
    if (typeof maybeNode.type === "string" && typeof maybeNode.id === "string") {
      ids.push(maybeNode.id);
    }

    for (const child of Object.values(value)) {
      visit(child);
    }
  }

  visit(nodes);
  return ids;
}

describe("golden fragment expansion fixtures", () => {
  const cases = readdirSync(fixturesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  it.each(cases)("%s", (caseName) => {
    const fragmentRegistry = createFragmentRegistry(
      parseFragmentDefinitions(caseName),
    );
    const expected = parseExpectation(caseName);
    const result = parseDslToDocument(readFixture(caseName, "invocation.yaml"), {
      fragmentRegistry,
    });

    expect(result.ok).toBe(expected.ok);

    if (!expected.ok) {
      const diagnostics = result.diagnostics.map((diagnostic) => diagnostic.message);
      for (const expectedDiagnostic of expected.diagnostics ?? []) {
        expect(diagnostics.join("\n")).toContain(expectedDiagnostic);
      }
      return;
    }

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const nodeIds = collectNodeIds(result.document.root.nodes);
    if (expected.nodeIds) {
      expect(nodeIds).toEqual(expected.nodeIds);
    }
    expect(new Set(nodeIds).size).toBe(nodeIds.length);

    const expansions = result.document.meta?.fragmentExpansions ?? [];
    const instanceIds = expansions.map((expansion) => expansion.instanceId);
    for (const instanceId of expected.fragmentInstances ?? []) {
      expect(instanceIds).toContain(instanceId);
    }

    const documentJson = JSON.stringify(result.document);
    for (const needle of expected.jsonContains ?? []) {
      expect(documentJson).toContain(needle);
    }
  });
});
