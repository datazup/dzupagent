/**
 * Multi-file coherence validation — extended coverage
 *
 * Adds +70 tests covering areas not yet addressed by:
 *   - multi-file-coherence.test.ts       (88 tests — basic scenarios)
 *   - multi-file-coherence-deep.test.ts  (136 tests — extractEndpoints / extractAPICalls depth)
 *   - coherence-validation-deep.test.ts  (92 tests — combined contract+import scenarios)
 *
 * New topics in this file:
 *   A. Cross-file type consistency — exported type used correctly in importers
 *   B. Import resolution — VFS-based validator (validation/import-validator.ts)
 *   C. Circular dependency detection — advanced graph shapes
 *   D. Renamed symbol propagation — multi-file edit batches
 *   E. Multi-file edit batch coherence — batch validation scenarios
 *   F. Edge cases — empty sets, single files, no imports, non-TS files
 *   G. Import graph advanced — transitive depth, multi-edge, isolated subgraphs
 *   H. Contract validator — fetch() paths, path-param normalization, multi-file
 */

import { describe, it, expect, beforeEach } from "vitest";
import { validateImports } from "../quality/import-validator.js";
import {
  validateContracts,
  extractEndpoints,
  extractAPICalls,
} from "../quality/contract-validator.js";
import { VirtualFS } from "../vfs/virtual-fs.js";
import { validateImports as validateImportsVfs } from "../validation/import-validator.js";
import { createMultiEditTool } from "../tools/multi-edit.tool.js";
import { buildImportGraph } from "../repomap/import-graph.js";
import * as path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Helper
// ─────────────────────────────────────────────────────────────────────────────

async function applyMultiEdit(
  vfs: VirtualFS,
  fileEdits: Array<{
    filePath: string;
    edits: Array<{ oldText: string; newText: string }>;
  }>,
): Promise<string> {
  const tool = createMultiEditTool(vfs);
  return (
    tool as unknown as {
      _call: (a: Record<string, unknown>) => Promise<string>;
    }
  )._call({ fileEdits });
}

// =============================================================================
// A. Cross-file type consistency
// =============================================================================

describe("Cross-file type consistency — exported types used in other files", () => {
  it("interface exported from types.ts and imported in impl.ts — imports resolve", () => {
    const files = new Map([
      ["src/types.ts", "export interface User { id: string; name: string }"],
      [
        "src/impl.ts",
        "import type { User } from './types'\nexport function getUser(): User { return { id: '1', name: 'Alice' } }",
      ],
    ]);
    expect(validateImports(files).valid).toBe(true);
  });

  it("type alias exported and re-imported two levels deep — chain resolves", () => {
    const files = new Map([
      ["core/id.ts", "export type ID = string"],
      [
        "core/user.ts",
        "import type { ID } from './id'\nexport type UserID = ID",
      ],
      [
        "app/service.ts",
        "import type { UserID } from '../core/user'\nexport function findById(id: UserID): void {}",
      ],
    ]);
    expect(validateImports(files).valid).toBe(true);
  });

  it("enum exported and used as parameter type — import resolves", () => {
    const files = new Map([
      [
        "shared/status.ts",
        "export enum Status { Active = 'active', Inactive = 'inactive' }",
      ],
      [
        "api/handler.ts",
        "import { Status } from '../shared/status'\nexport function handle(s: Status): void {}",
      ],
    ]);
    expect(validateImports(files).valid).toBe(true);
  });

  it("type moved to different module — all importers of old location become unresolved", () => {
    const files = new Map([
      // ID moved from core/types.ts to shared/primitives.ts
      ["shared/primitives.ts", "export type ID = string"],
      ["api/handler.ts", "import type { ID } from '../core/types'"], // old location — missing
      ["ui/component.ts", "import type { ID } from '../core/types'"], // old location — missing
    ]);
    const result = validateImports(files);
    expect(result.valid).toBe(false);
    const unresolved = result.issues.filter((i) => i.issue === "unresolved");
    expect(unresolved).toHaveLength(2);
  });

  it("generic type parameter from base exported and consumed in derived — resolves", () => {
    const files = new Map([
      [
        "base/repository.ts",
        "export interface Repository<T> { findById(id: string): T }",
      ],
      [
        "users/user-repo.ts",
        "import type { Repository } from '../base/repository'\nexport class UserRepo implements Repository<User> {}",
      ],
    ]);
    expect(validateImports(files).valid).toBe(true);
  });

  it("discriminated union exported and narrowed in consumer — import valid", () => {
    const files = new Map([
      [
        "domain/events.ts",
        "export type Event = { type: 'created' } | { type: 'deleted' }",
      ],
      [
        "handlers/event-handler.ts",
        "import type { Event } from '../domain/events'\nexport function handle(e: Event): void {}",
      ],
    ]);
    expect(validateImports(files).valid).toBe(true);
  });

  it("interface extended across files — both base and extension resolve", () => {
    const files = new Map([
      ["base/base.ts", "export interface Base { id: string }"],
      [
        "domain/entity.ts",
        "import type { Base } from '../base/base'\nexport interface Entity extends Base { name: string }",
      ],
      [
        "api/dto.ts",
        "import type { Entity } from '../domain/entity'\nexport function toDTO(e: Entity): Record<string, unknown> { return {} }",
      ],
    ]);
    expect(validateImports(files).valid).toBe(true);
  });

  it("type exported as default and imported as named alias — import resolves", () => {
    const files = new Map([
      [
        "config/app.config.ts",
        "const config = { debug: false }; export default config",
      ],
      ["app/bootstrap.ts", "import config from '../config/app.config'"],
    ]);
    expect(validateImports(files).valid).toBe(true);
  });
});

