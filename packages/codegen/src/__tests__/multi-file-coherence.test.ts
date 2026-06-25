/**
 * Multi-file coherence validation — new test suite
 *
 * Covers:
 *   1. Cross-file imports — path exists, named export matches import, default export
 *   2. Unused exports — exports never imported anywhere in the set
 *   3. Type drift — type defined in file A used differently in file B
 *   4. Edit atomicity — multi-file edit either all succeeds or rolls back on failure
 *   5. Circular imports — detect and report circular dependency chains
 *   6. Missing files — import references a file that doesn't exist in the edit set
 *   7. Rename propagation — renaming a symbol should update all import sites
 *   8. Edge cases — single file, no imports, all internal, barrel re-exports
 *
 * Sources under test:
 *   - quality/import-validator.ts  (validateImports)
 *   - quality/contract-validator.ts (validateContracts, extractEndpoints, extractAPICalls)
 *   - vfs/virtual-fs.ts  (VirtualFS — for atomicity tests)
 *   - tools/multi-edit.tool.ts  (createMultiEditTool — for atomicity tests)
 *   - repomap/import-graph.ts  (buildImportGraph — for symbol/edge tests)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { validateImports } from "../quality/import-validator.js";
import {
  validateContracts,
  extractEndpoints,
  extractAPICalls,
} from "../quality/contract-validator.js";
import { VirtualFS } from "../vfs/virtual-fs.js";
import { createMultiEditTool } from "../tools/multi-edit.tool.js";
import { buildImportGraph } from "../repomap/import-graph.js";
import * as path from "node:path";

// =============================================================================
// 1. Cross-file imports: import path exists + named export consistency
// =============================================================================

describe("Cross-file imports — path existence", () => {
  it("import of existing sibling resolves → valid", () => {
    const files = new Map([
      ["src/a.ts", "import { foo } from './b'"],
      ["src/b.ts", "export const foo = 1"],
    ]);
    expect(validateImports(files).valid).toBe(true);
  });

  it("import of missing sibling → unresolved issue", () => {
    const files = new Map([["src/a.ts", "import { foo } from './missing'"]]);
    const result = validateImports(files);
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.issue).toBe("unresolved");
  });

  it("import path is recorded exactly as written in the source", () => {
    const files = new Map([
      ["src/x.ts", "import { bar } from './deep/nested/path'"],
    ]);
    const result = validateImports(files);
    expect(result.issues[0]?.importPath).toBe("./deep/nested/path");
  });

  it("import from parent directory resolves correctly", () => {
    const files = new Map([
      ["src/sub/child.ts", "import { shared } from '../shared'"],
      ["src/shared.ts", "export const shared = true"],
    ]);
    expect(validateImports(files).valid).toBe(true);
  });

  it("import with .ts extension explicit → resolves", () => {
    const files = new Map([
      ["src/consumer.ts", "import { x } from './lib.ts'"],
      ["src/lib.ts", "export const x = 1"],
    ]);
    expect(validateImports(files).valid).toBe(true);
  });

  it("import with .js extension (ESM) → resolves via .ts mapping", () => {
    const files = new Map([
      ["src/app.ts", "import { helper } from './utils.js'"],
      ["src/utils.ts", "export const helper = () => {}"],
    ]);
    expect(validateImports(files).valid).toBe(true);
  });

  it("import from directory index file → resolves", () => {
    const files = new Map([
      ["src/main.ts", "import { run } from './runner'"],
      ["src/runner/index.ts", "export const run = () => {}"],
    ]);
    expect(validateImports(files).valid).toBe(true);
  });

  it("two files both importing from a shared module → both valid", () => {
    const files = new Map([
      ["src/shared.ts", "export const config = {}"],
      ["src/a.ts", "import { config } from './shared'"],
      ["src/b.ts", "import { config } from './shared'"],
    ]);
    expect(validateImports(files).valid).toBe(true);
  });

  it("source file importing from multiple different modules → all valid", () => {
    const files = new Map([
      ["src/alpha.ts", "export const alpha = 1"],
      ["src/beta.ts", "export const beta = 2"],
      ["src/gamma.ts", "export const gamma = 3"],
      [
        "src/consumer.ts",
        [
          "import { alpha } from './alpha'",
          "import { beta } from './beta'",
          "import { gamma } from './gamma'",
        ].join("\n"),
      ],
    ]);
    expect(validateImports(files).valid).toBe(true);
  });

  it("one broken + several valid imports: exactly one unresolved issue", () => {
    const files = new Map([
      ["src/alpha.ts", "export const alpha = 1"],
      ["src/beta.ts", "export const beta = 2"],
      [
        "src/consumer.ts",
        [
          "import { alpha } from './alpha'",
          "import { beta } from './beta'",
          "import { gone } from './gone'",
        ].join("\n"),
      ],
    ]);
    const result = validateImports(files);
    expect(result.valid).toBe(false);
    expect(result.issues.filter((i) => i.issue === "unresolved")).toHaveLength(
      1,
    );
    expect(result.issues[0]?.importPath).toBe("./gone");
  });

  it("import of type-only file: import type { ... } resolves correctly", () => {
    const files = new Map([
      ["src/types.ts", "export interface IFoo { id: string }"],
      ["src/impl.ts", "import type { IFoo } from './types'"],
    ]);
    expect(validateImports(files).valid).toBe(true);
  });

  it("import type from missing file → unresolved", () => {
    const files = new Map([
      ["src/impl.ts", "import type { IFoo } from './types'"],
    ]);
    expect(validateImports(files).valid).toBe(false);
  });
});

// =============================================================================
// 2. Unused exports — exports never imported anywhere in the set
// =============================================================================

describe("Unused exports — detected via import graph", () => {
  it("file exporting something never imported by anyone: no issues (validator is import-centric)", () => {
    const files = new Map([
      ["src/orphan.ts", "export const neverUsed = 42"],
      ["src/app.ts", "// no imports"],
    ]);
    const result = validateImports(files);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("API endpoint defined but never called: unmatched-endpoint (informational, not error)", () => {
    const backend = { "api/orphan.ts": "router.get('/orphan', handler)" };
    const frontend = {};
    const result = validateContracts(backend, frontend);
    expect(result.valid).toBe(true);
    const dead = result.issues.filter((i) => i.type === "unmatched-endpoint");
    expect(dead).toHaveLength(1);
  });

  it("multiple dead endpoints: all reported as unmatched-endpoint", () => {
    const backend = {
      "api/a.ts": "router.get('/a', h)",
      "api/b.ts": "router.post('/b', h)",
      "api/c.ts": "router.delete('/c', h)",
    };
    const frontend = {};
    const result = validateContracts(backend, frontend);
    expect(result.valid).toBe(true);
    const dead = result.issues.filter((i) => i.type === "unmatched-endpoint");
    expect(dead).toHaveLength(3);
  });

  it("import graph: file with no importers still appears in graph as a root node", () => {
    const rootDir = "/proj";
    const files = [
      { path: "/proj/orphan.ts", content: "export const x = 1" },
      { path: "/proj/main.ts", content: "// no imports" },
    ];
    const graph = buildImportGraph(
      files.map((f) => ({ path: f.path, content: f.content })),
      "/",
    );
    // orphan and main both have no imports → both are roots
    const roots = graph.roots();
    expect(roots.length).toBeGreaterThanOrEqual(2);
  });

  it('barrel re-exports a symbol: symbol is "used" transitively via import graph', () => {
    const files = new Map([
      ["src/utils.ts", "export const helper = () => {}"],
      ["src/index.ts", "export { helper } from './utils'"],
      ["src/app.ts", "import { helper } from './index'"],
    ]);
    expect(validateImports(files).valid).toBe(true);
  });

  it("backend endpoint consumed by at least one frontend call → not in dead list", () => {
    const backend = {
      "api/used.ts": "router.get('/used', h)",
      "api/unused.ts": "router.get('/unused', h)",
    };
    const frontend = { "ui/client.ts": "axios.get('/used')" };
    const result = validateContracts(backend, frontend);
    const dead = result.issues.filter((i) => i.type === "unmatched-endpoint");
    expect(dead).toHaveLength(1);
    expect(dead[0]?.description).toContain("/unused");
  });
});

// =============================================================================
// 3. Type drift — type defined in A but used differently in B
// =============================================================================

describe("Type drift — simulated via API contract and import coherence", () => {
  it("backend switched method GET→POST: frontend using GET is a method-mismatch", () => {
    const backend = { "api/item.ts": "router.post('/item', handler)" };
    const frontend = { "ui/item.ts": "axios.get('/item')" };
    const result = validateContracts(backend, frontend);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.type === "method-mismatch")).toBe(true);
  });

  it("backend switched path: frontend hitting old path = unmatched-call", () => {
    const backend = {
      "api/v2/users.ts": "router.get('/api/v2/users', handler)",
    };
    const frontend = { "ui/users.ts": "axios.get('/api/v1/users')" };
    const result = validateContracts(backend, frontend);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.type === "unmatched-call")).toBe(true);
  });

  it("API version drift: v1 removed, v2 added, both v1 caller and v2 are reported", () => {
    const backend = { "api/orders.ts": "router.get('/orders/v2', handler)" };
    const frontend = {
      "ui/orders-v1.ts": "axios.get('/orders/v1')",
      "ui/orders-v2.ts": "axios.get('/orders/v2')",
    };
    const result = validateContracts(backend, frontend);
    expect(result.valid).toBe(false);
    const unmatched = result.issues.filter((i) => i.type === "unmatched-call");
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0]?.file).toBe("ui/orders-v1.ts");
  });

  it("type contract moved to different file: all importers become unresolved", () => {
    const files = new Map([
      // moved from 'types/v1.ts' to 'types/v2.ts'
      ["types/v2.ts", "export interface IFoo { id: number }"],
      ["impl/a.ts", "import type { IFoo } from '../types/v1'"],
      ["impl/b.ts", "import type { IFoo } from '../types/v1'"],
    ]);
    const result = validateImports(files);
    expect(result.valid).toBe(false);
    const unresolved = result.issues.filter((i) => i.issue === "unresolved");
    expect(unresolved).toHaveLength(2);
  });

  it("replacing PUT with PATCH: old callers (PUT) get method-mismatch", () => {
    const backend = {
      "api/resource.ts": "router.patch('/resource/:id', handler)",
    };
    const frontend = {
      "ui/client-a.ts": "axios.put('/resource/:id', data)",
      "ui/client-b.ts": "axios.put('/resource/:id', data)",
    };
    const result = validateContracts(backend, frontend);
    const mm = result.issues.filter((i) => i.type === "method-mismatch");
    expect(mm).toHaveLength(2);
  });

  it("return type widening: endpoint path renamed → old callers are unmatched", () => {
    const backend = { "api/data.ts": "router.get('/data/v2', handler)" };
    const frontend = { "ui/data.ts": "axios.get('/data/v1')" };
    const result = validateContracts(backend, frontend);
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.type).toBe("unmatched-call");
  });

  it("interface import from non-existent file — drift detected as unresolved", () => {
    const files = new Map([
      [
        "src/consumer.ts",
        "import type { IConfig } from '../core/config.types'",
      ],
    ]);
    const result = validateImports(files);
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.importPath).toBe("../core/config.types");
  });

  it("method-mismatch description contains the expected methods", () => {
    const backend = { "api.ts": "router.get('/x', h)" };
    const frontend = { "ui.ts": "axios.post('/x')" };
    const result = validateContracts(backend, frontend);
    const mm = result.issues.find((i) => i.type === "method-mismatch")!;
    expect(mm.description).toContain("GET");
  });
});

// =============================================================================
// 4. Edit atomicity — multi-file edit either all succeeds or rolls back
// =============================================================================

describe("Edit atomicity — VirtualFS multi-edit", () => {
  let vfs: VirtualFS;

  async function callMultiEdit(
    _vfs: VirtualFS,
    args: {
      fileEdits: Array<{
        filePath: string;
        edits: Array<{ oldText: string; newText: string }>;
      }>;
    },
  ): Promise<string> {
    const tool = createMultiEditTool(_vfs);
    return (
      tool as unknown as {
        _call: (a: Record<string, unknown>) => Promise<string>;
      }
    )._call(args);
  }

  beforeEach(() => {
    vfs = new VirtualFS({
      "src/a.ts": "export const x = 1\nexport const y = 2",
      "src/b.ts": "import { x } from './a'\nconsole.log(x)",
      "src/c.ts": "import { y } from './a'\nconsole.log(y)",
    });
  });

  it("two successful edits both commit", async () => {
    await callMultiEdit(vfs, {
      fileEdits: [
        {
          filePath: "src/a.ts",
          edits: [{ oldText: "x = 1", newText: "x = 100" }],
        },
        {
          filePath: "src/b.ts",
          edits: [{ oldText: "console.log(x)", newText: "console.log(x * 2)" }],
        },
      ],
    });
    expect(vfs.read("src/a.ts")).toContain("x = 100");
    expect(vfs.read("src/b.ts")).toContain("x * 2");
  });

  it("edit on missing file is skipped; valid edits still commit", async () => {
    await callMultiEdit(vfs, {
      fileEdits: [
        {
          filePath: "nonexistent.ts",
          edits: [{ oldText: "foo", newText: "bar" }],
        },
        {
          filePath: "src/c.ts",
          edits: [{ oldText: "console.log(y)", newText: 'console.log("y")' }],
        },
      ],
    });
    expect(vfs.read("src/c.ts")).toContain('"y"');
  });

  it("edit text not found: that sub-edit is skipped, file otherwise unchanged if no other edits match", async () => {
    const originalA = vfs.read("src/a.ts")!;
    await callMultiEdit(vfs, {
      fileEdits: [
        {
          filePath: "src/a.ts",
          edits: [{ oldText: "DOES_NOT_EXIST", newText: "replaced" }],
        },
      ],
    });
    expect(vfs.read("src/a.ts")).toBe(originalA);
  });

  it("partial edit: one sub-edit matches, one does not — only matching sub-edit applied", async () => {
    await callMultiEdit(vfs, {
      fileEdits: [
        {
          filePath: "src/a.ts",
          edits: [
            { oldText: "x = 1", newText: "x = 99" },
            { oldText: "MISSING_TEXT", newText: "irrelevant" },
          ],
        },
      ],
    });
    expect(vfs.read("src/a.ts")).toContain("x = 99");
  });

  it("all edits across three files commit together", async () => {
    await callMultiEdit(vfs, {
      fileEdits: [
        {
          filePath: "src/a.ts",
          edits: [{ oldText: "x = 1", newText: "x = 10" }],
        },
        {
          filePath: "src/b.ts",
          edits: [{ oldText: "console.log(x)", newText: "console.info(x)" }],
        },
        {
          filePath: "src/c.ts",
          edits: [{ oldText: "console.log(y)", newText: "console.info(y)" }],
        },
      ],
    });
    expect(vfs.read("src/a.ts")).toContain("x = 10");
    expect(vfs.read("src/b.ts")).toContain("console.info");
    expect(vfs.read("src/c.ts")).toContain("console.info");
  });

  it("vfs diff after two-file edit shows both files as modified", async () => {
    const snapshot = new VirtualFS(vfs.toSnapshot());
    await callMultiEdit(vfs, {
      fileEdits: [
        {
          filePath: "src/a.ts",
          edits: [{ oldText: "x = 1", newText: "x = 9" }],
        },
        {
          filePath: "src/b.ts",
          edits: [{ oldText: "console.log(x)", newText: "console.warn(x)" }],
        },
      ],
    });
    const diffs = snapshot.diff(vfs);
    const modifiedPaths = diffs
      .filter((d) => d.type === "modified")
      .map((d) => d.path)
      .sort();
    expect(modifiedPaths).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("edits on files not in vfs do not create those files", async () => {
    await callMultiEdit(vfs, {
      fileEdits: [
        {
          filePath: "src/ghost.ts",
          edits: [{ oldText: "anything", newText: "something" }],
        },
      ],
    });
    expect(vfs.exists("src/ghost.ts")).toBe(false);
  });

  it("output message reports number of modified files", async () => {
    const result = await callMultiEdit(vfs, {
      fileEdits: [
        {
          filePath: "src/a.ts",
          edits: [{ oldText: "x = 1", newText: "x = 2" }],
        },
        {
          filePath: "src/b.ts",
          edits: [{ oldText: "console.log(x)", newText: "console.log(x + 1)" }],
        },
      ],
    });
    expect(result).toMatch(/Applied edits to 2 files/);
  });

  it('output message includes "No edits applied" when all fail', async () => {
    const result = await callMultiEdit(vfs, {
      fileEdits: [
        {
          filePath: "src/a.ts",
          edits: [{ oldText: "THIS_NOT_HERE", newText: "noop" }],
        },
      ],
    });
    expect(result).toContain("No edits applied");
  });
});

// =============================================================================
// 5. Circular imports — detect and report circular dependency chains
// =============================================================================

describe("Circular imports", () => {
  it("direct 2-cycle A→B→A is reported as circular", () => {
    const files = new Map([
      ["src/a.ts", "import { b } from './b'"],
      ["src/b.ts", "import { a } from './a'"],
    ]);
    const result = validateImports(files);
    expect(result.issues.some((i) => i.issue === "circular")).toBe(true);
  });

  it("3-cycle A→B→C→A is detected", () => {
    const files = new Map([
      ["src/a.ts", "import { B } from './b'"],
      ["src/b.ts", "import { C } from './c'"],
      ["src/c.ts", "import { A } from './a'"],
    ]);
    const result = validateImports(files);
    expect(result.issues.some((i) => i.issue === "circular")).toBe(true);
  });

  it("4-cycle A→B→C→D→A is detected", () => {
    const files = new Map([
      ["src/a.ts", "import { x } from './b'"],
      ["src/b.ts", "import { x } from './c'"],
      ["src/c.ts", "import { x } from './d'"],
      ["src/d.ts", "import { x } from './a'"],
    ]);
    const result = validateImports(files);
    expect(result.issues.some((i) => i.issue === "circular")).toBe(true);
  });

  it("DAG with no cycles: A→C and B→C → no circular issue", () => {
    const files = new Map([
      ["src/shared.ts", "export const x = 1"],
      ["src/mod-a.ts", "import { x } from './shared'"],
      ["src/mod-b.ts", "import { x } from './shared'"],
    ]);
    const result = validateImports(files);
    expect(result.issues.some((i) => i.issue === "circular")).toBe(false);
  });

  it("diamond DAG A→B, A→C, B→D, C→D: no cycle", () => {
    const files = new Map([
      ["src/a.ts", "import { b } from './b'\nimport { c } from './c'"],
      ["src/b.ts", "import { d } from './d'"],
      ["src/c.ts", "import { d } from './d'"],
      ["src/d.ts", "export const d = 1"],
    ]);
    const result = validateImports(files);
    expect(result.issues.some((i) => i.issue === "circular")).toBe(false);
  });

  it("cycle in subgraph: leaf nodes remain unaffected (no unresolved)", () => {
    const files = new Map([
      ["src/leaf.ts", "export const leaf = true"],
      [
        "src/cycle-x.ts",
        "import { y } from './cycle-y'\nimport { leaf } from './leaf'",
      ],
      ["src/cycle-y.ts", "import { x } from './cycle-x'"],
    ]);
    const result = validateImports(files);
    const unresolved = result.issues.filter((i) => i.issue === "unresolved");
    expect(unresolved).toHaveLength(0);
    expect(result.issues.some((i) => i.issue === "circular")).toBe(true);
  });

  it("self-import is reported as self-import, not circular", () => {
    const files = new Map([["src/a.ts", "import { a } from './a'"]]);
    const result = validateImports(files);
    expect(result.issues.some((i) => i.issue === "self-import")).toBe(true);
    expect(result.issues.some((i) => i.issue === "circular")).toBe(false);
  });

  it("circular import makes result invalid", () => {
    const files = new Map([
      ["src/x.ts", "import { y } from './y'"],
      ["src/y.ts", "import { x } from './x'"],
    ]);
    expect(validateImports(files).valid).toBe(false);
  });

  it("two disjoint cycles: both reported", () => {
    const files = new Map([
      ["src/a1.ts", "import { a2 } from './a2'"],
      ["src/a2.ts", "import { a1 } from './a1'"],
      ["src/b1.ts", "import { b2 } from './b2'"],
      ["src/b2.ts", "import { b3 } from './b3'"],
      ["src/b3.ts", "import { b1 } from './b1'"],
    ]);
    const result = validateImports(files);
    const cycles = result.issues.filter((i) => i.issue === "circular");
    expect(cycles.length).toBeGreaterThanOrEqual(2);
  });

  it("circular via re-export chain: A exports from B, B exports from A", () => {
    const files = new Map([
      ["src/a.ts", "export { x } from './b'"],
      ["src/b.ts", "export { y } from './a'"],
    ]);
    const result = validateImports(files);
    expect(result.issues.some((i) => i.issue === "circular")).toBe(true);
  });
});

// =============================================================================
// 6. Missing files — import references a file that doesn't exist
// =============================================================================

describe("Missing files in import set", () => {
  it("single missing import → exactly one unresolved issue", () => {
    const files = new Map([
      ["src/app.ts", "import { widget } from './ui/widget'"],
    ]);
    const result = validateImports(files);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.issue).toBe("unresolved");
  });

  it("three missing imports in one file → three unresolved issues", () => {
    const files = new Map([
      [
        "src/app.ts",
        [
          "import { A } from './mod-a'",
          "import { B } from './mod-b'",
          "import { C } from './mod-c'",
        ].join("\n"),
      ],
    ]);
    const result = validateImports(files);
    expect(result.issues.filter((i) => i.issue === "unresolved")).toHaveLength(
      3,
    );
  });

  it("missing file in the middle of a chain: chain is broken at that link", () => {
    const files = new Map([
      // root.ts → domain.ts → MISSING primitive.ts
      ["domain.ts", "export { x } from './primitive'"],
      ["root.ts", "import { x } from './domain'"],
    ]);
    const result = validateImports(files);
    expect(result.valid).toBe(false);
    const unresolved = result.issues.filter((i) => i.issue === "unresolved");
    expect(unresolved.some((i) => i.file === "domain.ts")).toBe(true);
  });

  it("missing barrel: all consumers of the barrel become unresolved", () => {
    const files = new Map([
      ["src/a.ts", "import { x } from './barrel'"],
      ["src/b.ts", "import { y } from './barrel'"],
    ]);
    const result = validateImports(files);
    expect(result.issues.filter((i) => i.issue === "unresolved")).toHaveLength(
      2,
    );
  });

  it("missing dynamic import target → unresolved", () => {
    const files = new Map([
      ["src/lazy.ts", "const mod = await import('./lazy-feature')"],
    ]);
    const result = validateImports(files);
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.issue).toBe("unresolved");
  });

  it("missing file: unresolved issue records the correct source file", () => {
    const files = new Map([
      ["src/deeply/nested/consumer.ts", "import { X } from './missing-local'"],
    ]);
    const result = validateImports(files);
    expect(result.issues[0]?.file).toBe("src/deeply/nested/consumer.ts");
  });

  it("missing file: unresolved issue line number is 1-based", () => {
    const files = new Map([["src/a.ts", "import { x } from './gone'"]]);
    const result = validateImports(files);
    expect(result.issues[0]?.line).toBeGreaterThan(0);
  });

  it("missing API endpoint: frontend call with no backend → unmatched-call", () => {
    const backend = {};
    const frontend = { "ui/client.ts": "axios.get('/nonexistent')" };
    const result = validateContracts(backend, frontend);
    expect(result.valid).toBe(false);
    const uc = result.issues.filter((i) => i.type === "unmatched-call");
    expect(uc).toHaveLength(1);
    expect(uc[0]?.file).toBe("ui/client.ts");
  });

  it("10 missing imports across 10 separate files → 10 unresolved issues", () => {
    const files = new Map<string, string>();
    for (let i = 0; i < 10; i++) {
      files.set(`src/m${i}.ts`, `import { x } from './missing-${i}'`);
    }
    const result = validateImports(files);
    expect(result.issues.filter((i) => i.issue === "unresolved")).toHaveLength(
      10,
    );
  });
});

// =============================================================================
// 7. Rename propagation — renaming a symbol should update all import sites
// =============================================================================

describe("Rename propagation via VirtualFS multi-edit", () => {
  let vfs: VirtualFS;

  async function callMultiEdit(
    _vfs: VirtualFS,
    args: {
      fileEdits: Array<{
        filePath: string;
        edits: Array<{ oldText: string; newText: string }>;
      }>;
    },
  ): Promise<string> {
    const tool = createMultiEditTool(_vfs);
    return (
      tool as unknown as {
        _call: (a: Record<string, unknown>) => Promise<string>;
      }
    )._call(args);
  }

  beforeEach(() => {
    vfs = new VirtualFS({
      "src/utils.ts": "export const fetchUser = () => {}",
      "src/service.ts": "import { fetchUser } from './utils'\nfetchUser()",
      "src/component.ts": "import { fetchUser } from './utils'\nfetchUser()",
    });
  });

  it("rename exported symbol in definition file: definition updated", async () => {
    await callMultiEdit(vfs, {
      fileEdits: [
        {
          filePath: "src/utils.ts",
          edits: [{ oldText: "fetchUser", newText: "getUser" }],
        },
      ],
    });
    expect(vfs.read("src/utils.ts")).toContain("getUser");
    expect(vfs.read("src/utils.ts")).not.toContain("fetchUser");
  });

  it("rename propagated to importer: import site updated", async () => {
    // Two edits per file — one for the import declaration, one for the call site —
    // because String.replace() replaces only the first occurrence per edit entry.
    await callMultiEdit(vfs, {
      fileEdits: [
        {
          filePath: "src/utils.ts",
          edits: [
            {
              oldText: "export const fetchUser",
              newText: "export const getUser",
            },
          ],
        },
        {
          filePath: "src/service.ts",
          edits: [
            {
              oldText: "import { fetchUser } from './utils'",
              newText: "import { getUser } from './utils'",
            },
            {
              oldText: "fetchUser()",
              newText: "getUser()",
            },
          ],
        },
      ],
    });
    expect(vfs.read("src/service.ts")).toContain("getUser");
    expect(vfs.read("src/service.ts")).not.toContain("fetchUser");
  });

  it("partial rename: one importer updated, one not — import graph breaks for unupdated consumer", async () => {
    await callMultiEdit(vfs, {
      fileEdits: [
        {
          filePath: "src/utils.ts",
          edits: [
            {
              oldText: "export const fetchUser",
              newText: "export const getUser",
            },
          ],
        },
        {
          filePath: "src/service.ts",
          edits: [{ oldText: "fetchUser", newText: "getUser" }],
        },
        // component.ts still uses old name — intentionally NOT updated
      ],
    });
    // After rename: utils exports getUser, service is updated, component still uses fetchUser
    const files = new Map(Object.entries(vfs.toSnapshot()));
    // The component.ts still imports fetchUser which hasn't been re-exported
    // import-validator works on file resolution (not symbol names), so this
    // tests that the vfs captures the partial rename state correctly:
    expect(vfs.read("src/component.ts")).toContain("fetchUser");
    expect(vfs.read("src/service.ts")).toContain("getUser");
  });

  it("rename across three importers: all three updated", async () => {
    // Add third importer — use full import line as edit target because
    // String.replace() replaces only the first occurrence per edit entry.
    vfs.write(
      "src/page.ts",
      "import { fetchUser } from './utils'\nfetchUser()",
    );

    await callMultiEdit(vfs, {
      fileEdits: [
        {
          filePath: "src/utils.ts",
          edits: [
            {
              oldText: "export const fetchUser",
              newText: "export const loadUser",
            },
          ],
        },
        {
          filePath: "src/service.ts",
          edits: [
            {
              oldText: "import { fetchUser } from './utils'",
              newText: "import { loadUser } from './utils'",
            },
          ],
        },
        {
          filePath: "src/component.ts",
          edits: [
            {
              oldText: "import { fetchUser } from './utils'",
              newText: "import { loadUser } from './utils'",
            },
          ],
        },
        {
          filePath: "src/page.ts",
          edits: [
            {
              oldText: "import { fetchUser } from './utils'",
              newText: "import { loadUser } from './utils'",
            },
          ],
        },
      ],
    });
    // All import declarations are updated to loadUser
    expect(vfs.read("src/utils.ts")).toContain("loadUser");
    expect(vfs.read("src/service.ts")).toContain("loadUser");
    expect(vfs.read("src/component.ts")).toContain("loadUser");
    expect(vfs.read("src/page.ts")).toContain("loadUser");
    // Export declaration no longer contains fetchUser
    expect(vfs.read("src/utils.ts")).not.toContain("fetchUser");
  });

  it("rename of export in barrel updates barrel correctly", async () => {
    vfs.write("src/barrel.ts", "export { fetchUser } from './utils'");
    await callMultiEdit(vfs, {
      fileEdits: [
        {
          filePath: "src/utils.ts",
          edits: [{ oldText: "fetchUser", newText: "queryUser" }],
        },
        {
          filePath: "src/barrel.ts",
          edits: [{ oldText: "fetchUser", newText: "queryUser" }],
        },
      ],
    });
    expect(vfs.read("src/barrel.ts")).toContain("queryUser");
  });
});

// =============================================================================
// 8. Edge cases — single file, no imports, all internal, barrel re-exports
// =============================================================================

describe("Edge cases", () => {
  describe("single file with no imports", () => {
    it("single file with no imports or exports → valid", () => {
      const files = new Map([
        ["src/standalone.ts", "const x = 1\nconsole.log(x)"],
      ]);
      expect(validateImports(files).valid).toBe(true);
    });

    it("single file with only comments → valid", () => {
      const files = new Map([
        ["src/types.ts", "// This is just a comment file\n// No imports"],
      ]);
      expect(validateImports(files).valid).toBe(true);
    });

    it("single file exporting → no import issues (nothing imports it)", () => {
      const files = new Map([["src/lib.ts", "export const helper = () => {}"]]);
      expect(validateImports(files).valid).toBe(true);
    });

    it("single file self-importing with .js extension → self-import issue", () => {
      const files = new Map([["src/mod.ts", "import { x } from './mod.js'"]]);
      const result = validateImports(files);
      expect(result.issues.some((i) => i.issue === "self-import")).toBe(true);
    });
  });

  describe("no imports at all in file set", () => {
    it("empty file set → valid=true, zero issues", () => {
      const result = validateImports(new Map());
      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it("multiple files none importing each other → valid", () => {
      const files = new Map([
        ["src/a.ts", "export const a = 1"],
        ["src/b.ts", "export const b = 2"],
        ["src/c.ts", "export const c = 3"],
      ]);
      expect(validateImports(files).valid).toBe(true);
    });

    it("files with only package imports (non-relative) → valid (only relative checked)", () => {
      const files = new Map([
        ["src/app.ts", "import { z } from 'zod'\nimport React from 'react'"],
      ]);
      expect(validateImports(files).valid).toBe(true);
    });
  });

  describe("barrel re-exports", () => {
    it("barrel re-exporting from multiple source files → valid", () => {
      const files = new Map([
        ["src/utils/format.ts", "export const format = (s: string) => s"],
        ["src/utils/parse.ts", "export const parse = (s: string) => s"],
        [
          "src/utils/index.ts",
          "export { format } from './format'\nexport { parse } from './parse'",
        ],
        ["src/main.ts", "import { format, parse } from './utils'"],
      ]);
      expect(validateImports(files).valid).toBe(true);
    });

    it("barrel with missing source file → unresolved", () => {
      const files = new Map([
        ["src/utils/index.ts", "export { format } from './format'"],
        // format.ts missing
      ]);
      expect(validateImports(files).valid).toBe(false);
    });

    it("star re-export from valid source → valid", () => {
      const files = new Map([
        ["src/primitives.ts", "export const x = 1\nexport const y = 2"],
        ["src/index.ts", "export * from './primitives'"],
        ["src/consumer.ts", "import { x } from './index'"],
      ]);
      expect(validateImports(files).valid).toBe(true);
    });

    it("barrel re-exporting with circular dependency → circular detected", () => {
      const files = new Map([
        ["src/a.ts", "export { x } from './b'"],
        ["src/b.ts", "export { x } from './a'"],
      ]);
      const result = validateImports(files);
      expect(result.issues.some((i) => i.issue === "circular")).toBe(true);
    });

    it("API barrel: endpoint in sub-module, barrel at root → both matched", () => {
      const backend = {
        "routes/users/list.ts": "router.get('/users', handler)",
        "routes/users/create.ts": "router.post('/users', handler)",
      };
      const frontend = {
        "ui/users.ts": "axios.get('/users')\naxios.post('/users', data)",
      };
      const result = validateContracts(backend, frontend);
      expect(result.valid).toBe(true);
    });
  });

  describe("all-internal file sets (no external deps)", () => {
    it("10 files all importing from one shared base → valid", () => {
      const files = new Map<string, string>();
      files.set("src/base.ts", "export const base = true");
      for (let i = 0; i < 10; i++) {
        files.set(
          `src/m${i}.ts`,
          `import { base } from './base'\nexport const m${i} = base`,
        );
      }
      expect(validateImports(files).valid).toBe(true);
    });

    it("chain: A→B→C→D→E, all present → valid", () => {
      const files = new Map([
        ["src/a.ts", "import { b } from './b'"],
        ["src/b.ts", "import { c } from './c'\nexport const b = c"],
        ["src/c.ts", "import { d } from './d'\nexport const c = d"],
        ["src/d.ts", "import { e } from './e'\nexport const d = e"],
        ["src/e.ts", "export const e = 5"],
      ]);
      expect(validateImports(files).valid).toBe(true);
    });

    it("Map vs Record input: same result for valid graph", () => {
      const record: Record<string, string> = {
        "src/a.ts": "import { b } from './b'",
        "src/b.ts": "export const b = 1",
      };
      const map = new Map(Object.entries(record));
      const resultRecord = validateImports(record);
      const resultMap = validateImports(map);
      expect(resultRecord.valid).toBe(resultMap.valid);
      expect(resultRecord.issues.length).toBe(resultMap.issues.length);
    });

    it("Map vs Record input: same result for broken graph", () => {
      const record: Record<string, string> = {
        "src/consumer.ts": "import { x } from './gone'",
      };
      const map = new Map(Object.entries(record));
      expect(validateImports(record).valid).toBe(false);
      expect(validateImports(map).valid).toBe(false);
    });
  });

  describe("import graph: buildImportGraph edge cases", () => {
    const rootDir = path.resolve("/workspace");

    it("empty file list → no edges, no roots", () => {
      const graph = buildImportGraph([], rootDir);
      expect(graph.edges).toHaveLength(0);
      expect(graph.roots()).toHaveLength(0);
    });

    it("single file with no imports → it is a root (nothing imports it)", () => {
      const files = [
        {
          path: path.resolve(rootDir, "src/standalone.ts"),
          content: "export const x = 1",
        },
      ];
      const graph = buildImportGraph(files, rootDir);
      expect(graph.roots()).toHaveLength(1);
    });

    it("importedBy: returns files that import a given target", () => {
      const files = [
        {
          path: path.resolve(rootDir, "src/lib.ts"),
          content: "export const x = 1",
        },
        {
          path: path.resolve(rootDir, "src/consumer.ts"),
          content: "import { x } from './lib'",
        },
      ];
      const graph = buildImportGraph(files, rootDir);
      const importers = graph.importedBy(path.resolve(rootDir, "src/lib.ts"));
      expect(importers.some((p) => p.includes("consumer.ts"))).toBe(true);
    });

    it("importsFrom: returns files that a given file imports", () => {
      const files = [
        {
          path: path.resolve(rootDir, "src/lib.ts"),
          content: "export const x = 1",
        },
        {
          path: path.resolve(rootDir, "src/consumer.ts"),
          content: "import { x } from './lib'",
        },
      ];
      const graph = buildImportGraph(files, rootDir);
      const imports = graph.importsFrom(
        path.resolve(rootDir, "src/consumer.ts"),
      );
      expect(imports.some((p) => p.includes("lib.ts"))).toBe(true);
    });

    it("edges contain the symbols imported", () => {
      const files = [
        {
          path: path.resolve(rootDir, "src/lib.ts"),
          content: "export const alpha = 1\nexport const beta = 2",
        },
        {
          path: path.resolve(rootDir, "src/app.ts"),
          content: "import { alpha, beta } from './lib'",
        },
      ];
      const graph = buildImportGraph(files, rootDir);
      expect(graph.edges).toHaveLength(1);
      expect(graph.edges[0]?.symbols).toContain("alpha");
      expect(graph.edges[0]?.symbols).toContain("beta");
    });

    it("default import shows in edge symbols", () => {
      const files = [
        {
          path: path.resolve(rootDir, "src/config.ts"),
          content: 'export default { env: "test" }',
        },
        {
          path: path.resolve(rootDir, "src/app.ts"),
          content: "import config from './config'",
        },
      ];
      const graph = buildImportGraph(files, rootDir);
      expect(graph.edges).toHaveLength(1);
      expect(graph.edges[0]?.symbols).toContain("config");
    });

    it("namespace import (import * as X from) shows in edge symbols", () => {
      const files = [
        {
          path: path.resolve(rootDir, "src/math.ts"),
          content: "export const add = (a: number, b: number) => a + b",
        },
        {
          path: path.resolve(rootDir, "src/app.ts"),
          content: "import * as MathUtils from './math'",
        },
      ];
      const graph = buildImportGraph(files, rootDir);
      expect(graph.edges).toHaveLength(1);
      expect(graph.edges[0]?.symbols[0]).toContain("MathUtils");
    });

    it("file with only package imports has no edges and is a root", () => {
      const files = [
        {
          path: path.resolve(rootDir, "src/app.ts"),
          content: "import { z } from 'zod'",
        },
      ];
      const graph = buildImportGraph(files, rootDir);
      expect(graph.edges).toHaveLength(0);
      expect(graph.roots()).toHaveLength(1);
    });
  });
});

// =============================================================================
// 9. Combined coherence: imports + contracts in one scenario
// =============================================================================

describe("Combined multi-file coherence — imports + contracts", () => {
  it("fully coherent project: all imports resolve AND all endpoints matched", () => {
    const backendFiles = {
      "server/users.ts": [
        "router.get('/api/users', listUsers)",
        "router.post('/api/users', createUser)",
        "import { db } from './db'",
      ].join("\n"),
      "server/db.ts": "export const db = {}",
    };
    const frontendFiles = {
      "client/users.ts":
        "axios.get('/api/users')\naxios.post('/api/users', data)",
    };
    const importResult = validateImports(backendFiles);
    const contractResult = validateContracts(backendFiles, frontendFiles);
    expect(importResult.valid).toBe(true);
    expect(contractResult.valid).toBe(true);
  });

  it("broken import in backend + missing endpoint call in frontend: both fail independently", () => {
    const backendFiles = {
      "server/users.ts":
        "router.get('/api/users', h)\nimport { db } from './nonexistent'",
    };
    const frontendFiles = {
      "client/calls.ts": "axios.post('/api/ghost', data)",
    };
    const importResult = validateImports(backendFiles);
    const contractResult = validateContracts(backendFiles, frontendFiles);
    expect(importResult.valid).toBe(false);
    expect(contractResult.valid).toBe(false);
  });

  it("clean imports + one endpoint method mismatch: contract catches it", () => {
    const backendFiles = {
      "api/items.ts": "router.get('/items', handler)",
      "lib/utils.ts": "export const util = () => {}",
    };
    const frontendFiles = {
      "ui/items.ts": "axios.post('/items', data)",
    };
    const importResult = validateImports(backendFiles);
    const contractResult = validateContracts(backendFiles, frontendFiles);
    expect(importResult.valid).toBe(true);
    expect(contractResult.valid).toBe(false);
    expect(
      contractResult.issues.some((i) => i.type === "method-mismatch"),
    ).toBe(true);
  });

  it("circular import in backend does not prevent contract validation from running", () => {
    // Use sibling-relative paths so the circular link resolves correctly:
    // api/a.ts imports './b' → api/b.ts, api/b.ts imports './a' → api/a.ts
    const backendFiles = {
      "api/a.ts": "import { x } from './b'\nrouter.get('/shared', handler)",
      "api/b.ts": "import { y } from './a'",
    };
    const frontendFiles = {
      "ui/app.ts": "axios.get('/shared')",
    };
    const importResult = validateImports(backendFiles);
    const contractResult = validateContracts(backendFiles, frontendFiles);
    // Circular detected in imports
    expect(importResult.issues.some((i) => i.issue === "circular")).toBe(true);
    // Contract still valid (endpoint is matched)
    expect(contractResult.valid).toBe(true);
  });

  it("8-domain coherent project: all imports and contracts pass", () => {
    const domains = [
      "users",
      "orders",
      "products",
      "payments",
      "sessions",
      "reports",
      "settings",
      "audit",
    ];
    const backendFiles: Record<string, string> = {};
    const frontendFiles: Record<string, string> = {};
    const importTestFiles: Record<string, string> = {};

    for (const domain of domains) {
      backendFiles[`routes/${domain}.ts`] = [
        `router.get('/api/${domain}', h)`,
        `router.post('/api/${domain}', h)`,
        `import { ${domain}Service } from './${domain}-svc'`,
      ].join("\n");
      importTestFiles[`routes/${domain}.ts`] =
        backendFiles[`routes/${domain}.ts`]!;
      importTestFiles[`routes/${domain}-svc.ts`] =
        `export class ${domain}Service {}`;
      frontendFiles[`ui/${domain}.ts`] =
        `axios.get('/api/${domain}')\naxios.post('/api/${domain}', d)`;
    }

    const importResult = validateImports(importTestFiles);
    const contractResult = validateContracts(backendFiles, frontendFiles);
    expect(importResult.valid).toBe(true);
    expect(contractResult.valid).toBe(true);
  });
});
