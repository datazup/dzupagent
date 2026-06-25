/**
 * Deep coverage tests for buildImportGraph in @dzupagent/codegen.
 *
 * Focus areas NOT covered by existing tests:
 *  - Empty file array
 *  - Single file with no imports
 *  - .js extension stripping (ESM source → .ts resolution)
 *  - Non-relative (bare / scoped package) imports are ignored
 *  - TypeScript path aliases (starting with @ or non-relative) are ignored
 *  - Files not in the known set (unresolved import → no edge)
 *  - importsFrom with absolute paths vs relative paths
 *  - importedBy with absolute paths vs relative paths
 *  - roots() with all files having imports (no roots)
 *  - Diamond dependency pattern
 *  - Long transitive chain (A→B→C→D→E)
 *  - Namespace import (* as X) symbol extraction
 *  - Default import symbol extraction
 *  - Type-only import symbol extraction
 *  - Import with whitespace and newlines
 *  - Multiple independent connected components
 *  - Graph where every file is a root (no imports anywhere)
 *  - Parent-directory traversal (../../)
 *  - Index.ts resolution in subdirectory
 *  - .mjs → .ts stripping on both extension and resolution
 *  - Re-export only files (no own symbols but still appear in graph)
 *  - File importing from itself (self-loop)
 *  - Edges array contains all imported symbols correctly
 *  - importsFrom/importedBy return same result for equivalent paths
 */

import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { buildImportGraph, type ImportEdge } from "../repomap/import-graph.js";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function abs(rootDir: string, filePath: string): string {
  return path.resolve(rootDir, filePath);
}

// ---------------------------------------------------------------------------
// Empty and trivial graphs
// ---------------------------------------------------------------------------

