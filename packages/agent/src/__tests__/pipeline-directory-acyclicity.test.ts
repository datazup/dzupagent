/**
 * ARCH27-T-10: the directories under `src/pipeline` must form an acyclic
 * VALUE-import graph. Before this gate, `executor-internals` (then named
 * `pipeline-runtime`), `pipeline-runtime-lifecycle`, `scoped-graph`, and
 * `loop-executor` were pairwise value-coupled in both directions — invisible
 * to madge (which sees only package-level cycles) and blocking independent
 * extraction and testing (ARCH27-N-08).
 *
 * Type-only imports are deliberately exempt: the top-level facade files
 * (`loop-executor.ts`, `runtime-tool-handlers.ts`, `pipeline-runtime-types.ts`)
 * type-link the directories by design, and type edges are erased at build.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const PIPELINE_DIR = path.resolve(__dirname, "..", "pipeline");

type Edge = { from: string; to: string; file: string; target: string };

function collectValueEdges(): Edge[] {
  const edges: Edge[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
      const rel = path.relative(PIPELINE_DIR, full);
      const fromDir = rel.includes(path.sep) ? rel.split(path.sep)[0]! : "<top>";
      const source = fs.readFileSync(full, "utf-8");
      // import/export ... from "..." — skip pure `import type` / `export type`
      const statements = source.match(/(?:import|export)\s+[^;]*?from\s*["'][^"']+["']/gs) ?? [];
      for (const statement of statements) {
        if (/^(?:import|export)\s+type\b/.test(statement)) continue;
        const spec = /from\s*["']([^"']+)["']/.exec(statement)?.[1];
        if (!spec || !spec.startsWith(".")) continue;
        const resolved = path.normalize(path.join(path.dirname(full), spec));
        const targetRel = path.relative(PIPELINE_DIR, resolved);
        if (targetRel.startsWith("..")) continue;
        const toDir = targetRel.includes(path.sep) ? targetRel.split(path.sep)[0]! : "<top>";
        if (toDir !== fromDir) edges.push({ from: fromDir, to: toDir, file: rel, target: targetRel });
      }
    }
  };
  walk(PIPELINE_DIR);
  return edges;
}

describe("pipeline directory value-import graph (ARCH27-T-10)", () => {
  it("has zero bidirectional directory pairs", () => {
    // `<top>` is exempt: the top-level facade files (loop-executor.ts,
    // runtime-tool-handlers.ts, pipeline-executor.ts) re-export their
    // directory by design, which links `<top>` both ways.
    const edges = collectValueEdges().filter((e) => e.from !== "<top>" && e.to !== "<top>");
    const pairs = new Set(edges.map((e) => `${e.from}=>${e.to}`));
    const mutual = [...pairs]
      .map((p) => p.split("=>") as [string, string])
      .filter(([a, b]) => a < b && pairs.has(`${b}=>${a}`))
      .map(([a, b]) => {
        const evidence = edges
          .filter((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a))
          .map((e) => `  ${e.file} -> ${e.target}`)
          .join("\n");
        return `${a} <-> ${b}\n${evidence}`;
      });
    expect(mutual, mutual.join("\n\n")).toEqual([]);
  });

  it("pipeline-shared stays a value-leaf (no value imports of sibling directories)", () => {
    const offending = collectValueEdges().filter(
      (e) => e.from === "pipeline-shared" && e.to !== "pipeline-shared",
    );
    expect(offending.map((e) => `${e.file} -> ${e.target}`)).toEqual([]);
  });
});
