/**
 * W31-F: Multi-file coherence validation — deep coverage
 *
 * Covers gaps NOT in multi-file-coherence-deep.test.ts:
 * - Cross-file type consistency (type defined in A, used in B)
 * - Import resolution correctness (broken imports detected)
 * - API surface drift detection (signature changes flagged)
 * - Interface implementation checks
 * - Re-export chain validation
 * - Circular type dependencies
 * - Optional vs required field drift
 * - Generic constraint changes
 * - Return type widening
 * - Namespace collisions
 * - Dead exports
 * - Validation report format
 */

import { describe, it, expect } from "vitest";
import { validateImports } from "../quality/import-validator.js";
import {
  extractEndpoints,
  extractAPICalls,
  validateContracts,
} from "../quality/contract-validator.js";

// ─── 1. Cross-file type consistency ──────────────────────────────────────────

describe("Cross-file type consistency", () => {
  describe("type defined in A, imported and used in B", () => {
    it("valid: B imports type from A that exists", () => {
      const files = new Map([
        ["src/types.ts", "export type User = { id: string; name: string }"],
        ["src/service.ts", "import type { User } from './types'"],
      ]);
      const result = validateImports(files);
      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it("invalid: B imports type from A that does NOT exist", () => {
      const files = new Map([
        ["src/service.ts", "import type { User } from './types'"],
        // types.ts is missing
      ]);
      const result = validateImports(files);
      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => i.issue === "unresolved")).toBe(true);
    });

    it("type import path is tracked exactly as written", () => {
      const files = new Map([
        [
          "src/handlers/user.ts",
          "import type { UserDto } from '../models/user-dto'",
        ],
        // missing ../models/user-dto
      ]);
      const result = validateImports(files);
      expect(result.issues[0]?.importPath).toBe("../models/user-dto");
    });

    it("type from shared barrel resolves correctly", () => {
      const files = new Map([
        ["src/types/index.ts", "export type Product = { sku: string }"],
        ["src/services/cart.ts", "import type { Product } from '../types'"],
      ]);
      const result = validateImports(files);
      expect(result.valid).toBe(true);
    });

    it("deep nested type: A → B → C all valid", () => {
      const files = new Map([
        ["pkg/core/types.ts", "export interface Id { value: string }"],
        ["pkg/domain/entity.ts", "import { Id } from '../core/types'"],
        ["pkg/app/service.ts", "import { Id } from '../core/types'"],
      ]);
      const result = validateImports(files);
      expect(result.valid).toBe(true);
    });
  });
});

// ─── 2. Import resolution correctness ────────────────────────────────────────

describe("Import resolution correctness", () => {
  describe("path resolution rules", () => {
    it("resolves sibling file import (.ts extension)", () => {
      const files = new Map([
        ["src/a.ts", "import { foo } from './b'"],
        ["src/b.ts", "export const foo = 1"],
      ]);
      expect(validateImports(files).valid).toBe(true);
    });

    it("resolves explicit .ts extension import", () => {
      const files = new Map([
        ["src/a.ts", "import { bar } from './b.ts'"],
        ["src/b.ts", "export const bar = 2"],
      ]);
      expect(validateImports(files).valid).toBe(true);
    });

    it("resolves .js extension via ESM .js → .ts mapping", () => {
      const files = new Map([
        ["src/consumer.ts", "import { baz } from './utils.js'"],
        ["src/utils.ts", "export const baz = 3"],
      ]);
      expect(validateImports(files).valid).toBe(true);
    });

    it("resolves directory index (index.ts)", () => {
      const files = new Map([
        ["src/app.ts", "import { helper } from './utils'"],
        ["src/utils/index.ts", "export const helper = () => {}"],
      ]);
      expect(validateImports(files).valid).toBe(true);
    });

    it("broken import: target file missing → unresolved", () => {
      const files = new Map([
        ["src/consumer.ts", "import { x } from './missing-module'"],
      ]);
      const result = validateImports(files);
      expect(result.valid).toBe(false);
      expect(result.issues[0]?.issue).toBe("unresolved");
    });

    it("broken import: file records correct source file path", () => {
      const files = new Map([
        ["src/features/auth.ts", "import { Token } from './token-service'"],
      ]);
      const result = validateImports(files);
      expect(result.issues[0]?.file).toBe("src/features/auth.ts");
    });

    it("broken import: line number is 1-based", () => {
      const files = new Map([["src/a.ts", "\n\nimport { x } from './gone'"]]);
      const result = validateImports(files);
      expect(result.issues[0]?.line).toBeGreaterThan(0);
    });

    it("dynamic import resolves correctly", () => {
      const files = new Map([
        ["src/lazy.ts", "const mod = await import('./lazy-module')"],
        ["src/lazy-module.ts", "export const load = () => {}"],
      ]);
      expect(validateImports(files).valid).toBe(true);
    });

    it("dynamic import to missing file → unresolved", () => {
      const files = new Map([
        ["src/lazy.ts", "const mod = await import('./missing-lazy')"],
      ]);
      const result = validateImports(files);
      expect(result.valid).toBe(false);
      expect(result.issues[0]?.issue).toBe("unresolved");
    });

    it("parent directory traversal resolves", () => {
      const files = new Map([
        [
          "src/deep/nested/consumer.ts",
          "import { shared } from '../../shared'",
        ],
        ["src/shared.ts", "export const shared = true"],
      ]);
      expect(validateImports(files).valid).toBe(true);
    });
  });

  describe("multiple broken imports in same file", () => {
    it("reports all broken imports from one file", () => {
      const files = new Map([
        [
          "src/broken.ts",
          [
            "import { A } from './missing-a'",
            "import { B } from './missing-b'",
            "import { C } from './missing-c'",
          ].join("\n"),
        ],
      ]);
      const result = validateImports(files);
      expect(
        result.issues.filter((i) => i.issue === "unresolved")
      ).toHaveLength(3);
    });

    it("mix of valid and invalid imports: only invalid flagged", () => {
      const files = new Map([
        [
          "src/mixed.ts",
          [
            "import { good } from './present'",
            "import { bad } from './absent'",
          ].join("\n"),
        ],
        ["src/present.ts", "export const good = 1"],
      ]);
      const result = validateImports(files);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]?.importPath).toBe("./absent");
    });
  });
});