describe("buildImportGraph — empty and trivial", () => {
  it("handles empty file array", () => {
    const graph = buildImportGraph([], "/root");
    expect(graph.edges).toHaveLength(0);
    expect(graph.roots()).toHaveLength(0);
    expect(graph.importedBy("src/a.ts")).toEqual([]);
    expect(graph.importsFrom("src/a.ts")).toEqual([]);
  });

  it("single file with no imports has no edges and is a root", () => {
    const files = [
      { path: "src/standalone.ts", content: "export const X = 1" },
    ];
    const graph = buildImportGraph(files, "/root");
    expect(graph.edges).toHaveLength(0);
    expect(graph.roots()).toHaveLength(1);
    expect(graph.roots()[0]).toContain("standalone.ts");
    expect(graph.importedBy("src/standalone.ts")).toEqual([]);
    expect(graph.importsFrom("src/standalone.ts")).toEqual([]);
  });

  it("two files with no imports — both are roots", () => {
    const files = [
      { path: "src/a.ts", content: "export const A = 1" },
      { path: "src/b.ts", content: "export const B = 2" },
    ];
    const graph = buildImportGraph(files, "/root");
    expect(graph.edges).toHaveLength(0);
    const roots = graph.roots();
    expect(roots).toHaveLength(2);
    expect(roots.some((r) => r.includes("a.ts"))).toBe(true);
    expect(roots.some((r) => r.includes("b.ts"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Extension handling
// ---------------------------------------------------------------------------

describe("buildImportGraph — extension handling", () => {
  it("resolves .js extension specifiers to .ts files", () => {
    const files = [
      { path: "src/main.ts", content: `import { X } from './lib.js'` },
      { path: "src/lib.ts", content: "export const X = 1" },
    ];
    const graph = buildImportGraph(files, "/project");
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.to).toContain("lib.ts");
  });

  it("resolves .mjs extension specifiers to .ts files", () => {
    const files = [
      { path: "src/main.ts", content: `import { X } from './utils.mjs'` },
      { path: "src/utils.ts", content: "export const X = 1" },
    ];
    const graph = buildImportGraph(files, "/project");
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.to).toContain("utils.ts");
  });

  it("resolves extensionless import by appending .ts", () => {
    const files = [
      { path: "src/main.ts", content: `import { X } from './helper'` },
      { path: "src/helper.ts", content: "export const X = 1" },
    ];
    const graph = buildImportGraph(files, "/project");
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.to).toContain("helper.ts");
  });

  it("does not create an edge when resolved path is not in known set", () => {
    const files = [
      { path: "src/main.ts", content: `import { X } from './does-not-exist'` },
    ];
    const graph = buildImportGraph(files, "/project");
    expect(graph.edges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Non-relative imports are ignored
// ---------------------------------------------------------------------------

describe("buildImportGraph — non-relative imports", () => {
  it("ignores bare package imports", () => {
    const files = [
      {
        path: "src/main.ts",
        content: `import { z } from 'zod'\nimport express from 'express'`,
      },
    ];
    const graph = buildImportGraph(files, "/project");
    expect(graph.edges).toHaveLength(0);
  });

  it("ignores scoped package imports", () => {
    const files = [
      {
        path: "src/main.ts",
        content: `import { something } from '@company/package'\nimport type { T } from '@types/node'`,
      },
    ];
    const graph = buildImportGraph(files, "/project");
    expect(graph.edges).toHaveLength(0);
  });

  it("ignores TypeScript path alias imports starting with @", () => {
    const files = [
      {
        path: "src/main.ts",
        content: `import { Service } from '@/services/user'`,
      },
      { path: "src/services/user.ts", content: "export class Service {}" },
    ];
    // Path aliases are not relative (don't start with .) — so they are ignored
    const graph = buildImportGraph(files, "/project");
    expect(graph.edges).toHaveLength(0);
  });

  it("ignores absolute path imports", () => {
    const files = [
      {
        path: "src/main.ts",
        content: `import { X } from '/absolute/path/module'`,
      },
    ];
    const graph = buildImportGraph(files, "/project");
    expect(graph.edges).toHaveLength(0);
  });

  it("does not create edges for node: protocol imports", () => {
    const files = [
      {
        path: "src/main.ts",
        content: `import * as fs from 'node:fs'\nimport path from 'node:path'`,
      },
    ];
    const graph = buildImportGraph(files, "/project");
    expect(graph.edges).toHaveLength(0);
  });

  it("mixes relative and non-relative: only relative creates edge", () => {
    const files = [
      {
        path: "src/main.ts",
        content: `import { z } from 'zod'\nimport { Local } from './local'`,
      },
      { path: "src/local.ts", content: "export const Local = 1" },
    ];
    const graph = buildImportGraph(files, "/project");
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.to).toContain("local.ts");
  });
});

// ---------------------------------------------------------------------------
// Symbol extraction per import form
// ---------------------------------------------------------------------------

describe("buildImportGraph — symbol extraction", () => {
  it("extracts named imports with spaces around braces", () => {
    const files = [
      { path: "src/a.ts", content: `import { Alpha, Beta, Gamma } from './b'` },
      {
        path: "src/b.ts",
        content:
          "export const Alpha = 1\nexport const Beta = 2\nexport const Gamma = 3",
      },
    ];
    const graph = buildImportGraph(files, "/root");
    expect(graph.edges[0]!.symbols).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it('extracts namespace import as "* as Name"', () => {
    const files = [
      { path: "src/a.ts", content: `import * as Utils from './utils'` },
      { path: "src/utils.ts", content: "export const x = 1" },
    ];
    const graph = buildImportGraph(files, "/root");
    expect(graph.edges[0]!.symbols).toEqual(["* as Utils"]);
  });

  it("extracts default import as the identifier name", () => {
    const files = [
      { path: "src/a.ts", content: `import MyDefault from './module'` },
      { path: "src/module.ts", content: "export default {}" },
    ];
    const graph = buildImportGraph(files, "/root");
    expect(graph.edges[0]!.symbols).toEqual(["MyDefault"]);
  });

  it("extracts type-only import symbols", () => {
    const files = [
      { path: "src/a.ts", content: `import type { MyType } from './types'` },
      { path: "src/types.ts", content: "export interface MyType {}" },
    ];
    const graph = buildImportGraph(files, "/root");
    expect(graph.edges[0]!.symbols).toEqual(["MyType"]);
  });

  it("handles single named import (no comma)", () => {
    const files = [
      { path: "src/a.ts", content: `import { OnlyOne } from './b'` },
      { path: "src/b.ts", content: "export const OnlyOne = 1" },
    ];
    const graph = buildImportGraph(files, "/root");
    expect(graph.edges[0]!.symbols).toEqual(["OnlyOne"]);
  });

  it("handles import with trailing comma in braces", () => {
    // The regex captures the inside of braces; trailing comma leaves an empty string
    // that gets filtered out by the trim+filter logic
    const files = [
      { path: "src/a.ts", content: `import { A, B, } from './b'` },
      { path: "src/b.ts", content: "export const A = 1\nexport const B = 2" },
    ];
    const graph = buildImportGraph(files, "/root");
    const syms = graph.edges[0]!.symbols;
    expect(syms).toContain("A");
    expect(syms).toContain("B");
    // Empty string from trailing comma should be filtered out
    expect(syms).not.toContain("");
  });
});

// ---------------------------------------------------------------------------
// Structural patterns
// ---------------------------------------------------------------------------

describe("buildImportGraph — structural patterns", () => {
  it("diamond dependency: A→B, A→C, B→D, C→D", () => {
    const files = [
      {
        path: "src/a.ts",
        content: `import { B } from './b'\nimport { C } from './c'`,
      },
      {
        path: "src/b.ts",
        content: `import { D } from './d'\nexport const B = 1`,
      },
      {
        path: "src/c.ts",
        content: `import { D } from './d'\nexport const C = 1`,
      },
      { path: "src/d.ts", content: "export const D = 1" },
    ];
    const graph = buildImportGraph(files, "/root");
    // 4 edges total: a→b, a→c, b→d, c→d
    expect(graph.edges).toHaveLength(4);

    // D is imported by both B and C
    const dImporters = graph.importedBy("src/d.ts");
    expect(dImporters).toHaveLength(2);
    expect(dImporters.some((p) => p.includes("b.ts"))).toBe(true);
    expect(dImporters.some((p) => p.includes("c.ts"))).toBe(true);

    // D has no imports — it is a root
    expect(graph.roots()).toContain(abs("/root", "src/d.ts"));

    // A imports from both B and C
    const aImports = graph.importsFrom("src/a.ts");
    expect(aImports).toHaveLength(2);
  });

  it("long chain A→B→C→D→E — E is the only root", () => {
    const files = [
      { path: "src/a.ts", content: `import { B } from './b'` },
      {
        path: "src/b.ts",
        content: `import { C } from './c'\nexport const B = 1`,
      },
      {
        path: "src/c.ts",
        content: `import { D } from './d'\nexport const C = 1`,
      },
      {
        path: "src/d.ts",
        content: `import { E } from './e'\nexport const D = 1`,
      },
      { path: "src/e.ts", content: "export const E = 1" },
    ];
    const graph = buildImportGraph(files, "/root");
    expect(graph.edges).toHaveLength(4);

    const roots = graph.roots();
    expect(roots).toHaveLength(1);
    expect(roots[0]).toContain("e.ts");

    // E is imported only by D
    expect(graph.importedBy("src/e.ts")).toHaveLength(1);
    // D is imported only by C
    expect(graph.importedBy("src/d.ts")).toHaveLength(1);
    // A is not imported by anyone
    expect(graph.importedBy("src/a.ts")).toHaveLength(0);
  });

  it("two independent connected components", () => {
    const files = [
      // Component 1: x→y
      { path: "src/x.ts", content: `import { Y } from './y'` },
      { path: "src/y.ts", content: "export const Y = 1" },
      // Component 2: p→q
      { path: "src/p.ts", content: `import { Q } from './q'` },
      { path: "src/q.ts", content: "export const Q = 1" },
    ];
    const graph = buildImportGraph(files, "/root");
    expect(graph.edges).toHaveLength(2);

    // y and q are roots
    const roots = graph.roots();
    expect(roots).toHaveLength(2);
    expect(roots.some((r) => r.includes("y.ts"))).toBe(true);
    expect(roots.some((r) => r.includes("q.ts"))).toBe(true);

    // Cross-component: x has no relation to q
    expect(graph.importsFrom("src/x.ts").some((p) => p.includes("q.ts"))).toBe(
      false,
    );
  });

  it("star topology: central file imported by many leaves", () => {
    const files = [
      { path: "src/core.ts", content: "export const core = 1" },
      { path: "src/leaf1.ts", content: `import { core } from './core'` },
      { path: "src/leaf2.ts", content: `import { core } from './core'` },
      { path: "src/leaf3.ts", content: `import { core } from './core'` },
      { path: "src/leaf4.ts", content: `import { core } from './core'` },
      { path: "src/leaf5.ts", content: `import { core } from './core'` },
    ];
    const graph = buildImportGraph(files, "/root");
    expect(graph.edges).toHaveLength(5);
    expect(graph.importedBy("src/core.ts")).toHaveLength(5);
    // core has no imports, so it is a root
    expect(graph.roots()).toContain(abs("/root", "src/core.ts"));
  });

  it("no files have imports — all are roots", () => {
    const files = [
      { path: "src/a.ts", content: "export const A = 1" },
      { path: "src/b.ts", content: "export const B = 2" },
      { path: "src/c.ts", content: "export const C = 3" },
    ];
    const graph = buildImportGraph(files, "/root");
    expect(graph.edges).toHaveLength(0);
    expect(graph.roots()).toHaveLength(3);
  });

  it("all files import each other (triangle): no roots", () => {
    const files = [
      {
        path: "src/a.ts",
        content: `import { B } from './b'\nexport const A = 1`,
      },
      {
        path: "src/b.ts",
        content: `import { C } from './c'\nexport const B = 1`,
      },
      {
        path: "src/c.ts",
        content: `import { A } from './a'\nexport const C = 1`,
      },
    ];
    const graph = buildImportGraph(files, "/root");
    expect(graph.edges).toHaveLength(3);
    // Every file has an import, so no file is in roots
    expect(graph.roots()).toHaveLength(0);
  });

  it("self-reference creates a self-loop edge", () => {
    const files = [
      {
        path: "src/self.ts",
        content: `import { X } from './self'\nexport const X = 1`,
      },
    ];
    const graph = buildImportGraph(files, "/root");
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.from).toBe(graph.edges[0]!.to);
    // self.ts imports from itself — it has an outgoing import
    expect(graph.roots()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Path resolution edge cases
// ---------------------------------------------------------------------------

describe("buildImportGraph — path resolution edge cases", () => {
  it("resolves parent-directory traversal (../) correctly", () => {
    const files = [
      { path: "src/deep/file.ts", content: `import { X } from '../utils'` },
      { path: "src/utils.ts", content: "export const X = 1" },
    ];
    const graph = buildImportGraph(files, "/project");
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.to).toContain("utils.ts");
  });

  it("resolves two-level parent traversal (../../) correctly", () => {
    const files = [
      {
        path: "src/a/b/file.ts",
        content: `import { X } from '../../root-util'`,
      },
      { path: "src/root-util.ts", content: "export const X = 1" },
    ];
    const graph = buildImportGraph(files, "/project");
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.to).toContain("root-util.ts");
  });

  it("resolves barrel index.ts when importing a directory", () => {
    const files = [
      { path: "src/main.ts", content: `import { Thing } from './components'` },
      { path: "src/components/index.ts", content: "export class Thing {}" },
    ];
    const graph = buildImportGraph(files, "/project");
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.to).toContain("index.ts");
  });

  it("prefers exact path match over .ts extension append", () => {
    // If both './lib' and './lib.ts' exist as files, the exact match wins
    const files = [
      { path: "src/main.ts", content: `import { X } from './lib.ts'` },
      { path: "src/lib.ts", content: "export const X = 1" },
    ];
    const graph = buildImportGraph(files, "/project");
    // The regex strips .js and .mjs but not .ts — so './lib.ts' resolves as './lib.ts'
    // which matches src/lib.ts directly
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.to).toContain("lib.ts");
  });

  it("rootDir is used to resolve all file paths", () => {
    const files = [
      { path: "a.ts", content: `import { B } from './b'` },
      { path: "b.ts", content: "export const B = 1" },
    ];
    const rootDir = "/my/custom/root";
    const graph = buildImportGraph(files, rootDir);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.from).toBe(path.resolve(rootDir, "a.ts"));
    expect(graph.edges[0]!.to).toBe(path.resolve(rootDir, "b.ts"));
  });

  it("importedBy accepts relative path and resolves against rootDir", () => {
    const files = [
      { path: "src/main.ts", content: `import { X } from './lib'` },
      { path: "src/lib.ts", content: "export const X = 1" },
    ];
    const graph = buildImportGraph(files, "/root");
    const importers = graph.importedBy("src/lib.ts");
    expect(importers).toHaveLength(1);
    expect(importers[0]).toContain("main.ts");
  });

  it("importsFrom accepts relative path and resolves against rootDir", () => {
    const files = [
      {
        path: "src/main.ts",
        content: `import { X } from './lib'\nimport { Y } from './other'`,
      },
      { path: "src/lib.ts", content: "export const X = 1" },
      { path: "src/other.ts", content: "export const Y = 2" },
    ];
    const graph = buildImportGraph(files, "/root");
    const imports = graph.importsFrom("src/main.ts");
    expect(imports).toHaveLength(2);
    expect(imports.some((p) => p.includes("lib.ts"))).toBe(true);
    expect(imports.some((p) => p.includes("other.ts"))).toBe(true);
  });

  it("importedBy returns empty array for unknown file", () => {
    const files = [
      { path: "src/a.ts", content: `import { X } from './b'` },
      { path: "src/b.ts", content: "export const X = 1" },
    ];
    const graph = buildImportGraph(files, "/root");
    expect(graph.importedBy("src/does-not-exist.ts")).toEqual([]);
  });

  it("importsFrom returns empty array for unknown file", () => {
    const files = [
      { path: "src/a.ts", content: `import { X } from './b'` },
      { path: "src/b.ts", content: "export const X = 1" },
    ];
    const graph = buildImportGraph(files, "/root");
    expect(graph.importsFrom("src/does-not-exist.ts")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Edge object structure
// ---------------------------------------------------------------------------

describe("buildImportGraph — edge object structure", () => {
  it("each edge has from, to, and symbols properties", () => {
    const files = [
      { path: "src/a.ts", content: `import { X } from './b'` },
      { path: "src/b.ts", content: "export const X = 1" },
    ];
    const graph = buildImportGraph(files, "/root");
    const edge = graph.edges[0] as ImportEdge;
    expect(edge).toHaveProperty("from");
    expect(edge).toHaveProperty("to");
    expect(edge).toHaveProperty("symbols");
    expect(Array.isArray(edge.symbols)).toBe(true);
  });

  it("from and to are absolute paths", () => {
    const files = [
      { path: "src/a.ts", content: `import { X } from './b'` },
      { path: "src/b.ts", content: "export const X = 1" },
    ];
    const graph = buildImportGraph(files, "/root");
    const edge = graph.edges[0]!;
    expect(path.isAbsolute(edge.from)).toBe(true);
    expect(path.isAbsolute(edge.to)).toBe(true);
  });

  it("multiple edges for same A→B import appear as separate edge objects", () => {
    const files = [
      {
        path: "src/main.ts",
        content: `import { A } from './lib'\nimport { B } from './lib'\nimport { C } from './lib'`,
      },
      {
        path: "src/lib.ts",
        content: "export const A = 1\nexport const B = 2\nexport const C = 3",
      },
    ];
    const graph = buildImportGraph(files, "/root");
    expect(graph.edges).toHaveLength(3);
    // All three edges point to the same target
    const allToLib = graph.edges.every((e) => e.to.includes("lib.ts"));
    expect(allToLib).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Large-scale correctness
// ---------------------------------------------------------------------------

describe("buildImportGraph — large-scale", () => {
  it("builds a graph with 10 files in a chain correctly", () => {
    const n = 10;
    const files = Array.from({ length: n }, (_, i) => ({
      path: `src/file${i}.ts`,
      content:
        i < n - 1
          ? `import { X${i + 1} } from './file${i + 1}'\nexport const X${i} = 1`
          : `export const X${i} = 1`,
    }));

    const graph = buildImportGraph(files, "/root");
    expect(graph.edges).toHaveLength(n - 1);

    // Only the last file has no imports — it is the single root
    const roots = graph.roots();
    expect(roots).toHaveLength(1);
    expect(roots[0]).toContain(`file${n - 1}.ts`);
  });

  it("builds a hub-and-spoke graph with 8 spokes correctly", () => {
    const spokes = 8;
    const files = [
      { path: "src/hub.ts", content: "export const hub = 1" },
      ...Array.from({ length: spokes }, (_, i) => ({
        path: `src/spoke${i}.ts`,
        content: `import { hub } from './hub'`,
      })),
    ];

    const graph = buildImportGraph(files, "/root");
    expect(graph.edges).toHaveLength(spokes);
    expect(graph.importedBy("src/hub.ts")).toHaveLength(spokes);

    // hub has no imports — it is a root
    expect(graph.roots()).toContain(abs("/root", "src/hub.ts"));
    // Spokes all import hub — they are not roots
    expect(graph.roots().filter((r) => r.includes("spoke"))).toHaveLength(0);
  });

  it("complete graph of 4 nodes (every pair imports each other)", () => {
    // A→B, A→C, A→D, B→A, B→C, B→D, C→A, C→B, C→D, D→A, D→B, D→C
    const nodes = ["a", "b", "c", "d"];
    const files = nodes.map((n) => ({
      path: `src/${n}.ts`,
      content:
        nodes
          .filter((m) => m !== n)
          .map((m) => `import { ${m.toUpperCase()} } from './${m}'`)
          .join("\n") + `\nexport const ${n.toUpperCase()} = 1`,
    }));

    const graph = buildImportGraph(files, "/root");
    // 4 * 3 = 12 edges
    expect(graph.edges).toHaveLength(12);
    // Every file has imports — no roots
    expect(graph.roots()).toHaveLength(0);
    // Each node is imported by 3 others
    for (const n of nodes) {
      expect(graph.importedBy(`src/${n}.ts`)).toHaveLength(3);
    }
  });
});

// ---------------------------------------------------------------------------
// Multi-line and complex content
// ---------------------------------------------------------------------------

describe("buildImportGraph — multi-line and complex content", () => {
  it("finds imports among other code (functions, classes, comments)", () => {
    const files = [
      {
        path: "src/service.ts",
        content: `// A service module
/**
 * Handles user operations.
 */
import { Repository } from './repository'

export class UserService {
  constructor(private repo: Repository) {}

  async getUser(id: string) {
    return this.repo.findById(id)
  }
}
`,
      },
      { path: "src/repository.ts", content: "export class Repository {}" },
    ];
    const graph = buildImportGraph(files, "/root");
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.symbols).toEqual(["Repository"]);
  });

  it("handles files with only comments (no imports)", () => {
    const files = [
      {
        path: "src/types.ts",
        content: `// This file defines types
// No imports needed here
export interface Config {}
`,
      },
    ];
    const graph = buildImportGraph(files, "/root");
    expect(graph.edges).toHaveLength(0);
    expect(graph.roots()).toHaveLength(1);
  });

  it("handles empty file content", () => {
    const files = [
      { path: "src/empty.ts", content: "" },
      { path: "src/other.ts", content: "export const X = 1" },
    ];
    const graph = buildImportGraph(files, "/root");
    expect(graph.edges).toHaveLength(0);
    expect(graph.roots()).toHaveLength(2);
  });

  it("handles file with only whitespace", () => {
    const files = [{ path: "src/whitespace.ts", content: "   \n\n\t  \n  " }];
    const graph = buildImportGraph(files, "/root");
    expect(graph.edges).toHaveLength(0);
    expect(graph.roots()).toHaveLength(1);
  });

  it("correctly resets regex state between files (global regex)", () => {
    // The IMPORT_RE regex uses /g flag and needs lastIndex reset per file
    const files = [
      { path: "src/a.ts", content: `import { X } from './x'` },
      { path: "src/b.ts", content: `import { Y } from './y'` },
      { path: "src/x.ts", content: "export const X = 1" },
      { path: "src/y.ts", content: "export const Y = 2" },
    ];
    const graph = buildImportGraph(files, "/root");
    // Both imports should be captured correctly
    expect(graph.edges).toHaveLength(2);
    expect(graph.edges.some((e) => e.to.includes("x.ts"))).toBe(true);
    expect(graph.edges.some((e) => e.to.includes("y.ts"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// roots() behavior
// ---------------------------------------------------------------------------

describe("buildImportGraph — roots() behavior", () => {
  it("roots returns absolute paths", () => {
    const files = [{ path: "src/leaf.ts", content: "export const X = 1" }];
    const graph = buildImportGraph(files, "/root");
    const roots = graph.roots();
    expect(roots.every((r) => path.isAbsolute(r))).toBe(true);
  });

  it("roots contains all files when none have imports", () => {
    const n = 5;
    const files = Array.from({ length: n }, (_, i) => ({
      path: `src/f${i}.ts`,
      content: `export const F${i} = ${i}`,
    }));
    const graph = buildImportGraph(files, "/root");
    expect(graph.roots()).toHaveLength(n);
  });

  it("roots is empty when all files have at least one import", () => {
    const files = [
      {
        path: "src/a.ts",
        content: `import { B } from './b'\nexport const A = 1`,
      },
      {
        path: "src/b.ts",
        content: `import { A } from './a'\nexport const B = 1`,
      },
    ];
    const graph = buildImportGraph(files, "/root");
    // Both files import each other — neither is a root
    expect(graph.roots()).toHaveLength(0);
  });
});