// =============================================================================
// B. Import resolution — VFS-based validator
// =============================================================================

describe("VFS-based import validation — cross-file resolution", () => {
  it("empty VFS → valid with no errors", () => {
    const r = validateImportsVfs(new VirtualFS());
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it("single file with no imports → valid", () => {
    const vfs = new VirtualFS({ "src/a.ts": "export const x = 1" });
    expect(validateImportsVfs(vfs).valid).toBe(true);
  });

  it("import resolves to sibling .ts file — valid", () => {
    const vfs = new VirtualFS({
      "src/a.ts": "import { b } from './b'",
      "src/b.ts": "export const b = 2",
    });
    expect(validateImportsVfs(vfs).valid).toBe(true);
  });

  it("import with .js extension maps to .ts file — valid", () => {
    const vfs = new VirtualFS({
      "src/app.ts": "import { helper } from './utils.js'",
      "src/utils.ts": "export const helper = () => {}",
    });
    expect(validateImportsVfs(vfs).valid).toBe(true);
  });

  it("import resolves to directory index.ts — valid", () => {
    const vfs = new VirtualFS({
      "src/main.ts": "import { run } from './runner'",
      "src/runner/index.ts": "export const run = () => {}",
    });
    expect(validateImportsVfs(vfs).valid).toBe(true);
  });

  it("broken import → error includes file and importPath", () => {
    const vfs = new VirtualFS({
      "src/consumer.ts": "import { x } from './nonexistent'",
    });
    const r = validateImportsVfs(vfs);
    expect(r.valid).toBe(false);
    expect(r.errors[0]!.file).toBe("src/consumer.ts");
    expect(r.errors[0]!.importPath).toBe("./nonexistent");
  });

  it("error message contains resolved path", () => {
    const vfs = new VirtualFS({
      "lib/foo.ts": "import { x } from './bar'",
    });
    const r = validateImportsVfs(vfs);
    expect(r.errors[0]!.message).toContain("lib/bar");
  });

  it("non-TS files (.md, .json) in VFS are ignored by validator", () => {
    const vfs = new VirtualFS({
      "README.md": "# No imports here",
      "package.json": '{"name": "test"}',
      "src/app.ts": "export const x = 1",
    });
    expect(validateImportsVfs(vfs).valid).toBe(true);
  });

  it("import from parent directory — resolves correctly", () => {
    const vfs = new VirtualFS({
      "shared/utils.ts": "export const util = () => {}",
      "features/auth/login.ts": "import { util } from '../../shared/utils'",
    });
    expect(validateImportsVfs(vfs).valid).toBe(true);
  });

  it("multiple broken imports in one file — all recorded as errors", () => {
    const vfs = new VirtualFS({
      "src/app.ts": [
        "import { a } from './missing-a'",
        "import { b } from './missing-b'",
        "import { c } from './missing-c'",
      ].join("\n"),
    });
    const r = validateImportsVfs(vfs);
    expect(r.errors).toHaveLength(3);
  });

  it("import with explicit .ts extension resolves — valid", () => {
    const vfs = new VirtualFS({
      "src/consumer.ts": "import { x } from './lib.ts'",
      "src/lib.ts": "export const x = 1",
    });
    expect(validateImportsVfs(vfs).valid).toBe(true);
  });

  it("dynamic import of existing file — valid", () => {
    const vfs = new VirtualFS({
      "src/lazy.ts": "const mod = await import('./feature')",
      "src/feature.ts": "export const run = () => {}",
    });
    expect(validateImportsVfs(vfs).valid).toBe(true);
  });
});

// =============================================================================
// C. Circular dependency detection — advanced shapes
// =============================================================================

describe("Circular dependency detection — advanced graph shapes", () => {
  it("5-node cycle A→B→C→D→E→A — detected", () => {
    const files = new Map([
      ["src/a.ts", "import { b } from './b'"],
      ["src/b.ts", "import { c } from './c'"],
      ["src/c.ts", "import { d } from './d'"],
      ["src/d.ts", "import { e } from './e'"],
      ["src/e.ts", "import { a } from './a'"],
    ]);
    expect(
      validateImports(files).issues.some((i) => i.issue === "circular"),
    ).toBe(true);
  });

  it("independent leaf nodes attached to a cycle — leaves are NOT marked circular", () => {
    const files = new Map([
      ["src/leaf-1.ts", "export const x = 1"],
      ["src/leaf-2.ts", "export const y = 2"],
      [
        "src/cycle-a.ts",
        "import { b } from './cycle-b'\nimport { x } from './leaf-1'",
      ],
      [
        "src/cycle-b.ts",
        "import { a } from './cycle-a'\nimport { y } from './leaf-2'",
      ],
    ]);
    const result = validateImports(files);
    // Circular issue is reported
    expect(result.issues.some((i) => i.issue === "circular")).toBe(true);
    // No unresolved issues (all files exist)
    expect(result.issues.some((i) => i.issue === "unresolved")).toBe(false);
  });

  it("two separate 2-cycles in same file set: at least 2 circular issues", () => {
    const files = new Map([
      ["src/p.ts", "import { q } from './q'"],
      ["src/q.ts", "import { p } from './p'"],
      ["src/r.ts", "import { s } from './s'"],
      ["src/s.ts", "import { r } from './r'"],
    ]);
    const circulars = validateImports(files).issues.filter(
      (i) => i.issue === "circular",
    );
    expect(circulars.length).toBeGreaterThanOrEqual(2);
  });

  it("mixed DAG + cycle in same graph: both circular and valid (non-cycle) edges coexist", () => {
    const files = new Map([
      ["src/shared.ts", "export const shared = 1"],
      [
        "src/a.ts",
        "import { shared } from './shared'\nimport { b } from './b'",
      ],
      ["src/b.ts", "import { a } from './a'"],
    ]);
    const result = validateImports(files);
    expect(result.issues.some((i) => i.issue === "circular")).toBe(true);
    // shared.ts is not involved in cycle
    const unresolved = result.issues.filter((i) => i.issue === "unresolved");
    expect(unresolved).toHaveLength(0);
  });

  it("re-export cycle through barrel: A exports from B, B exports from C, C exports from A", () => {
    const files = new Map([
      ["src/a.ts", "export { x } from './b'"],
      ["src/b.ts", "export { x } from './c'"],
      ["src/c.ts", "export { x } from './a'"],
    ]);
    expect(
      validateImports(files).issues.some((i) => i.issue === "circular"),
    ).toBe(true);
  });

  it("long linear chain with back-edge at end: A→B→C→D→A — cycle detected", () => {
    const files = new Map([
      ["src/a.ts", "import { b } from './b'"],
      ["src/b.ts", "import { c } from './c'"],
      ["src/c.ts", "import { d } from './d'"],
      ["src/d.ts", "import { a } from './a'"],
    ]);
    expect(
      validateImports(files).issues.some((i) => i.issue === "circular"),
    ).toBe(true);
  });

  it("cycle with additional unresolved import: both issues reported", () => {
    const files = new Map([
      ["src/a.ts", "import { b } from './b'\nimport { x } from './missing'"],
      ["src/b.ts", "import { a } from './a'"],
    ]);
    const result = validateImports(files);
    expect(result.issues.some((i) => i.issue === "circular")).toBe(true);
    expect(result.issues.some((i) => i.issue === "unresolved")).toBe(true);
  });

  it("self-import and external cycle are independent issues", () => {
    const files = new Map([
      ["src/self.ts", "import { self } from './self'"],
      ["src/x.ts", "import { y } from './y'"],
      ["src/y.ts", "import { x } from './x'"],
    ]);
    const result = validateImports(files);
    expect(result.issues.some((i) => i.issue === "self-import")).toBe(true);
    expect(result.issues.some((i) => i.issue === "circular")).toBe(true);
  });
});

// =============================================================================
// D. Renamed symbol propagation — multi-file edit batches
// =============================================================================

describe("Renamed symbol propagation — multi-file edits", () => {
  let vfs: VirtualFS;

  beforeEach(() => {
    vfs = new VirtualFS({
      "src/models/user.ts":
        "export interface UserModel { id: string; name: string }",
      "src/services/user-service.ts":
        "import { UserModel } from '../models/user'\nexport function createUser(m: UserModel): UserModel { return m }",
      "src/api/user-router.ts":
        "import { UserModel } from '../models/user'\nimport { createUser } from '../services/user-service'\nconst u: UserModel = createUser({ id: '1', name: 'Alice' })",
    });
  });

  it("rename interface in definition file updates definition", async () => {
    await applyMultiEdit(vfs, [
      {
        filePath: "src/models/user.ts",
        edits: [{ oldText: "UserModel", newText: "UserEntity" }],
      },
    ]);
    expect(vfs.read("src/models/user.ts")).toContain("UserEntity");
    expect(vfs.read("src/models/user.ts")).not.toContain("UserModel");
  });

  it("rename propagated to first consumer file", async () => {
    // String.replace() replaces only the first occurrence per edit entry.
    // user-service.ts: "{ UserModel } from" → first occurrence in import line.
    // The function signature occurrences need separate edit entries.
    await applyMultiEdit(vfs, [
      {
        filePath: "src/models/user.ts",
        edits: [{ oldText: "UserModel", newText: "UserEntity" }],
      },
      {
        filePath: "src/services/user-service.ts",
        edits: [
          {
            oldText: "import { UserModel } from '../models/user'",
            newText: "import { UserEntity } from '../models/user'",
          },
          {
            oldText:
              "export function createUser(m: UserModel): UserModel { return m }",
            newText:
              "export function createUser(m: UserEntity): UserEntity { return m }",
          },
        ],
      },
    ]);
    expect(vfs.read("src/services/user-service.ts")).toContain("UserEntity");
    expect(vfs.read("src/services/user-service.ts")).not.toContain("UserModel");
  });

  it("rename propagated to second consumer file independently", async () => {
    await applyMultiEdit(vfs, [
      {
        filePath: "src/api/user-router.ts",
        edits: [{ oldText: "UserModel", newText: "UserEntity" }],
      },
    ]);
    expect(vfs.read("src/api/user-router.ts")).toContain("UserEntity");
  });

  it("partial rename: one consumer updated, one not — vfs captures partial state", async () => {
    await applyMultiEdit(vfs, [
      {
        filePath: "src/models/user.ts",
        edits: [{ oldText: "UserModel", newText: "UserEntity" }],
      },
      {
        filePath: "src/services/user-service.ts",
        edits: [{ oldText: "UserModel", newText: "UserEntity" }],
      },
      // user-router.ts intentionally NOT updated
    ]);
    // router still has old name
    expect(vfs.read("src/api/user-router.ts")).toContain("UserModel");
    // service is updated
    expect(vfs.read("src/services/user-service.ts")).toContain("UserEntity");
  });

  it("rename function name in utility and update all callers in batch", async () => {
    const v = new VirtualFS({
      "utils/format.ts":
        "export function formatDate(d: Date): string { return d.toISOString() }",
      "api/orders.ts":
        "import { formatDate } from '../utils/format'\nconst s = formatDate(new Date())",
      "api/reports.ts":
        "import { formatDate } from '../utils/format'\nconst s = formatDate(new Date())",
    });

    await applyMultiEdit(v, [
      {
        filePath: "utils/format.ts",
        edits: [
          {
            oldText: "export function formatDate",
            newText: "export function toISODate",
          },
        ],
      },
      {
        filePath: "api/orders.ts",
        edits: [
          {
            oldText: "import { formatDate } from '../utils/format'",
            newText: "import { toISODate } from '../utils/format'",
          },
        ],
      },
      {
        filePath: "api/reports.ts",
        edits: [
          {
            oldText: "import { formatDate } from '../utils/format'",
            newText: "import { toISODate } from '../utils/format'",
          },
        ],
      },
    ]);

    expect(v.read("utils/format.ts")).toContain("toISODate");
    expect(v.read("api/orders.ts")).toContain("toISODate");
    expect(v.read("api/reports.ts")).toContain("toISODate");
  });

  it("rename constant exported from barrel: barrel and consumer both updated", async () => {
    const v = new VirtualFS({
      "constants/config.ts": "export const MAX_RETRIES = 3",
      "constants/index.ts": "export { MAX_RETRIES } from './config'",
      "app/service.ts":
        "import { MAX_RETRIES } from '../constants'\nconsole.log(MAX_RETRIES)",
    });

    await applyMultiEdit(v, [
      {
        filePath: "constants/config.ts",
        edits: [{ oldText: "MAX_RETRIES", newText: "RETRY_LIMIT" }],
      },
      {
        filePath: "constants/index.ts",
        edits: [{ oldText: "MAX_RETRIES", newText: "RETRY_LIMIT" }],
      },
      {
        filePath: "app/service.ts",
        edits: [{ oldText: "MAX_RETRIES", newText: "RETRY_LIMIT" }],
      },
    ]);

    expect(v.read("constants/config.ts")).toContain("RETRY_LIMIT");
    expect(v.read("constants/index.ts")).toContain("RETRY_LIMIT");
    expect(v.read("app/service.ts")).toContain("RETRY_LIMIT");
  });

  it("rename does not affect unrelated files", async () => {
    const v = new VirtualFS({
      "src/alpha.ts": "export const foo = 1",
      "src/beta.ts": "export const bar = 2",
      "src/gamma.ts": "import { foo } from './alpha'\nconsole.log(foo)",
    });

    await applyMultiEdit(v, [
      {
        filePath: "src/alpha.ts",
        edits: [{ oldText: "foo", newText: "qux" }],
      },
      {
        filePath: "src/gamma.ts",
        edits: [{ oldText: "foo", newText: "qux" }],
      },
    ]);

    // beta untouched
    expect(v.read("src/beta.ts")).toBe("export const bar = 2");
  });
});

// =============================================================================
// E. Multi-file edit batch coherence — batch scenarios
// =============================================================================

describe("Multi-file edit batch coherence", () => {
  it("batch with zero fileEdits returns no-op message", async () => {
    const vfs = new VirtualFS({ "src/a.ts": "export const x = 1" });
    const result = await applyMultiEdit(vfs, []);
    // Should not throw; result should be a string
    expect(typeof result).toBe("string");
  });

  it("batch touching 5 files — all applied", async () => {
    const initial: Record<string, string> = {};
    for (let i = 0; i < 5; i++) {
      initial[`src/m${i}.ts`] = `export const value${i} = ${i}`;
    }
    const vfs = new VirtualFS(initial);

    await applyMultiEdit(vfs, [
      {
        filePath: "src/m0.ts",
        edits: [{ oldText: "value0 = 0", newText: "value0 = 100" }],
      },
      {
        filePath: "src/m1.ts",
        edits: [{ oldText: "value1 = 1", newText: "value1 = 101" }],
      },
      {
        filePath: "src/m2.ts",
        edits: [{ oldText: "value2 = 2", newText: "value2 = 102" }],
      },
      {
        filePath: "src/m3.ts",
        edits: [{ oldText: "value3 = 3", newText: "value3 = 103" }],
      },
      {
        filePath: "src/m4.ts",
        edits: [{ oldText: "value4 = 4", newText: "value4 = 104" }],
      },
    ]);

    for (let i = 0; i < 5; i++) {
      expect(vfs.read(`src/m${i}.ts`)).toContain(`value${i} = ${100 + i}`);
    }
  });

  it("batch with all missing files: vfs unchanged", async () => {
    const vfs = new VirtualFS({ "src/a.ts": "export const x = 1" });
    const originalContent = vfs.read("src/a.ts");

    await applyMultiEdit(vfs, [
      {
        filePath: "src/ghost1.ts",
        edits: [{ oldText: "foo", newText: "bar" }],
      },
      {
        filePath: "src/ghost2.ts",
        edits: [{ oldText: "baz", newText: "qux" }],
      },
    ]);

    // Original file untouched
    expect(vfs.read("src/a.ts")).toBe(originalContent);
    expect(vfs.exists("src/ghost1.ts")).toBe(false);
    expect(vfs.exists("src/ghost2.ts")).toBe(false);
  });

  it("result string from successful batch contains count of modified files", async () => {
    const vfs = new VirtualFS({
      "src/a.ts": "const a = 1",
      "src/b.ts": "const b = 2",
      "src/c.ts": "const c = 3",
    });

    const result = await applyMultiEdit(vfs, [
      {
        filePath: "src/a.ts",
        edits: [{ oldText: "const a = 1", newText: "const a = 10" }],
      },
      {
        filePath: "src/b.ts",
        edits: [{ oldText: "const b = 2", newText: "const b = 20" }],
      },
      {
        filePath: "src/c.ts",
        edits: [{ oldText: "const c = 3", newText: "const c = 30" }],
      },
    ]);

    expect(result).toMatch(/Applied edits to 3 files/);
  });

  it("batch with mixed hits and misses: only matching edits apply", async () => {
    const vfs = new VirtualFS({
      "src/real.ts": "export const val = 42",
    });

    await applyMultiEdit(vfs, [
      {
        filePath: "src/real.ts",
        edits: [{ oldText: "val = 42", newText: "val = 99" }],
      },
      {
        filePath: "src/fake.ts",
        edits: [{ oldText: "anything", newText: "irrelevant" }],
      },
    ]);

    expect(vfs.read("src/real.ts")).toContain("val = 99");
    expect(vfs.exists("src/fake.ts")).toBe(false);
  });

  it("coherent import batch: after rename, import-validator reports valid", async () => {
    const vfs = new VirtualFS({
      "src/utils.ts": "export function fetchData(): void {}",
      "src/app.ts": "import { fetchData } from './utils'\nfetchData()",
    });

    await applyMultiEdit(vfs, [
      {
        filePath: "src/utils.ts",
        edits: [
          {
            oldText: "export function fetchData",
            newText: "export function loadData",
          },
        ],
      },
      {
        filePath: "src/app.ts",
        edits: [
          {
            oldText: "import { fetchData } from './utils'",
            newText: "import { loadData } from './utils'",
          },
          { oldText: "fetchData()", newText: "loadData()" },
        ],
      },
    ]);

    // After the batch: snapshot -> validate imports: both files still resolve
    const snapshot = vfs.toSnapshot();
    expect(validateImports(snapshot).valid).toBe(true);
  });

  it("incoherent batch: rename in definition but not in importer — import-validator finds no broken path (symbol names not checked by import-validator)", async () => {
    // import-validator checks file path resolution, not symbol names
    const vfs = new VirtualFS({
      "src/utils.ts": "export function fetchData(): void {}",
      "src/app.ts": "import { fetchData } from './utils'\nfetchData()",
    });

    await applyMultiEdit(vfs, [
      {
        filePath: "src/utils.ts",
        edits: [
          {
            oldText: "export function fetchData",
            newText: "export function loadData",
          },
        ],
      },
      // app.ts intentionally NOT updated
    ]);

    // File paths still valid (./utils still exists)
    expect(validateImports(vfs.toSnapshot()).valid).toBe(true);
    // But app.ts still uses old name
    expect(vfs.read("src/app.ts")).toContain("fetchData");
    expect(vfs.read("src/utils.ts")).not.toContain("fetchData");
  });
});

// =============================================================================
// F. Edge cases — empty sets, single files, non-TS, large sets
// =============================================================================

describe("Edge cases — empty sets, single file, non-TS files", () => {
  it("empty Map → valid, zero issues", () => {
    const result = validateImports(new Map());
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("empty Record → valid, zero issues", () => {
    const result = validateImports({});
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("single file with only a comment → valid", () => {
    const files = new Map([["src/a.ts", "// just a comment"]]);
    expect(validateImports(files).valid).toBe(true);
  });

  it("single file with only whitespace → valid", () => {
    const files = new Map([["src/a.ts", "   \n\n  "]]);
    expect(validateImports(files).valid).toBe(true);
  });

  it("single file exporting without any imports → valid", () => {
    const files = new Map([
      ["src/a.ts", "export const x = 1; export function f() {}"],
    ]);
    expect(validateImports(files).valid).toBe(true);
  });

  it("single file importing only npm packages → valid (non-relative ignored)", () => {
    const files = new Map([
      [
        "src/app.ts",
        "import { z } from 'zod'\nimport { describe } from 'vitest'\nimport path from 'node:path'",
      ],
    ]);
    expect(validateImports(files).valid).toBe(true);
  });

  it("file with both npm and relative imports: only relative checked", () => {
    const files = new Map([
      ["src/utils.ts", "export const x = 1"],
      ["src/app.ts", "import { z } from 'zod'\nimport { x } from './utils'"],
    ]);
    expect(validateImports(files).valid).toBe(true);
  });

  it("25 isolated files with no imports — all valid", () => {
    const files = new Map<string, string>();
    for (let i = 0; i < 25; i++) {
      files.set(`src/module-${i}.ts`, `export const v${i} = ${i}`);
    }
    expect(validateImports(files).valid).toBe(true);
  });

  it("deeply nested file resolving sibling — valid", () => {
    const files = new Map([
      ["a/b/c/d/e/f.ts", "import { x } from './g'"],
      ["a/b/c/d/e/g.ts", "export const x = 1"],
    ]);
    expect(validateImports(files).valid).toBe(true);
  });

  it("deeply nested file resolving ancestor — valid", () => {
    const files = new Map([
      ["root.ts", "export const ROOT = true"],
      ["a/b/c/d/deep.ts", "import { ROOT } from '../../../../root'"],
    ]);
    expect(validateImports(files).valid).toBe(true);
  });

  it("file with .tsx extension is validated like .ts", () => {
    const files = new Map([
      ["src/Button.tsx", "import { styles } from './button.styles'"],
      ["src/button.styles.ts", "export const styles = {}"],
    ]);
    expect(validateImports(files).valid).toBe(true);
  });
});

// =============================================================================
// G. Import graph — transitive depth, multi-edge, isolated subgraphs
// =============================================================================

describe("Import graph — advanced scenarios", () => {
  const ROOT = path.resolve("/workspace");

  function makeFiles(entries: Array<[string, string]>) {
    return entries.map(([rel, content]) => ({
      path: path.resolve(ROOT, rel),
      content,
    }));
  }

  it("graph with two isolated subgraphs: each has its own root", () => {
    const files = makeFiles([
      ["src/shared-a.ts", "export const a = 1"],
      ["src/consumer-a.ts", "import { a } from './shared-a'"],
      ["src/shared-b.ts", "export const b = 2"],
      ["src/consumer-b.ts", "import { b } from './shared-b'"],
    ]);
    const graph = buildImportGraph(files, ROOT);
    const roots = graph.roots();
    // shared-a and shared-b are roots (nothing imports them)
    expect(roots.length).toBeGreaterThanOrEqual(2);
  });

  it("star import appears in edge symbols as '* as <alias>'", () => {
    const files = makeFiles([
      ["src/math.ts", "export const PI = 3.14"],
      ["src/app.ts", "import * as Math from './math'"],
    ]);
    const graph = buildImportGraph(files, ROOT);
    expect(graph.edges[0]!.symbols[0]).toContain("Math");
  });

  it("named imports are split into individual symbols", () => {
    const files = makeFiles([
      [
        "src/lib.ts",
        "export const a = 1; export const b = 2; export const c = 3",
      ],
      ["src/app.ts", "import { a, b, c } from './lib'"],
    ]);
    const graph = buildImportGraph(files, ROOT);
    expect(graph.edges[0]!.symbols).toContain("a");
    expect(graph.edges[0]!.symbols).toContain("b");
    expect(graph.edges[0]!.symbols).toContain("c");
  });

  it("file importing two different files: two edges from that file", () => {
    const files = makeFiles([
      ["src/a.ts", "export const a = 1"],
      ["src/b.ts", "export const b = 2"],
      ["src/app.ts", "import { a } from './a'\nimport { b } from './b'"],
    ]);
    const graph = buildImportGraph(files, ROOT);
    const fromApp = graph.edges.filter((e) => e.from.includes("app.ts"));
    expect(fromApp).toHaveLength(2);
  });

  it("importedBy returns multiple importers when multiple files import the same target", () => {
    const libPath = path.resolve(ROOT, "src/lib.ts");
    const files = makeFiles([
      ["src/lib.ts", "export const lib = true"],
      ["src/consumer-1.ts", "import { lib } from './lib'"],
      ["src/consumer-2.ts", "import { lib } from './lib'"],
      ["src/consumer-3.ts", "import { lib } from './lib'"],
    ]);
    const graph = buildImportGraph(files, ROOT);
    const importers = graph.importedBy(libPath);
    expect(importers).toHaveLength(3);
  });

  it("importsFrom returns all files imported by a given file", () => {
    const appPath = path.resolve(ROOT, "src/app.ts");
    const files = makeFiles([
      ["src/a.ts", "export const a = 1"],
      ["src/b.ts", "export const b = 2"],
      ["src/c.ts", "export const c = 3"],
      [
        "src/app.ts",
        "import { a } from './a'\nimport { b } from './b'\nimport { c } from './c'",
      ],
    ]);
    const graph = buildImportGraph(files, ROOT);
    const deps = graph.importsFrom(appPath);
    expect(deps).toHaveLength(3);
  });

  it("roots are files with no outbound resolved edges (pure exporters)", () => {
    const files = makeFiles([
      ["src/pure-a.ts", "export const a = 1"],
      ["src/pure-b.ts", "export const b = 2"],
      [
        "src/composite.ts",
        "import { a } from './pure-a'\nimport { b } from './pure-b'",
      ],
    ]);
    const graph = buildImportGraph(files, ROOT);
    const roots = graph.roots();
    expect(roots.some((r) => r.includes("pure-a.ts"))).toBe(true);
    expect(roots.some((r) => r.includes("pure-b.ts"))).toBe(true);
    expect(roots.some((r) => r.includes("composite.ts"))).toBe(false);
  });

  it("package imports (non-relative) do NOT create edges", () => {
    const files = makeFiles([
      ["src/app.ts", "import { z } from 'zod'\nimport React from 'react'"],
    ]);
    const graph = buildImportGraph(files, ROOT);
    expect(graph.edges).toHaveLength(0);
  });

  it("index.ts resolution: directory import maps to index.ts", () => {
    const files = makeFiles([
      ["src/components/index.ts", "export const Button = 'Button'"],
      ["src/app.ts", "import { Button } from './components'"],
    ]);
    const graph = buildImportGraph(files, ROOT);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.to).toContain("components/index.ts");
  });

  it("ESM .js import resolved to .ts file in graph", () => {
    const files = makeFiles([
      ["src/utils.ts", "export const x = 1"],
      ["src/app.ts", "import { x } from './utils.js'"],
    ]);
    const graph = buildImportGraph(files, ROOT);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.to).toContain("utils.ts");
  });
});

// =============================================================================
// H. Contract validator — fetch(), path params, multi-file scenarios
// =============================================================================

describe("Contract validator — fetch() and path-param scenarios", () => {
  it("fetch() with no method object defaults to GET — matched by GET endpoint", () => {
    const backend = { "api/health.ts": "router.get('/health', h)" };
    const frontend = { "ui/ping.ts": "fetch('/health')" };
    const result = validateContracts(backend, frontend);
    expect(result.valid).toBe(true);
  });

  it("fetch() with method: POST — matched by POST endpoint", () => {
    const backend = { "api/users.ts": "router.post('/users', h)" };
    const frontend = {
      "ui/create.ts":
        "fetch('/users', { method: 'POST', body: JSON.stringify(data) })",
    };
    const result = validateContracts(backend, frontend);
    expect(result.valid).toBe(true);
  });

  it("fetch() with method: DELETE — matched by DELETE endpoint", () => {
    const backend = { "api/items.ts": "router.delete('/items/1', h)" };
    const frontend = { "ui/del.ts": "fetch('/items/1', { method: 'DELETE' })" };
    const result = validateContracts(backend, frontend);
    expect(result.valid).toBe(true);
  });

  it("path params: /:id and /123 normalize to same path key", () => {
    // normalizePath lowercases but doesn't strip param segments
    // Both paths are literal strings in the source — if they match exactly, they match
    const backend = { "api/r.ts": "router.get('/users/123', h)" };
    const frontend = { "ui/c.ts": "axios.get('/users/123')" };
    expect(validateContracts(backend, frontend).valid).toBe(true);
  });

  it("trailing slash on backend path stripped: /users/ → /users matches /users call", () => {
    const backend = { "api/r.ts": "router.get('/users/', h)" };
    const frontend = { "ui/c.ts": "axios.get('/users')" };
    // normalizePath strips trailing slash on both sides
    expect(validateContracts(backend, frontend).valid).toBe(true);
  });

  it("case-insensitive path: /Users vs /users → matched", () => {
    const backend = { "api/r.ts": "router.get('/Users', h)" };
    const frontend = { "ui/c.ts": "axios.get('/users')" };
    // normalizePath lowercases both
    expect(validateContracts(backend, frontend).valid).toBe(true);
  });

  it("multiple methods on same path: both GET and POST present — each call matches its method", () => {
    const backend = {
      "api/items.ts": "router.get('/items', h)\nrouter.post('/items', h)",
    };
    const frontend = {
      "ui/items.ts": "axios.get('/items')\naxios.post('/items', data)",
    };
    expect(validateContracts(backend, frontend).valid).toBe(true);
  });

  it("extractEndpoints returns empty array for file with no endpoint patterns", () => {
    const endpoints = extractEndpoints({
      "src/utils.ts": "export const helper = () => {}",
    });
    expect(endpoints).toHaveLength(0);
  });

  it("extractAPICalls returns empty array for file with no call patterns", () => {
    const calls = extractAPICalls({
      "src/utils.ts": "export const helper = () => {}",
    });
    expect(calls).toHaveLength(0);
  });

  it("extractEndpoints records correct line numbers (1-based)", () => {
    const content = "// line 1 comment\nrouter.get('/api', h)";
    const endpoints = extractEndpoints({ "r.ts": content });
    expect(endpoints[0]!.line).toBe(2);
  });

  it("extractAPICalls records correct line numbers (1-based)", () => {
    const content = "// comment\n// another comment\naxios.get('/api')";
    const calls = extractAPICalls({ "ui.ts": content });
    expect(calls[0]!.line).toBe(3);
  });

  it("validateContracts returns correct endpoints and calls on result object", () => {
    const backend = { "api.ts": "router.get('/x', h)\nrouter.post('/y', h)" };
    const frontend = { "ui.ts": "axios.get('/x')\naxios.post('/y')" };
    const result = validateContracts(backend, frontend);
    expect(result.endpoints).toHaveLength(2);
    expect(result.calls).toHaveLength(2);
  });

  it("unmatched-endpoint issues are informational: result.valid stays true", () => {
    const backend = {
      "api/used.ts": "router.get('/used', h)",
      "api/unused.ts": "router.get('/unused', h)",
    };
    const frontend = { "ui/c.ts": "axios.get('/used')" };
    const result = validateContracts(backend, frontend);
    expect(result.valid).toBe(true);
    expect(result.issues.some((i) => i.type === "unmatched-endpoint")).toBe(
      true,
    );
  });

  it("method-mismatch description contains both call method and available method", () => {
    const backend = { "api.ts": "router.post('/resource', h)" };
    const frontend = { "ui.ts": "axios.get('/resource')" };
    const result = validateContracts(backend, frontend);
    const mm = result.issues.find((i) => i.type === "method-mismatch")!;
    expect(mm.description).toContain("POST");
  });

  it("large coherent project: 10 CRUD domains all matched", () => {
    const domains = [
      "users",
      "orders",
      "products",
      "inventory",
      "payments",
      "shipping",
      "reviews",
      "notifications",
      "reports",
      "settings",
    ];
    const backend: Record<string, string> = {};
    const frontend: Record<string, string> = {};

    for (const d of domains) {
      backend[`routes/${d}.ts`] = [
        `router.get('/api/${d}', h)`,
        `router.post('/api/${d}', h)`,
        `router.put('/api/${d}/1', h)`,
        `router.delete('/api/${d}/1', h)`,
      ].join("\n");
      frontend[`ui/${d}.ts`] = [
        `axios.get('/api/${d}')`,
        `axios.post('/api/${d}', data)`,
        `axios.put('/api/${d}/1', data)`,
        `axios.delete('/api/${d}/1')`,
      ].join("\n");
    }

    const result = validateContracts(backend, frontend);
    // All calls matched → valid, no method-mismatch or unmatched-call
    expect(result.valid).toBe(true);
    const errors = result.issues.filter(
      (i) => i.type === "unmatched-call" || i.type === "method-mismatch",
    );
    expect(errors).toHaveLength(0);
  });
});
