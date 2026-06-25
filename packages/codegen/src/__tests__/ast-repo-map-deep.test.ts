/**
 * W30-B — AST-based repo map deep coverage.
 *
 * All three source modules under packages/codegen/src/repomap/ are
 * implemented with regex-based parsing (no ts-morph runtime dependency).
 * Tests are written against the real public API exported from:
 *   - symbol-extractor.ts   (extractSymbols)
 *   - import-graph.ts       (buildImportGraph)
 *   - repo-map-builder.ts   (buildRepoMap)
 *
 * Coverage goal: ≥80 new tests targeting gaps left by existing suites.
 */

import { describe, it, expect } from "vitest";
import * as path from "node:path";
import {
  extractSymbols,
  type ExtractedSymbol,
} from "../repomap/symbol-extractor.js";
import {
  buildImportGraph,
  type ImportEdge,
  type ImportGraph,
} from "../repomap/import-graph.js";
import {
  buildRepoMap,
  type RepoMap,
  type RepoMapConfig,
} from "../repomap/repo-map-builder.js";

// ============================================================================
// extractSymbols — deep symbol extraction tests
// ============================================================================

describe("extractSymbols — symbol kinds: abstract class", () => {
  it("extracts abstract class", () => {
    const syms = extractSymbols("a.ts", "abstract class Base {}");
    expect(syms).toHaveLength(1);
    expect(syms[0]!.kind).toBe("class");
    expect(syms[0]!.name).toBe("Base");
    expect(syms[0]!.exported).toBe(false);
  });

  it("extracts exported abstract class", () => {
    const syms = extractSymbols("a.ts", "export abstract class Vehicle {}");
    expect(syms).toHaveLength(1);
    expect(syms[0]!.kind).toBe("class");
    expect(syms[0]!.name).toBe("Vehicle");
    expect(syms[0]!.exported).toBe(true);
  });

  it("abstract class signature does not include export keyword", () => {
    const syms = extractSymbols("a.ts", "export abstract class Shape {}");
    expect(syms[0]!.signature).not.toMatch(/^export/);
  });
});

describe("extractSymbols — const enum", () => {
  it("extracts const enum", () => {
    const syms = extractSymbols(
      "e.ts",
      "const enum Direction { North, South }"
    );
    expect(syms).toHaveLength(1);
    expect(syms[0]!.kind).toBe("enum");
    expect(syms[0]!.name).toBe("Direction");
    expect(syms[0]!.exported).toBe(false);
  });

  it("extracts exported const enum", () => {
    const syms = extractSymbols(
      "e.ts",
      "export const enum Tier { Free, Pro, Enterprise }"
    );
    expect(syms).toHaveLength(1);
    expect(syms[0]!.kind).toBe("enum");
    expect(syms[0]!.name).toBe("Tier");
    expect(syms[0]!.exported).toBe(true);
  });
});

describe("extractSymbols — async functions", () => {
  it("extracts unexported async function", () => {
    const syms = extractSymbols(
      "f.ts",
      "async function fetchData(): Promise<string> {}"
    );
    expect(syms).toHaveLength(1);
    expect(syms[0]!.kind).toBe("function");
    expect(syms[0]!.name).toBe("fetchData");
    expect(syms[0]!.exported).toBe(false);
  });

  it("extracts exported async function with generic return", () => {
    const syms = extractSymbols(
      "f.ts",
      "export async function query<T>(sql: string): Promise<T[]> {}"
    );
    expect(syms).toHaveLength(1);
    expect(syms[0]!.kind).toBe("function");
    expect(syms[0]!.name).toBe("query");
    expect(syms[0]!.exported).toBe(true);
  });
});

describe("extractSymbols — type aliases", () => {
  it("extracts union type alias", () => {
    const syms = extractSymbols(
      "t.ts",
      'type Status = "active" | "inactive" | "pending"'
    );
    expect(syms).toHaveLength(1);
    expect(syms[0]!.kind).toBe("type");
    expect(syms[0]!.name).toBe("Status");
  });

  it("extracts intersection type alias", () => {
    const syms = extractSymbols("t.ts", "export type AdminUser = User & Admin");
    expect(syms).toHaveLength(1);
    expect(syms[0]!.kind).toBe("type");
    expect(syms[0]!.name).toBe("AdminUser");
    expect(syms[0]!.exported).toBe(true);
  });

  it("extracts mapped type alias", () => {
    const syms = extractSymbols(
      "t.ts",
      "export type Readonly<T> = { readonly [K in keyof T]: T[K] }"
    );
    expect(syms).toHaveLength(1);
    expect(syms[0]!.kind).toBe("type");
    expect(syms[0]!.name).toBe("Readonly");
  });

  it("does not match type-only import lines", () => {
    const syms = extractSymbols(
      "f.ts",
      "import type { Something } from './module'"
    );
    expect(syms).toHaveLength(0);
  });
});