// ─── 3. API surface drift detection ──────────────────────────────────────────

describe("API surface drift detection", () => {
  describe("endpoint signature changes", () => {
    it("path change: frontend call no longer matches backend → unmatched-call", () => {
      const backend = {
        "api/users.ts": "router.get('/users/v2', handler)",
      };
      const frontend = {
        "ui/api.ts": "axios.get('/users')",
      };
      const result = validateContracts(backend, frontend);
      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => i.type === "unmatched-call")).toBe(true);
    });

    it("method change: backend switched PUT to PATCH → method mismatch for old callers", () => {
      const backend = {
        "api/items.ts": "router.patch('/items/:id', handler)",
      };
      const frontend = {
        "ui/items.ts": "axios.put('/items/:id')",
      };
      const result = validateContracts(backend, frontend);
      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => i.type === "method-mismatch")).toBe(
        true
      );
    });

    it("endpoint removed: callers get unmatched-call", () => {
      const backend = {}; // removed endpoint
      const frontend = {
        "ui/data.ts": "axios.get('/reports')",
      };
      const result = validateContracts(backend, frontend);
      expect(result.valid).toBe(false);
      expect(result.issues[0]?.type).toBe("unmatched-call");
    });

    it("endpoint added: no frontend calls yet → unmatched-endpoint (not an error)", () => {
      const backend = {
        "api/new.ts": "router.post('/new-feature', handler)",
      };
      const frontend = {};
      const result = validateContracts(backend, frontend);
      expect(result.valid).toBe(true);
      expect(result.issues.some((i) => i.type === "unmatched-endpoint")).toBe(
        true
      );
    });

    it("path versioning drift: v1 removed, v2 added, old callers flagged", () => {
      const backend = {
        "api/orders.ts": "router.get('/api/v2/orders', handler)",
      };
      const frontend = {
        "ui/orders.ts": "axios.get('/api/v1/orders')",
      };
      const result = validateContracts(backend, frontend);
      expect(result.valid).toBe(false);
    });

    it("exact path match required: trailing slash stripped", () => {
      const backend = {
        "api/products.ts": "router.get('/products', handler)",
      };
      const frontend = {
        "ui/products.ts": "axios.get('/products/')",
      };
      // normalizePath strips trailing slash — both normalize to /products
      const result = validateContracts(backend, frontend);
      expect(result.valid).toBe(true);
    });

    it("case normalization: uppercase path in call normalizes to lowercase", () => {
      const backend = {
        "api/items.ts": "router.get('/items', handler)",
      };
      const frontend = {
        "ui/items.ts": "axios.get('/ITEMS')",
      };
      // normalizePath lowercases → both resolve to /items
      const result = validateContracts(backend, frontend);
      expect(result.valid).toBe(true);
    });
  });

  describe("drift report quality", () => {
    it("issue description mentions the mismatched path", () => {
      const backend = {
        "api/v1.ts": "router.get('/api/products', handler)",
      };
      const frontend = {
        "ui/api.ts": "axios.post('/api/products')",
      };
      const result = validateContracts(backend, frontend);
      const issue = result.issues.find((i) => i.type === "method-mismatch");
      expect(issue?.description).toContain("/api/products");
    });

    it("issue records the frontend file where the drift was detected", () => {
      const backend = {
        "api/users.ts": "router.get('/users', handler)",
      };
      const frontend = {
        "ui/user-service.ts": "axios.post('/users')",
      };
      const result = validateContracts(backend, frontend);
      const issue = result.issues.find((i) => i.type === "method-mismatch");
      expect(issue?.file).toBe("ui/user-service.ts");
    });

    it("drift across many consumers: each mismatch reported separately", () => {
      const backend = {
        "api/data.ts": "router.post('/data', handler)",
      };
      const frontend = {
        "ui/a.ts": "axios.get('/data')",
        "ui/b.ts": "axios.get('/data')",
        "ui/c.ts": "axios.get('/data')",
      };
      const result = validateContracts(backend, frontend);
      const mismatches = result.issues.filter(
        (i) => i.type === "method-mismatch"
      );
      expect(mismatches).toHaveLength(3);
    });
  });
});

