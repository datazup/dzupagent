/**
 * ARCH27-T-12: source-map spans are produced by zipping npm `yaml`'s CST onto
 * mini-yaml's AST. Nothing previously verified the two grammars agree, so a
 * silent disagreement would mis-point every diagnostic the compiler surfaces.
 *
 * This suite (1) sweeps every YAML fixture in the test corpus through both
 * parsers and requires value agreement whenever both accept a document, and
 * (2) pins that a seeded disagreement produces an explicit diagnostic instead
 * of a silently mis-zipped map.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

import {
  createDslSourceMap,
  createDslSourceMapWithDiagnostics,
} from "../dsl-source-map.js";
import { parseYamlSubset } from "../mini-yaml.js";

const FIXTURES_DIR = path.resolve(__dirname, "fixtures");

function collectYamlFixtures(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...collectYamlFixtures(full));
    else if (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml"))
      found.push(full);
  }
  return found;
}

describe("dual-parse grammar agreement (ARCH27-T-12)", () => {
  it("every corpus fixture both grammars accept builds a source map (no disagreement)", () => {
    const fixtures = collectYamlFixtures(FIXTURES_DIR);
    expect(fixtures.length).toBeGreaterThan(0);
    const failures: string[] = [];
    for (const fixture of fixtures) {
      const source = fs.readFileSync(fixture, "utf-8");
      const mini = parseYamlSubset(source);
      const full = parseDocument(source);
      if (!mini.ok || full.errors.length > 0 || full.contents === null) {
        continue; // one grammar rejects — no zip happens, nothing to mis-point
      }
      const result = createDslSourceMapWithDiagnostics(source);
      if (!result.ok) {
        failures.push(
          `${path.relative(FIXTURES_DIR, fixture)}: ${result.diagnostic.code} ${result.diagnostic.message}`,
        );
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("a construct the grammars read differently yields GRAMMAR_DISAGREEMENT, not a map", () => {
    // mini-yaml's numeric subset is digits with an optional decimal point, so
    // `1e3` stays the string "1e3"; the full YAML core schema reads 1000.
    const source = "dsl: dzupflow/v1\nbudget: 1e3\n";
    expect(parseYamlSubset(source).ok).toBe(true);

    const result = createDslSourceMapWithDiagnostics(source);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostic.code).toBe("GRAMMAR_DISAGREEMENT");
      expect(result.diagnostic.path).toBe("root.budget");
    }
    expect(createDslSourceMap(source)).toBeUndefined();
  });

  it("flags flow-style mappings the subset reads as a scalar string", () => {
    // The subset tokenizer accepts `{ a: 1 }` as an opaque scalar while full
    // YAML reads a mapping — exactly the shape mismatch the zip must refuse.
    const flowStyle = "config: { a: 1 }\n";
    const rejected = createDslSourceMapWithDiagnostics(flowStyle);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.diagnostic.code).toBe("GRAMMAR_DISAGREEMENT");
      expect(rejected.diagnostic.path).toBe("root.config");
    }
  });

  it("names the rejecting grammar when only the subset parser refuses", () => {
    // A bare scalar document has no `key: value` line for the subset grammar.
    const rejected = createDslSourceMapWithDiagnostics("just a scalar\n");
    expect(rejected.ok).toBe(false);
    if (!rejected.ok)
      expect(rejected.diagnostic.code).toBe("MINI_YAML_REJECTED");
  });

  it("still builds maps for agreeing documents", () => {
    const source = "dsl: dzupflow/v1\nname: probe\nsteps:\n  - id: one\n";
    const result = createDslSourceMapWithDiagnostics(source);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sourceMap.entries["root.name"]).toBeDefined();
    }
  });
});