describe("extractSymbols — comment skipping", () => {
  it("skips single-line comments", () => {
    const syms = extractSymbols("f.ts", "// export class Fake {}");
    expect(syms).toHaveLength(0);
  });

  it("skips block comment open lines", () => {
    const syms = extractSymbols("f.ts", "/* export class Fake {} */");
    expect(syms).toHaveLength(0);
  });

  it("skips JSDoc continuation lines (star-prefixed)", () => {
    const content = `/**
 * export class Fake {}
 */
export class Real {}`;
    const syms = extractSymbols("f.ts", content);
    expect(syms).toHaveLength(1);
    expect(syms[0]!.name).toBe("Real");
  });

  it("does not skip symbols after inline comments", () => {
    const content = `// comment
export const VALUE = 42`;
    const syms = extractSymbols("f.ts", content);
    expect(syms).toHaveLength(1);
    expect(syms[0]!.name).toBe("VALUE");
  });
});

describe("extractSymbols — line number accuracy", () => {
  it("line 1 for first line symbol", () => {
    const syms = extractSymbols("f.ts", "export class First {}");
    expect(syms[0]!.line).toBe(1);
  });

  it("correct line for symbol after multiline comment", () => {
    const content = `// line 1
// line 2
// line 3
export function target() {}`;
    const syms = extractSymbols("f.ts", content);
    expect(syms[0]!.line).toBe(4);
  });

  it("multiple symbols have ascending line numbers", () => {
    const content = `export class A {}
export class B {}
export class C {}`;
    const syms = extractSymbols("f.ts", content);
    expect(syms[0]!.line).toBe(1);
    expect(syms[1]!.line).toBe(2);
    expect(syms[2]!.line).toBe(3);
  });

  it("single blank line between symbols increments line correctly", () => {
    const content = `export class X {}

export class Y {}`;
    const syms = extractSymbols("f.ts", content);
    expect(syms[0]!.line).toBe(1);
    expect(syms[1]!.line).toBe(3);
  });
});