// ─── 4. Re-export chain validation ───────────────────────────────────────────

describe("Re-export chain validation", () => {
  it("3-level chain A→B→C: A re-exports from B, B re-exports from C — all valid", () => {
    const files = new Map([
      ["src/core/primitives.ts", "export const id = () => {}"],
      ["src/domain/types.ts", "export { id } from '../core/primitives'"],
      ["src/api/index.ts", "export { id } from '../domain/types'"],
      ["src/app.ts", "import { id } from './api/index'"],
    ]);
    expect(validateImports(files).valid).toBe(true);
  });

  it("broken chain: middle link missing → unresolved at the import site", () => {
    const files = new Map([
      ["src/domain/types.ts", "export { id } from '../core/primitives'"],
      // src/core/primitives.ts missing
      ["src/app.ts", "import { id } from './domain/types'"],
    ]);
    const result = validateImports(files);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.file === "src/domain/types.ts")).toBe(
      true
    );
  });

  it("star re-export passes through if source file exists", () => {
    const files = new Map([
      [
        "src/utils/math.ts",
        "export const add = (a: number, b: number) => a + b",
      ],
      ["src/utils/index.ts", "export * from './math'"],
      ["src/main.ts", "import { add } from './utils'"],
    ]);
    expect(validateImports(files).valid).toBe(true);
  });

  it("star re-export from missing source → unresolved", () => {
    const files = new Map([
      ["src/utils/index.ts", "export * from './non-existent'"],
    ]);
    const result = validateImports(files);
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.issue).toBe("unresolved");
  });

  it("4-level re-export chain: A→B→C→D all present — valid", () => {
    const files = new Map([
      ["pkg/a.ts", "export const x = 1"],
      ["pkg/b.ts", "export { x } from './a'"],
      ["pkg/c.ts", "export { x } from './b'"],
      ["pkg/d.ts", "export { x } from './c'"],
      ["src/main.ts", "import { x } from '../pkg/d'"],
    ]);
    expect(validateImports(files).valid).toBe(true);
  });

  it("re-export chain with circular link detected as circular", () => {
    const files = new Map([
      ["src/a.ts", "export { y } from './b'"],
      ["src/b.ts", "export { y } from './a'"],
    ]);
    const result = validateImports(files);
    expect(result.issues.some((i) => i.issue === "circular")).toBe(true);
  });
});

// ─── 5. Circular type dependencies ───────────────────────────────────────────