describe("extractSymbols — signature shape", () => {
  it("class signature contains class keyword and name", () => {
    const syms = extractSymbols("f.ts", "export class MyClass {}");
    expect(syms[0]!.signature).toContain("class MyClass");
  });

  it("interface signature contains interface keyword and name", () => {
    const syms = extractSymbols("f.ts", "export interface MyInterface {}");
    expect(syms[0]!.signature).toContain("interface MyInterface");
  });

  it("enum signature contains enum keyword and name", () => {
    const syms = extractSymbols("f.ts", "export enum MyEnum { A }");
    expect(syms[0]!.signature).toContain("enum MyEnum");
  });

  it("function signature contains function keyword and name", () => {
    const syms = extractSymbols("f.ts", "export function myFn() {}");
    expect(syms[0]!.signature).toContain("function myFn");
  });

  it("const signature contains const keyword and name", () => {
    const syms = extractSymbols("f.ts", "export const MY_CONST = 1");
    expect(syms[0]!.signature).toContain("const MY_CONST");
  });

  it("type alias signature contains type keyword and name", () => {
    const syms = extractSymbols("f.ts", "export type MyAlias = string");
    expect(syms[0]!.signature).toContain("type MyAlias");
  });

  it("signature never ends with an opening brace", () => {
    const content = `export class A {
export function b() {
export interface C {`;
    const syms = extractSymbols("f.ts", content);
    for (const sym of syms) {
      expect(sym.signature).not.toMatch(/\{$/);
    }
  });
});

describe("extractSymbols — edge cases: whitespace and indentation", () => {
  it("handles leading spaces (indented code)", () => {
    const syms = extractSymbols("f.ts", "   export class Indented {}");
    expect(syms).toHaveLength(1);
    expect(syms[0]!.name).toBe("Indented");
  });

  it("handles leading tabs", () => {
    const syms = extractSymbols("f.ts", "\texport class Tabbed {}");
    expect(syms).toHaveLength(1);
    expect(syms[0]!.name).toBe("Tabbed");
  });

  it("handles only-whitespace file", () => {
    expect(extractSymbols("f.ts", "   \t   \n  \n  ")).toEqual([]);
  });
});

describe("extractSymbols — first-pattern-wins per line", () => {
  it("class takes precedence over const on same line", () => {
    // A const declaration starting with "class" token won't normally happen,
    // but verifying: const keyword not matched as class
    const syms = extractSymbols("f.ts", "export const classValue = 1");
    // Should match as 'const', not 'class'
    expect(syms).toHaveLength(1);
    expect(syms[0]!.kind).toBe("const");
    expect(syms[0]!.name).toBe("classValue");
  });

  it("enum is detected before const on const enum lines", () => {
    const syms = extractSymbols("f.ts", "export const enum MyEnum { A }");
    expect(syms[0]!.kind).toBe("enum");
  });
});

describe("extractSymbols — filePath in output", () => {
  it("uses exact filePath string passed in", () => {
    const syms = extractSymbols("/absolute/path/mod.ts", "export class X {}");
    expect(syms[0]!.filePath).toBe("/absolute/path/mod.ts");
  });

  it("filePath with slashes and dots is preserved", () => {
    const syms = extractSymbols("src/deep/dir/file.ts", "export class X {}");
    expect(syms[0]!.filePath).toBe("src/deep/dir/file.ts");
  });
});

describe("extractSymbols — real-world patterns", () => {
  it("extracts symbols from a typical service module", () => {
    const content = `import { Injectable } from './ioc'
import type { Logger } from './logger'

export interface UserServiceConfig {
  maxRetries: number
}

export class UserService {
  constructor(private readonly logger: Logger) {}
}

export function createUserService(config: UserServiceConfig): UserService {
  return new UserService(console as unknown as Logger)
}

export const DEFAULT_CONFIG: UserServiceConfig = { maxRetries: 3 }

export type UserId = string & { __brand: 'UserId' }

export enum UserRole {
  Admin = 'admin',
  Member = 'member',
}`;
    const syms = extractSymbols("service.ts", content);
    const kinds = syms.map((s) => s.kind);
    expect(kinds).toContain("interface");
    expect(kinds).toContain("class");
    expect(kinds).toContain("function");
    expect(kinds).toContain("const");
    expect(kinds).toContain("type");
    expect(kinds).toContain("enum");
    // All should be exported
    for (const sym of syms) {
      expect(sym.exported).toBe(true);
    }
  });

  it("extracts symbols from a utility file with mixed export status", () => {
    const content = `function privateHelper(x: number): number { return x * 2 }
export function publicUtil(x: number): number { return privateHelper(x) }
const INTERNAL_CONSTANT = 'secret'
export const PUBLIC_CONSTANT = 'public'`;
    const syms = extractSymbols("util.ts", content);
    expect(syms).toHaveLength(4);
    const exported = syms.filter((s) => s.exported);
    const notExported = syms.filter((s) => !s.exported);
    expect(exported).toHaveLength(2);
    expect(notExported).toHaveLength(2);
  });
});

// ============================================================================
// buildImportGraph — deep import graph tests
// ============================================================================

describe("buildImportGraph — symbol extraction from import styles", () => {
  it("extracts aliased named import symbol", () => {
    const files = [
      { path: "src/a.ts", content: `import { Foo as F } from './b'` },
      { path: "src/b.ts", content: "export class Foo {}" },
    ];
    const graph = buildImportGraph(files, "/root");
    // The raw match includes the alias text
    expect(graph.edges[0]!.symbols).toContain("Foo as F");
  });

  it("extracts multiple aliased named imports", () => {
    const files = [
      { path: "src/a.ts", content: `import { A as X, B as Y } from './b'` },
      { path: "src/b.ts", content: "export const A = 1\nexport const B = 2" },
    ];
    const graph = buildImportGraph(files, "/root");
    expect(graph.edges[0]!.symbols).toHaveLength(2);
  });

  it("default import produces single-element symbols array", () => {
    const files = [
      { path: "src/a.ts", content: `import MyDefault from './b'` },
      { path: "src/b.ts", content: "export default class MyDefault {}" },
    ];
    const graph = buildImportGraph(files, "/root");
    expect(graph.edges[0]!.symbols).toEqual(["MyDefault"]);
  });

  it('namespace import produces "* as X" symbol', () => {
    const files = [
      { path: "src/a.ts", content: `import * as utils from './utils'` },
      { path: "src/utils.ts", content: "export const x = 1" },
    ];
    const graph = buildImportGraph(files, "/root");
    expect(graph.edges[0]!.symbols).toEqual(["* as utils"]);
  });

  it("type-only import produces symbols in edges", () => {
    const files = [
      { path: "src/a.ts", content: `import type { MyType } from './types'` },
      { path: "src/types.ts", content: "export type MyType = string" },
    ];
    const graph = buildImportGraph(files, "/root");
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.symbols).toContain("MyType");
  });
});

describe("buildImportGraph — path resolution", () => {
  it("resolves .js ESM extension to .ts", () => {
    const files = [
      { path: "src/a.ts", content: `import { X } from './b.js'` },
      { path: "src/b.ts", content: "export const X = 1" },
    ];
    const graph = buildImportGraph(files, "/root");
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.to).toContain("b.ts");
  });

  it("resolves .mjs ESM extension to .ts", () => {
    const files = [
      { path: "src/a.ts", content: `import { X } from './b.mjs'` },
      { path: "src/b.ts", content: "export const X = 1" },
    ];
    const graph = buildImportGraph(files, "/root");
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.to).toContain("b.ts");
  });

  it("resolves directory import to index.ts in that directory", () => {
    const files = [
      { path: "src/app.ts", content: `import { Thing } from './lib'` },
      { path: "src/lib/index.ts", content: "export class Thing {}" },
    ];
    const graph = buildImportGraph(files, "/root");
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.to).toContain("index.ts");
  });

  it("ignores bare package imports (no relative path)", () => {
    const files = [{ path: "src/a.ts", content: `import React from 'react'` }];
    const graph = buildImportGraph(files, "/root");
    expect(graph.edges).toHaveLength(0);
  });

  it("ignores scoped package imports", () => {
    const files = [
      { path: "src/a.ts", content: `import { z } from '@org/package'` },
    ];
    const graph = buildImportGraph(files, "/root");
    expect(graph.edges).toHaveLength(0);
  });

  it("ignores imports to files not in the known set", () => {
    const files = [
      { path: "src/a.ts", content: `import { X } from './unknown-file'` },
    ];
    const graph = buildImportGraph(files, "/root");
    expect(graph.edges).toHaveLength(0);
  });

  it("resolves parent directory traversal (../)", () => {
    const files = [
      { path: "src/sub/a.ts", content: `import { X } from '../utils'` },
      { path: "src/utils.ts", content: "export const X = 1" },
    ];
    const graph = buildImportGraph(files, "/root");
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.to).toContain("utils.ts");
  });

  it("resolves deeply nested parent traversal (../../)", () => {
    const files = [
      { path: "src/a/b/c.ts", content: `import { X } from '../../utils'` },
      { path: "src/utils.ts", content: "export const X = 1" },
    ];
    const graph = buildImportGraph(files, "/root");
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.to).toContain("utils.ts");
  });
});