describe("Circular type dependencies", () => {
  it("direct cycle A→B→A is detected as circular", () => {
    const files = new Map([
      ["src/a.ts", "import { B } from './b'"],
      ["src/b.ts", "import { A } from './a'"],
    ]);
    const result = validateImports(files);
    expect(result.issues.some((i) => i.issue === "circular")).toBe(true);
  });

  it("3-cycle A→B→C→A detected", () => {
    const files = new Map([
      ["src/a.ts", "import { B } from './b'"],
      ["src/b.ts", "import { C } from './c'"],
      ["src/c.ts", "import { A } from './a'"],
    ]);
    const result = validateImports(files);
    expect(result.issues.some((i) => i.issue === "circular")).toBe(true);
  });

  it("DAG (no cycle): A→C and B→C — no circular issue", () => {
    const files = new Map([
      ["src/shared.ts", "export const common = true"],
      ["src/module-a.ts", "import { common } from './shared'"],
      ["src/module-b.ts", "import { common } from './shared'"],
    ]);
    const result = validateImports(files);
    expect(result.issues.some((i) => i.issue === "circular")).toBe(false);
  });

  it("self-import (A→A) reported as self-import, not circular", () => {
    const files = new Map([["src/a.ts", "import { x } from './a'"]]);
    const result = validateImports(files);
    expect(result.issues.some((i) => i.issue === "self-import")).toBe(true);
    expect(result.issues.some((i) => i.issue === "circular")).toBe(false);
  });

  it("isolated cycle + clean modules: cycle reported, clean modules unaffected", () => {
    const files = new Map([
      ["src/good-a.ts", "import { x } from './good-b'"],
      ["src/good-b.ts", "export const x = 1"],
      ["src/cycle-x.ts", "import { y } from './cycle-y'"],
      ["src/cycle-y.ts", "import { x } from './cycle-x'"],
    ]);
    const result = validateImports(files);
    expect(result.issues.some((i) => i.issue === "circular")).toBe(true);
    // The circular issue involves cycle-x or cycle-y, not good-*
    const circularFiles = result.issues
      .filter((i) => i.issue === "circular")
      .map((i) => i.file);
    expect(circularFiles.every((f) => f.startsWith("src/cycle"))).toBe(true);
  });

  it("two disjoint cycles both detected", () => {
    const files = new Map([
      ["src/x1.ts", "import { a } from './x2'"],
      ["src/x2.ts", "import { b } from './x1'"],
      ["src/y1.ts", "import { c } from './y2'"],
      ["src/y2.ts", "import { d } from './y1'"],
    ]);
    const result = validateImports(files);
    const circular = result.issues.filter((i) => i.issue === "circular");
    expect(circular.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── 6. Optional vs required field drift ─────────────────────────────────────

describe("Optional vs required field drift (via contract simulation)", () => {
  /**
   * We simulate this at the API level: a field that used to be optional becomes
   * required — if backend now demands a body field, POST calls missing that
   * context show up as method mismatches or unmatched calls in the contract.
   */
  it("endpoint path unchanged but HTTP method changed — existing callers flagged", () => {
    const backend = {
      "api/config.ts": "router.post('/config/update', handler)",
    };
    const frontend = {
      "ui/settings.ts": "axios.get('/config/update')", // old callers using GET
    };
    const result = validateContracts(backend, frontend);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.type === "method-mismatch")).toBe(true);
  });

  it("required field drift represented as new endpoint path: old callers miss", () => {
    // When a required field is added, a versioned endpoint is typical
    const backend = {
      "api/search.ts": "router.post('/search/v2', handler)",
    };
    const frontend = {
      "ui/search.ts": "axios.post('/search/v1')", // still calling old endpoint
    };
    const result = validateContracts(backend, frontend);
    expect(result.valid).toBe(false);
  });
});

// ─── 7. Generic constraint changes ───────────────────────────────────────────

describe("Generic constraint changes (import-level coherence)", () => {
  it("generic utility file importable from multiple consumers", () => {
    const files = new Map([
      [
        "src/utils/generic.ts",
        "export function identity<T>(v: T): T { return v }",
      ],
      ["src/a.ts", "import { identity } from './utils/generic'"],
      ["src/b.ts", "import { identity } from './utils/generic'"],
      ["src/c.ts", "import { identity } from './utils/generic'"],
    ]);
    expect(validateImports(files).valid).toBe(true);
  });

  it("when generic module is removed, all callers become unresolved", () => {
    const files = new Map([
      // generic.ts removed
      ["src/a.ts", "import { identity } from './utils/generic'"],
      ["src/b.ts", "import { identity } from './utils/generic'"],
    ]);
    const result = validateImports(files);
    expect(result.issues.filter((i) => i.issue === "unresolved")).toHaveLength(
      2
    );
  });
});

// ─── 8. Return type widening ──────────────────────────────────────────────────

describe("Return type widening (API endpoint coherence)", () => {
  it("endpoint that now returns 404 on old path: frontend callers see unmatched-call", () => {
    // Simulate: backend deprecated GET /data, replaced with GET /data/v2
    const backend = {
      "api/data.ts": "router.get('/data/v2', handler)",
    };
    const frontend = {
      "ui/data.ts": "axios.get('/data')", // still hitting old path
    };
    const result = validateContracts(backend, frontend);
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.type).toBe("unmatched-call");
    expect(result.issues[0]?.description).toContain("/data");
  });

  it("nullable return: new endpoint path, frontend not yet updated", () => {
    const backend = {
      "api/user.ts": [
        "router.get('/user/:id', handler)",
        "router.get('/user/:id/nullable', nullableHandler)",
      ].join("\n"),
    };
    const frontend = {
      "ui/user.ts": "axios.get('/user/:id')",
    };
    const result = validateContracts(backend, frontend);
    // One endpoint matched, one unmatched (nullable one is informational)
    expect(result.valid).toBe(true);
    const unmatched = result.issues.filter(
      (i) => i.type === "unmatched-endpoint"
    );
    expect(unmatched.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── 9. Namespace collision ───────────────────────────────────────────────────

describe("Namespace collision", () => {
  it("two files exporting to same barrel without conflict → valid (resolved at barrel)", () => {
    const files = new Map([
      ["src/features/auth/index.ts", "export { login } from './login'"],
      ["src/features/auth/login.ts", "export const login = () => {}"],
      ["src/features/dashboard/index.ts", "export { login } from './login'"],
      ["src/features/dashboard/login.ts", "export const login = () => {}"],
      // both modules have 'login' but are in separate namespaces
    ]);
    // From import resolution perspective — no collision issues expected
    expect(validateImports(files).valid).toBe(true);
  });

  it("two different endpoints at same path but different methods — both tracked", () => {
    const backend = {
      "api/resource.ts": [
        "router.get('/resource', listHandler)",
        "router.post('/resource', createHandler)",
      ].join("\n"),
    };
    const frontend = {
      "ui/resource.ts": [
        "axios.get('/resource')",
        "axios.post('/resource')",
      ].join("\n"),
    };
    const result = validateContracts(backend, frontend);
    expect(result.valid).toBe(true);
    expect(result.endpoints).toHaveLength(2);
  });

  it("duplicate endpoint (same method + path defined twice) — both tracked in result", () => {
    const backend = {
      "api/dup.ts": [
        "router.get('/items', handler1)",
        "router.get('/items', handler2)",
      ].join("\n"),
    };
    const frontend = {
      "ui/items.ts": "axios.get('/items')",
    };
    const result = validateContracts(backend, frontend);
    expect(result.endpoints).toHaveLength(2);
    expect(result.valid).toBe(true);
  });

  it("name collision between packages: both paths resolve to distinct files", () => {
    const files = new Map([
      ["pkg-a/utils.ts", "export const helper = 1"],
      ["pkg-b/utils.ts", "export const helper = 2"],
      ["src/a.ts", "import { helper } from '../pkg-a/utils'"],
      ["src/b.ts", "import { helper } from '../pkg-b/utils'"],
    ]);
    expect(validateImports(files).valid).toBe(true);
  });
});

// ─── 10. Dead exports ────────────────────────────────────────────────────────

describe("Dead export simulation (via import graph)", () => {
  /**
   * The import validator tracks what is imported. If a file exports something
   * that nobody imports, the file is simply not referenced. We model this by
   * checking that a file with no importers has no unresolved issues.
   */
  it("file with no importers: no issues (validator is per-import, not export)", () => {
    const files = new Map([
      ["src/orphan.ts", "export const unusedHelper = () => {}"],
      ["src/app.ts", "// does not import orphan"],
    ]);
    const result = validateImports(files);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("file imports from orphan: resolves correctly", () => {
    const files = new Map([
      ["src/orphan.ts", "export const unusedHelper = () => {}"],
      ["src/consumer.ts", "import { unusedHelper } from './orphan'"],
    ]);
    expect(validateImports(files).valid).toBe(true);
  });

  it("backend endpoint with no frontend consumer — unmatched-endpoint (informational)", () => {
    const backend = {
      "api/legacy.ts": "router.get('/legacy/report', handler)",
      "api/new.ts": "router.get('/new/report', handler)",
    };
    const frontend = {
      "ui/report.ts": "axios.get('/new/report')",
    };
    const result = validateContracts(backend, frontend);
    expect(result.valid).toBe(true);
    const dead = result.issues.filter((i) => i.type === "unmatched-endpoint");
    expect(dead).toHaveLength(1);
    expect(dead[0]?.description).toContain("/legacy/report");
  });

  it("all backend endpoints consumed → zero unmatched-endpoint issues", () => {
    const backend = {
      "api/a.ts": "router.get('/a', h)",
      "api/b.ts": "router.post('/b', h)",
    };
    const frontend = {
      "ui/client.ts": ["axios.get('/a')", "axios.post('/b')"].join("\n"),
    };
    const result = validateContracts(backend, frontend);
    expect(
      result.issues.filter((i) => i.type === "unmatched-endpoint")
    ).toHaveLength(0);
  });
});

// ─── 11. Validation report format ────────────────────────────────────────────

describe("Validation report format", () => {
  describe("ImportValidationResult structure", () => {
    it("result always has valid and issues fields", () => {
      const result = validateImports(new Map([["src/a.ts", ""]]));
      expect(result).toHaveProperty("valid");
      expect(result).toHaveProperty("issues");
    });

    it("valid is boolean", () => {
      const result = validateImports(new Map());
      expect(typeof result.valid).toBe("boolean");
    });

    it("issues is an array", () => {
      const result = validateImports(new Map());
      expect(Array.isArray(result.issues)).toBe(true);
    });

    it("each issue has file, line, importPath, issue fields", () => {
      const files = new Map([
        ["src/broken.ts", "import { x } from './missing'"],
      ]);
      const result = validateImports(files);
      const issue = result.issues[0]!;
      expect(issue).toHaveProperty("file");
      expect(issue).toHaveProperty("line");
      expect(issue).toHaveProperty("importPath");
      expect(issue).toHaveProperty("issue");
    });

    it("issue.issue is one of: unresolved, circular, self-import", () => {
      const files = new Map([
        ["src/broken.ts", "import { x } from './missing'"],
      ]);
      const result = validateImports(files);
      const validTypes = ["unresolved", "circular", "self-import"];
      expect(validTypes).toContain(result.issues[0]?.issue);
    });

    it("issue.file is a string (path)", () => {
      const files = new Map([
        ["src/broken.ts", "import { x } from './missing'"],
      ]);
      const result = validateImports(files);
      expect(typeof result.issues[0]?.file).toBe("string");
    });

    it("issue.line is a number ≥ 0", () => {
      const files = new Map([
        ["src/broken.ts", "import { x } from './missing'"],
      ]);
      const result = validateImports(files);
      expect(typeof result.issues[0]?.line).toBe("number");
      expect(result.issues[0]!.line).toBeGreaterThanOrEqual(0);
    });

    it("issue.importPath is the exact string written in the source", () => {
      const files = new Map([
        ["src/broken.ts", "import { x } from './exact-path-written'"],
      ]);
      const result = validateImports(files);
      expect(result.issues[0]?.importPath).toBe("./exact-path-written");
    });
  });

  describe("ContractValidationResult structure", () => {
    it("result always has valid, issues, endpoints, calls fields", () => {
      const result = validateContracts({}, {});
      expect(result).toHaveProperty("valid");
      expect(result).toHaveProperty("issues");
      expect(result).toHaveProperty("endpoints");
      expect(result).toHaveProperty("calls");
    });

    it("endpoints and calls are arrays", () => {
      const result = validateContracts({}, {});
      expect(Array.isArray(result.endpoints)).toBe(true);
      expect(Array.isArray(result.calls)).toBe(true);
    });

    it("ContractIssue has type, description, file, line fields", () => {
      const backend = {
        "api/x.ts": "router.get('/x', handler)",
      };
      const frontend = {
        "ui/x.ts": "axios.post('/x')",
      };
      const result = validateContracts(backend, frontend);
      const issue = result.issues[0]!;
      expect(issue).toHaveProperty("type");
      expect(issue).toHaveProperty("description");
      expect(issue).toHaveProperty("file");
      expect(issue).toHaveProperty("line");
    });

    it("issue.type is one of: unmatched-call, unmatched-endpoint, method-mismatch", () => {
      const backend = {
        "api/y.ts": "router.get('/y', handler)",
      };
      const frontend = {
        "ui/y.ts": "axios.post('/y')",
      };
      const result = validateContracts(backend, frontend);
      const validTypes = [
        "unmatched-call",
        "unmatched-endpoint",
        "method-mismatch",
      ];
      expect(validTypes).toContain(result.issues[0]?.type);
    });

    it("issue.description is a non-empty string", () => {
      const backend = {};
      const frontend = {
        "ui/z.ts": "axios.get('/z')",
      };
      const result = validateContracts(backend, frontend);
      expect(typeof result.issues[0]?.description).toBe("string");
      expect(result.issues[0]!.description.length).toBeGreaterThan(0);
    });

    it("issue.line is a number ≥ 1 for API call issues", () => {
      const backend = {};
      const frontend = {
        "ui/z.ts": "axios.get('/z')",
      };
      const result = validateContracts(backend, frontend);
      expect(result.issues[0]!.line).toBeGreaterThanOrEqual(1);
    });

    it("issue.file matches the source frontend file", () => {
      const backend = {};
      const frontend = {
        "ui/specific-file.ts": "axios.get('/nowhere')",
      };
      const result = validateContracts(backend, frontend);
      expect(result.issues[0]?.file).toBe("ui/specific-file.ts");
    });

    it("description mentions HTTP method and path for unmatched-call", () => {
      const backend = {};
      const frontend = {
        "ui/api.ts": "axios.delete('/resource/123')",
      };
      const result = validateContracts(backend, frontend);
      const issue = result.issues[0]!;
      expect(issue.description).toMatch(/DELETE/i);
      expect(issue.description).toContain("/resource/123");
    });

    it("description for method-mismatch mentions available method", () => {
      const backend = {
        "api/res.ts": "router.put('/resource', handler)",
      };
      const frontend = {
        "ui/res.ts": "axios.patch('/resource')",
      };
      const result = validateContracts(backend, frontend);
      const issue = result.issues.find((i) => i.type === "method-mismatch")!;
      expect(issue.description).toContain("PUT");
    });
  });

  describe("valid = false conditions", () => {
    it("valid=false when any unmatched-call exists", () => {
      const result = validateContracts({}, { "ui.ts": "axios.get('/x')" });
      expect(result.valid).toBe(false);
    });

    it("valid=false when any method-mismatch exists", () => {
      const backend = { "api.ts": "router.post('/x', h)" };
      const frontend = { "ui.ts": "axios.get('/x')" };
      const result = validateContracts(backend, frontend);
      expect(result.valid).toBe(false);
    });

    it("valid=true even when unmatched-endpoint exists (informational only)", () => {
      const backend = { "api.ts": "router.get('/unused', h)" };
      const frontend = {};
      const result = validateContracts(backend, frontend);
      expect(result.valid).toBe(true);
    });
  });
});

// ─── 12. Interface implementation checks ─────────────────────────────────────

describe("Interface implementation coherence (structural via import graph)", () => {
  it("implementation imports interface from correct location → valid", () => {
    const files = new Map([
      [
        "src/interfaces/repository.ts",
        "export interface IRepository<T> { findById(id: string): Promise<T> }",
      ],
      [
        "src/impl/user-repository.ts",
        "import type { IRepository } from '../interfaces/repository'",
      ],
      [
        "src/impl/product-repository.ts",
        "import type { IRepository } from '../interfaces/repository'",
      ],
    ]);
    expect(validateImports(files).valid).toBe(true);
  });

  it("implementation imports from non-existent interface file → unresolved", () => {
    const files = new Map([
      [
        "src/impl/user-repository.ts",
        "import type { IRepository } from '../interfaces/repository'",
      ],
      // interfaces/repository.ts missing
    ]);
    const result = validateImports(files);
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.issue).toBe("unresolved");
  });

  it("multiple implementations of shared interface: all import cleanly", () => {
    const files = new Map([
      [
        "src/contracts/service.ts",
        "export interface IService { execute(): void }",
      ],
      [
        "src/impl/email-service.ts",
        "import { IService } from '../contracts/service'",
      ],
      [
        "src/impl/sms-service.ts",
        "import { IService } from '../contracts/service'",
      ],
      [
        "src/impl/push-service.ts",
        "import { IService } from '../contracts/service'",
      ],
    ]);
    expect(validateImports(files).valid).toBe(true);
  });

  it("contract moved: old import paths become unresolved", () => {
    const files = new Map([
      // interface moved from 'contracts/v1/service' to 'contracts/v2/service'
      [
        "src/contracts/v2/service.ts",
        "export interface IService { execute(): void }",
      ],
      ["src/impl/a.ts", "import { IService } from '../contracts/v1/service'"],
      // contracts/v1/service is gone
    ]);
    const result = validateImports(files);
    expect(result.valid).toBe(false);
  });
});

// ─── 13. Large-scale coherence: 15+ file sets ────────────────────────────────

describe("Large-scale multi-file coherence", () => {
  it("15-file import graph: all resolving → valid", () => {
    const files = new Map<string, string>();
    files.set("src/base.ts", "export const base = true");
    for (let i = 1; i <= 14; i++) {
      files.set(
        `src/module-${i}.ts`,
        `import { base } from './base'\nexport const m${i} = base`
      );
    }
    expect(validateImports(files).valid).toBe(true);
  });

  it("15-file graph: one missing → exactly one issue", () => {
    const files = new Map<string, string>();
    files.set("src/base.ts", "export const base = true");
    for (let i = 1; i <= 13; i++) {
      files.set(`src/module-${i}.ts`, `import { base } from './base'`);
    }
    // module-14 imports a missing file
    files.set("src/module-14.ts", "import { gone } from './gone-module'");
    const result = validateImports(files);
    expect(result.issues.filter((i) => i.issue === "unresolved")).toHaveLength(
      1
    );
  });

  it("20 backend endpoints × 20 frontend calls all matched → valid", () => {
    const backend: Record<string, string> = {};
    const frontend: Record<string, string> = {};
    for (let i = 1; i <= 20; i++) {
      backend[`api/route-${i}.ts`] = `router.get('/resource-${i}', handler)`;
      frontend[`ui/caller-${i}.ts`] = `axios.get('/resource-${i}')`;
    }
    const result = validateContracts(backend, frontend);
    expect(result.valid).toBe(true);
    expect(result.endpoints).toHaveLength(20);
    expect(result.calls).toHaveLength(20);
  });

  it("20 backend endpoints: 1 path drift → exactly 1 unmatched-call", () => {
    const backend: Record<string, string> = {};
    const frontend: Record<string, string> = {};
    for (let i = 1; i <= 19; i++) {
      backend[`api/route-${i}.ts`] = `router.get('/resource-${i}', handler)`;
      frontend[`ui/caller-${i}.ts`] = `axios.get('/resource-${i}')`;
    }
    // drifted: frontend calls /resource-20-old but backend has /resource-20-new
    backend["api/route-20.ts"] = "router.get('/resource-20-new', handler)";
    frontend["ui/caller-20.ts"] = "axios.get('/resource-20-old')";

    const result = validateContracts(backend, frontend);
    expect(result.valid).toBe(false);
    expect(
      result.issues.filter((i) => i.type === "unmatched-call")
    ).toHaveLength(1);
  });
});

// ─── 14. Record vs Map API parity ────────────────────────────────────────────

describe("Record vs Map API parity for validateImports", () => {
  it("Record input produces same result as Map input for valid graph", () => {
    const record: Record<string, string> = {
      "src/a.ts": "import { x } from './b'",
      "src/b.ts": "export const x = 1",
    };
    const mapInput = new Map(Object.entries(record));
    const resultRecord = validateImports(record);
    const resultMap = validateImports(mapInput);
    expect(resultRecord.valid).toBe(resultMap.valid);
    expect(resultRecord.issues.length).toBe(resultMap.issues.length);
  });

  it("Record input produces same result as Map input for broken graph", () => {
    const record: Record<string, string> = {
      "src/a.ts": "import { x } from './missing'",
    };
    const mapInput = new Map(Object.entries(record));
    const resultRecord = validateImports(record);
    const resultMap = validateImports(mapInput);
    expect(resultRecord.valid).toBe(false);
    expect(resultMap.valid).toBe(false);
    expect(resultRecord.issues[0]?.importPath).toBe(
      resultMap.issues[0]?.importPath
    );
  });
});

// ─── 15. Edge cases not in existing tests ────────────────────────────────────

describe("Edge cases (coherence supplement)", () => {
  it("empty Map → valid=true, no issues", () => {
    expect(validateImports(new Map()).valid).toBe(true);
    expect(validateImports(new Map()).issues).toHaveLength(0);
  });

  it("empty Record → valid=true, no issues", () => {
    expect(validateImports({}).valid).toBe(true);
  });

  it("file with only non-relative imports → valid (only relative imports checked)", () => {
    const files = new Map([
      [
        "src/app.ts",
        "import { express } from 'express'\nimport { z } from 'zod'",
      ],
    ]);
    expect(validateImports(files).valid).toBe(true);
  });

  it("import with rootDir prefix: rootDir affects resolution", () => {
    // Single file at top level importing sibling
    const files = new Map([
      ["index.ts", "import { x } from './lib'"],
      ["lib.ts", "export const x = 1"],
    ]);
    expect(validateImports(files, "").valid).toBe(true);
  });

  it("validateContracts: empty backend and frontend → valid=true, empty arrays", () => {
    const result = validateContracts({}, {});
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.endpoints).toHaveLength(0);
    expect(result.calls).toHaveLength(0);
  });

  it("validateContracts: multiple methods on same path — each matched independently", () => {
    const backend = {
      "api/users.ts": [
        "router.get('/users', listUsers)",
        "router.post('/users', createUser)",
        "router.delete('/users', deleteUsers)",
      ].join("\n"),
    };
    const frontend = {
      "ui/users.ts": [
        "axios.get('/users')",
        "axios.post('/users')",
        "axios.delete('/users')",
      ].join("\n"),
    };
    const result = validateContracts(backend, frontend);
    expect(result.valid).toBe(true);
    expect(result.endpoints).toHaveLength(3);
    expect(result.calls).toHaveLength(3);
  });

  it("extractEndpoints returns all endpoints from multi-file backend", () => {
    const backend = {
      "api/users.ts": "router.get('/users', h)",
      "api/orders.ts": "router.post('/orders', h)",
      "api/products.ts": "router.put('/products/:id', h)",
    };
    const endpoints = extractEndpoints(backend);
    expect(endpoints).toHaveLength(3);
    expect(endpoints.map((e) => e.method).sort()).toEqual([
      "GET",
      "POST",
      "PUT",
    ]);
  });

  it("extractAPICalls: fetch without method defaults to GET", () => {
    const frontend = {
      "ui/fetch.ts": "fetch('/api/data')",
    };
    const calls = extractAPICalls(frontend);
    expect(calls[0]?.method).toBe("GET");
  });

  it("extractAPICalls: fetch with explicit POST method", () => {
    const frontend = {
      "ui/fetch.ts": "fetch('/api/data', { method: 'POST' })",
    };
    const calls = extractAPICalls(frontend);
    expect(calls[0]?.method).toBe("POST");
  });
});