describe("buildImportGraph — graph structure and topology", () => {
  it("empty graph has no edges and no roots", () => {
    const graph = buildImportGraph([], "/root");
    expect(graph.edges).toHaveLength(0);
    expect(graph.roots()).toHaveLength(0);
  });

  it("single file with no imports is a root", () => {
    const files = [{ path: "src/lone.ts", content: "export const x = 1" }];
    const graph = buildImportGraph(files, "/root");
    expect(graph.roots()).toHaveLength(1);
    expect(graph.edges).toHaveLength(0);
  });

  it("circular A->B->A: both files appear as importers", () => {
    const files = [
      {
        path: "src/a.ts",
        content: `import { B } from './b'\nexport const A = 1`,
      },
      {
        path: "src/b.ts",
        content: `import { A } from './a'\nexport const B = 2`,
      },
    ];
    const graph = buildImportGraph(files, "/root");
    expect(graph.edges).toHaveLength(2);
    expect(graph.importedBy("src/a.ts")).toHaveLength(1);
    expect(graph.importedBy("src/b.ts")).toHaveLength(1);
  });

  it("circular A->B->C->A: three-way cycle resolves without error", () => {
    const files = [
      {
        path: "src/a.ts",
        content: `import { C } from './c'\nexport const A = 1`,
      },
      {
        path: "src/b.ts",
        content: `import { A } from './a'\nexport const B = 2`,
      },
      {
        path: "src/c.ts",
        content: `import { B } from './b'\nexport const C = 3`,
      },
    ];
    const graph = buildImportGraph(files, "/root");
    expect(graph.edges).toHaveLength(3);
    // In a full cycle, no file is a root (every file is imported by another)
    expect(graph.roots()).toHaveLength(0);
  });

  it("diamond dependency: A imports B and C, both import D", () => {
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
        content: `import { D } from './d'\nexport const C = 2`,
      },
      { path: "src/d.ts", content: "export const D = 3" },
    ];
    const graph = buildImportGraph(files, "/root");
    expect(graph.edges).toHaveLength(4);
    // D is imported by both B and C
    expect(graph.importedBy("src/d.ts")).toHaveLength(2);
    // A imports both B and C
    expect(graph.importsFrom("src/a.ts")).toHaveLength(2);
    // D has no imports, so it's a root
    const roots = graph.roots();
    expect(roots.some((r) => r.endsWith("d.ts"))).toBe(true);
  });

  it("star topology: all files import the hub, hub imports nothing", () => {
    const hub = { path: "src/hub.ts", content: "export const HUB = 1" };
    const spokes = Array.from({ length: 5 }, (_, i) => ({
      path: `src/spoke${i}.ts`,
      content: `import { HUB } from './hub'`,
    }));
    const graph = buildImportGraph([hub, ...spokes], "/root");
    expect(graph.importedBy("src/hub.ts")).toHaveLength(5);
    // All spokes have no imports pointing back, hub is a root (no imports)
    const roots = graph.roots();
    expect(roots.some((r) => r.endsWith("hub.ts"))).toBe(true);
  });

  it("chain A->B->C->D->E: roots() returns only E", () => {
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
  });

  it("two independent sub-graphs have independent roots", () => {
    const files = [
      { path: "src/a1.ts", content: `import { B1 } from './b1'` },
      { path: "src/b1.ts", content: "export const B1 = 1" },
      { path: "src/a2.ts", content: `import { B2 } from './b2'` },
      { path: "src/b2.ts", content: "export const B2 = 2" },
    ];
    const graph = buildImportGraph(files, "/root");
    expect(graph.edges).toHaveLength(2);
    const roots = graph.roots();
    expect(roots).toHaveLength(2);
    expect(roots.some((r) => r.endsWith("b1.ts"))).toBe(true);
    expect(roots.some((r) => r.endsWith("b2.ts"))).toBe(true);
  });
});

describe("buildImportGraph — importedBy / importsFrom queries", () => {
  it("importedBy for unknown file returns empty array", () => {
    const files = [{ path: "src/a.ts", content: "export const x = 1" }];
    const graph = buildImportGraph(files, "/root");
    expect(graph.importedBy("src/totally-missing.ts")).toEqual([]);
  });

  it("importsFrom for unknown file returns empty array", () => {
    const files = [{ path: "src/a.ts", content: "export const x = 1" }];
    const graph = buildImportGraph(files, "/root");
    expect(graph.importsFrom("src/totally-missing.ts")).toEqual([]);
  });

  it("importsFrom lists all targets", () => {
    const files = [
      {
        path: "src/main.ts",
        content: `import { A } from './a'\nimport { B } from './b'\nimport { C } from './c'`,
      },
      { path: "src/a.ts", content: "export const A = 1" },
      { path: "src/b.ts", content: "export const B = 2" },
      { path: "src/c.ts", content: "export const C = 3" },
    ];
    const graph = buildImportGraph(files, "/root");
    const targets = graph.importsFrom("src/main.ts");
    expect(targets).toHaveLength(3);
    expect(targets.some((t) => t.endsWith("a.ts"))).toBe(true);
    expect(targets.some((t) => t.endsWith("b.ts"))).toBe(true);
    expect(targets.some((t) => t.endsWith("c.ts"))).toBe(true);
  });

  it("importedBy lists all importers of a shared utility", () => {
    const files = [
      { path: "src/shared.ts", content: "export const shared = 1" },
      { path: "src/p.ts", content: `import { shared } from './shared'` },
      { path: "src/q.ts", content: `import { shared } from './shared'` },
      { path: "src/r.ts", content: `import { shared } from './shared'` },
    ];
    const graph = buildImportGraph(files, "/root");
    expect(graph.importedBy("src/shared.ts")).toHaveLength(3);
  });
});

describe("buildImportGraph — edge metadata", () => {
  it("edge from and to are absolute paths", () => {
    const files = [
      { path: "src/a.ts", content: `import { X } from './b'` },
      { path: "src/b.ts", content: "export const X = 1" },
    ];
    const graph = buildImportGraph(files, "/root");
    expect(path.isAbsolute(graph.edges[0]!.from)).toBe(true);
    expect(path.isAbsolute(graph.edges[0]!.to)).toBe(true);
  });

  it("edge symbols is always an array (never undefined)", () => {
    const files = [
      { path: "src/a.ts", content: `import DefaultExport from './b'` },
      { path: "src/b.ts", content: "export default class {}" },
    ];
    const graph = buildImportGraph(files, "/root");
    for (const edge of graph.edges) {
      expect(Array.isArray(edge.symbols)).toBe(true);
    }
  });

  it("ImportEdge interface has from, to, symbols fields", () => {
    const files = [
      { path: "src/a.ts", content: `import { X } from './b'` },
      { path: "src/b.ts", content: "export const X = 1" },
    ];
    const graph = buildImportGraph(files, "/root");
    const edge = graph.edges[0]!;
    expect(edge).toHaveProperty("from");
    expect(edge).toHaveProperty("to");
    expect(edge).toHaveProperty("symbols");
  });
});

describe("buildImportGraph — barrel files and re-exports", () => {
  it("barrel index.ts resolves when multiple spokes import from it", () => {
    const files = [
      {
        path: "src/components/index.ts",
        content: "export class Button {}\nexport class Input {}",
      },
      {
        path: "src/pageA.ts",
        content: `import { Button } from './components'`,
      },
      {
        path: "src/pageB.ts",
        content: `import { Button, Input } from './components'`,
      },
    ];
    const graph = buildImportGraph(files, "/root");
    expect(graph.edges).toHaveLength(2);
    expect(graph.importedBy("src/components/index.ts")).toHaveLength(2);
  });

  it("transitive barrel: A -> barrel -> leaf resolves each edge independently", () => {
    const files = [
      { path: "src/index.ts", content: `import { Leaf } from './leaf'` },
      { path: "src/leaf.ts", content: "export const Leaf = 1" },
      { path: "src/app.ts", content: `import { Leaf } from './index'` },
    ];
    const graph = buildImportGraph(files, "/root");
    expect(graph.edges).toHaveLength(2);
    // index.ts is imported by app.ts
    expect(graph.importedBy("src/index.ts")).toHaveLength(1);
  });
});

// ============================================================================
// buildRepoMap — deep repo map tests
// ============================================================================

describe("buildRepoMap — return shape invariants", () => {
  it("returned object always has all four fields", () => {
    const map = buildRepoMap([]);
    expect(map).toHaveProperty("content");
    expect(map).toHaveProperty("symbolCount");
    expect(map).toHaveProperty("fileCount");
    expect(map).toHaveProperty("estimatedTokens");
  });

  it("symbolCount equals number of dash-prefixed lines in content", () => {
    const files = [
      { path: "src/a.ts", content: "export class A {}\nexport class B {}" },
    ];
    const map = buildRepoMap(files, { maxTokens: 100000 });
    const dashLines = (map.content.match(/^- /gm) ?? []).length;
    expect(map.symbolCount).toBe(dashLines);
  });

  it("fileCount equals number of ## headings in content", () => {
    const files = [
      { path: "src/a.ts", content: "export class A {}" },
      { path: "src/b.ts", content: "export class B {}" },
      { path: "src/c.ts", content: "export class C {}" },
    ];
    const map = buildRepoMap(files, { maxTokens: 100000 });
    const headings = (map.content.match(/^## /gm) ?? []).length;
    expect(map.fileCount).toBe(headings);
  });

  it("estimatedTokens is approximately content.length / 4", () => {
    const files = [
      {
        path: "src/m.ts",
        content: "export class BigName {}\nexport function bigFunction() {}",
      },
    ];
    const map = buildRepoMap(files, { maxTokens: 100000 });
    const expected = Math.ceil(map.content.length / 4);
    expect(map.estimatedTokens).toBe(expected);
  });
});

describe("buildRepoMap — token budget enforcement", () => {
  it('empty files array: symbolCount=0, fileCount=0, estimatedTokens=0, content=""', () => {
    const map = buildRepoMap([]);
    expect(map.symbolCount).toBe(0);
    expect(map.fileCount).toBe(0);
    expect(map.estimatedTokens).toBe(0);
    expect(map.content).toBe("");
  });

  it("token budget of 0 produces empty content", () => {
    const map = buildRepoMap(
      [{ path: "src/a.ts", content: "export class A {}" }],
      { maxTokens: 0 }
    );
    expect(map.symbolCount).toBe(0);
  });

  it("estimatedTokens never exceeds maxTokens", () => {
    const files = Array.from({ length: 50 }, (_, i) => ({
      path: `src/module${i}.ts`,
      content: `export class LongClassNameForModule${i} {}\nexport interface LongInterfaceNameForModule${i} {}`,
    }));
    const map = buildRepoMap(files, { maxTokens: 500 });
    expect(map.estimatedTokens).toBeLessThanOrEqual(500);
  });

  it("increasing maxTokens monotonically increases or maintains symbolCount", () => {
    const files = Array.from({ length: 30 }, (_, i) => ({
      path: `src/s${i}.ts`,
      content: `export class S${i} {}`,
    }));
    const a = buildRepoMap(files, { maxTokens: 100 });
    const b = buildRepoMap(files, { maxTokens: 500 });
    const c = buildRepoMap(files, { maxTokens: 2000 });
    expect(a.symbolCount).toBeLessThanOrEqual(b.symbolCount);
    expect(b.symbolCount).toBeLessThanOrEqual(c.symbolCount);
  });
});

describe("buildRepoMap — exclude patterns", () => {
  it("excludes files matching test pattern", () => {
    const files = [
      { path: "src/app.ts", content: "export class App {}" },
      { path: "src/app.test.ts", content: "export function testApp() {}" },
    ];
    const map = buildRepoMap(files, { excludePatterns: [".test.ts"] });
    expect(map.content).toContain("App");
    expect(map.content).not.toContain("testApp");
  });

  it("excludes node_modules directory", () => {
    const files = [
      { path: "src/lib.ts", content: "export class Lib {}" },
      { path: "node_modules/dep/index.ts", content: "export class Dep {}" },
    ];
    const map = buildRepoMap(files, { excludePatterns: ["node_modules"] });
    expect(map.content).toContain("Lib");
    expect(map.content).not.toContain("Dep");
  });

  it("excludes dist directory", () => {
    const files = [
      { path: "src/main.ts", content: "export class Main {}" },
      { path: "dist/main.js", content: "export class Main {}" },
    ];
    const map = buildRepoMap(files, { excludePatterns: ["dist/"] });
    expect(map.fileCount).toBe(1);
  });

  it("no excludePatterns includes all files", () => {
    const files = [
      { path: "src/a.ts", content: "export class A {}" },
      { path: "src/b.test.ts", content: "export class B {}" },
    ];
    const map = buildRepoMap(files, { excludePatterns: [] });
    expect(map.fileCount).toBe(2);
  });

  it("exclude pattern matching a common prefix excludes all matching files", () => {
    const files = [
      { path: "src/generated/schema.ts", content: "export class Schema {}" },
      { path: "src/generated/types.ts", content: "export type T = string" },
      { path: "src/manual/handler.ts", content: "export class Handler {}" },
    ];
    const map = buildRepoMap(files, { excludePatterns: ["generated"] });
    expect(map.fileCount).toBe(1);
    expect(map.content).toContain("Handler");
    expect(map.content).not.toContain("Schema");
  });
});

describe("buildRepoMap — focus file scoring", () => {
  it("focus file symbols appear before non-focus in output", () => {
    const files = [
      { path: "src/peripheral.ts", content: "export class Peripheral {}" },
      { path: "src/focused.ts", content: "export class Focused {}" },
    ];
    const map = buildRepoMap(files, {
      focusFiles: ["src/focused.ts"],
      maxTokens: 100000,
    });
    const focusedIdx = map.content.indexOf("focused.ts");
    const peripheralIdx = map.content.indexOf("peripheral.ts");
    expect(focusedIdx).toBeLessThan(peripheralIdx);
  });

  it("focus file with no symbols still gets no section in output", () => {
    const files = [
      { path: "src/empty.ts", content: "" },
      { path: "src/real.ts", content: "export class Real {}" },
    ];
    const map = buildRepoMap(files, {
      focusFiles: ["src/empty.ts"],
      maxTokens: 100000,
    });
    expect(map.content).not.toContain("empty.ts");
    expect(map.content).toContain("Real");
  });

  it("focusing a non-existent file does not crash", () => {
    const files = [{ path: "src/a.ts", content: "export class A {}" }];
    expect(() =>
      buildRepoMap(files, { focusFiles: ["src/nonexistent.ts"] })
    ).not.toThrow();
  });
});

describe("buildRepoMap — symbol scoring and ranking", () => {
  it("exported class scores higher than unexported class", () => {
    const content = "class Hidden {}\nexport class Visible {}";
    const map = buildRepoMap([{ path: "src/m.ts", content }], {
      maxTokens: 100000,
    });
    const visibleIdx = map.content.indexOf("Visible");
    const hiddenIdx = map.content.indexOf("Hidden");
    expect(visibleIdx).not.toBe(-1);
    // Visible (class=3, exported=+3) outranks Hidden (class=3, no export)
    if (hiddenIdx !== -1) {
      expect(visibleIdx).toBeLessThan(hiddenIdx);
    }
  });

  it("class (weight 3) ranks above function (weight 2)", () => {
    const content = "export function fn() {}\nexport class Cls {}";
    const map = buildRepoMap([{ path: "src/m.ts", content }], {
      maxTokens: 100000,
    });
    // Both exported, but class has higher weight
    const clsIdx = map.content.indexOf("Cls");
    const fnIdx = map.content.indexOf("fn");
    expect(clsIdx).toBeLessThan(fnIdx);
  });

  it("function (weight 2) ranks above type (weight 1)", () => {
    const content = "export type T = string\nexport function fn() {}";
    const map = buildRepoMap([{ path: "src/m.ts", content }], {
      maxTokens: 100000,
    });
    const fnIdx = map.content.indexOf("fn");
    const typeIdx = map.content.indexOf("T");
    expect(fnIdx).toBeLessThan(typeIdx);
  });

  it("heavily referenced file symbols rank higher than isolated file", () => {
    const files = [
      { path: "src/shared.ts", content: "export class SharedCore {}" },
      {
        path: "src/a.ts",
        content: `import { SharedCore } from './shared'\nexport class A {}`,
      },
      {
        path: "src/b.ts",
        content: `import { SharedCore } from './shared'\nexport class B {}`,
      },
      {
        path: "src/c.ts",
        content: `import { SharedCore } from './shared'\nexport class C {}`,
      },
      { path: "src/isolated.ts", content: "export class Isolated {}" },
    ];
    const map = buildRepoMap(files, { maxTokens: 100000 });
    const sharedIdx = map.content.indexOf("SharedCore");
    const isolatedIdx = map.content.indexOf("Isolated");
    // SharedCore = class(3) + export(3) + 3 refs = 9; Isolated = 3+3+0 = 6
    expect(sharedIdx).toBeLessThan(isolatedIdx);
  });

  it("interface has same weight as class, both appear in output", () => {
    const files = [
      {
        path: "src/m.ts",
        content: "export interface IFoo {}\nexport class CFoo {}",
      },
    ];
    const map = buildRepoMap(files, { maxTokens: 100000 });
    expect(map.content).toContain("IFoo");
    expect(map.content).toContain("CFoo");
  });
});

describe("buildRepoMap — markdown output format", () => {
  it("file sections use ## heading followed by newline", () => {
    const map = buildRepoMap(
      [{ path: "src/x.ts", content: "export class X {}" }],
      { maxTokens: 100000 }
    );
    expect(map.content).toMatch(/^## src\/x\.ts$/m);
  });

  it('exported symbol lines start with "- export"', () => {
    const map = buildRepoMap(
      [{ path: "src/m.ts", content: "export class Pub {}" }],
      { maxTokens: 100000 }
    );
    expect(map.content).toMatch(/^- export class Pub$/m);
  });

  it('non-exported symbol lines do NOT start with "- export"', () => {
    const map = buildRepoMap([{ path: "src/m.ts", content: "class Priv {}" }], {
      maxTokens: 100000,
    });
    expect(map.content).toMatch(/^- class Priv$/m);
    expect(map.content).not.toMatch(/^- export class Priv/);
  });

  it("multiple files produce separate ## sections each", () => {
    const files = [
      { path: "src/one.ts", content: "export class One {}" },
      { path: "src/two.ts", content: "export class Two {}" },
      { path: "src/three.ts", content: "export class Three {}" },
    ];
    const map = buildRepoMap(files, { maxTokens: 100000 });
    const headings = [...map.content.matchAll(/^## /gm)];
    expect(headings.length).toBe(3);
  });
});

describe("buildRepoMap — determinism and stability", () => {
  it("identical inputs produce identical outputs on repeated calls", () => {
    const files = [
      {
        path: "src/x.ts",
        content: "export class X {}\nexport function f() {}",
      },
      { path: "src/y.ts", content: "export interface I {}" },
    ];
    const r1 = buildRepoMap(files);
    const r2 = buildRepoMap(files);
    const r3 = buildRepoMap(files);
    expect(r1.content).toBe(r2.content);
    expect(r2.content).toBe(r3.content);
    expect(r1.symbolCount).toBe(r2.symbolCount);
  });

  it("order of files in input does not affect output when same score", () => {
    const filesAB = [
      { path: "src/a.ts", content: "export class Alpha {}" },
      { path: "src/b.ts", content: "export class Beta {}" },
    ];
    const filesBA = [
      { path: "src/b.ts", content: "export class Beta {}" },
      { path: "src/a.ts", content: "export class Alpha {}" },
    ];
    const mapAB = buildRepoMap(filesAB, { maxTokens: 100000 });
    const mapBA = buildRepoMap(filesBA, { maxTokens: 100000 });
    // Both should include same content (order stable by filePath alphabetically)
    expect(mapAB.content).toBe(mapBA.content);
  });
});

describe("buildRepoMap — serialization and round-trip", () => {
  it("RepoMap can be JSON serialized and deserialized with fidelity", () => {
    const files = [
      {
        path: "src/m.ts",
        content: "export class M {}\nexport function f() {}",
      },
    ];
    const map = buildRepoMap(files, { maxTokens: 100000 });
    const serialized = JSON.stringify(map);
    const deserialized = JSON.parse(serialized) as RepoMap;
    expect(deserialized.content).toBe(map.content);
    expect(deserialized.symbolCount).toBe(map.symbolCount);
    expect(deserialized.fileCount).toBe(map.fileCount);
    expect(deserialized.estimatedTokens).toBe(map.estimatedTokens);
  });

  it("serialized RepoMap has all four expected keys", () => {
    const map = buildRepoMap([
      { path: "src/a.ts", content: "export class A {}" },
    ]);
    const keys = Object.keys(JSON.parse(JSON.stringify(map)));
    expect(keys).toContain("content");
    expect(keys).toContain("symbolCount");
    expect(keys).toContain("fileCount");
    expect(keys).toContain("estimatedTokens");
  });
});

describe("buildRepoMap — edge cases", () => {
  it("single file with single symbol produces minimal valid map", () => {
    const map = buildRepoMap(
      [{ path: "src/x.ts", content: "export class X {}" }],
      { maxTokens: 100000 }
    );
    expect(map.symbolCount).toBe(1);
    expect(map.fileCount).toBe(1);
    expect(map.content).toContain("X");
  });

  it("file with only type-only imports has no symbols", () => {
    const map = buildRepoMap([
      {
        path: "src/re.ts",
        content: `import type { A } from './a'\nimport type { B } from './b'`,
      },
    ]);
    expect(map.symbolCount).toBe(0);
    expect(map.fileCount).toBe(0);
  });

  it("handles file with no symbols gracefully (empty content for that file)", () => {
    const map = buildRepoMap([
      { path: "src/empty.ts", content: "" },
      { path: "src/real.ts", content: "export class Real {}" },
    ]);
    expect(map.fileCount).toBe(1);
    expect(map.content).not.toContain("empty.ts");
  });

  it("all-excluded results in empty map", () => {
    const files = [
      { path: "src/a.ts", content: "export class A {}" },
      { path: "src/b.ts", content: "export class B {}" },
    ];
    const map = buildRepoMap(files, { excludePatterns: ["src/"] });
    expect(map.symbolCount).toBe(0);
    expect(map.fileCount).toBe(0);
    expect(map.content).toBe("");
  });

  it("file with only blank lines and whitespace has no symbols", () => {
    const map = buildRepoMap([
      { path: "src/blank.ts", content: "   \n\n  \n" },
    ]);
    expect(map.symbolCount).toBe(0);
  });

  it("handles project with 200+ files without crashing", () => {
    const files = Array.from({ length: 200 }, (_, i) => ({
      path: `src/module${i}.ts`,
      content: `export class Module${i} {}\nexport function func${i}() {}`,
    }));
    expect(() => buildRepoMap(files, { maxTokens: 10000 })).not.toThrow();
    const map = buildRepoMap(files, { maxTokens: 10000 });
    expect(map.symbolCount).toBeGreaterThan(0);
  });
});

describe("buildRepoMap — config defaults and partial config", () => {
  it("no config uses defaults and produces valid output", () => {
    const map = buildRepoMap([
      { path: "src/a.ts", content: "export class A {}" },
    ]);
    expect(map.symbolCount).toBe(1);
    expect(map.estimatedTokens).toBeLessThanOrEqual(4000);
  });

  it("partial config with only maxTokens works", () => {
    const map = buildRepoMap(
      [{ path: "src/a.ts", content: "export class A {}" }],
      { maxTokens: 1000 }
    );
    expect(map.estimatedTokens).toBeLessThanOrEqual(1000);
  });

  it("partial config with only focusFiles works", () => {
    const files = [
      { path: "src/a.ts", content: "export class A {}" },
      { path: "src/b.ts", content: "export class B {}" },
    ];
    expect(() =>
      buildRepoMap(files, { focusFiles: ["src/a.ts"] })
    ).not.toThrow();
  });

  it("partial config with only excludePatterns works", () => {
    const files = [
      { path: "src/a.ts", content: "export class A {}" },
      { path: "src/b.ts", content: "export class B {}" },
    ];
    const map = buildRepoMap(files, { excludePatterns: ["src/b"] });
    expect(map.fileCount).toBe(1);
  });
});
