/**
 * symbol-rename.test.ts
 *
 * Comprehensive tests for symbol rename refactoring in @dzupagent/codegen.
 *
 * Coverage areas:
 *  1. Single-file rename — function renamed in same file
 *  2. Import rename — renamed symbol updated in importing file
 *  3. Export rename — renamed export updated in barrel file
 *  4. Multi-file rename — rename propagates to all referencing files
 *  5. String literal preservation — rename does NOT touch string literals
 *  6. Comment preservation — rename does NOT touch comments
 *  7. Type annotation rename — type references updated alongside value refs
 *  8. Interface rename — interface renamed, implementing classes updated
 *  9. Class rename — class renamed, all instantiations updated
 * 10. Variable rename — variable renamed, all usages updated
 * 11. Alias import — `import { foo as bar }` — renaming foo updates source
 * 12. Re-export rename — re-exported symbol renamed at source, barrel updated
 * 13. Destructuring — `const { foo } = obj` rename behaviour
 * 14. No-op rename — rename to same name → no changes
 * 15. Rename collision — new name already exists → RenameCollisionError
 * 16. Rename report — result includes files changed and per-file count
 * 17. renameSymbol paths option — restrict rename to specified files
 * 18. Template literal preservation — name inside `` ` `` not renamed
 * 19. Partial-word preservation — substrings of the name not renamed
 * 20. Edge cases — empty file, single occurrence, identifier at line start
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  renameSymbol,
  RenameCollisionError,
  type RenameResult,
} from "../refactor/symbol-rename.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFiles(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

// ---------------------------------------------------------------------------
// 1. Single-file rename: function renamed in same file
// ---------------------------------------------------------------------------

describe("single-file rename — function", () => {
  it("renames a function declaration", () => {
    const files = makeFiles({
      "src/utils.ts":
        "export function computeTotal(a: number, b: number) {\n  return a + b;\n}\n",
    });

    const { updatedFiles, result } = renameSymbol(
      files,
      "computeTotal",
      "calculateSum"
    );
    expect(updatedFiles.get("src/utils.ts")).toContain("function calculateSum");
    expect(updatedFiles.get("src/utils.ts")).not.toContain("computeTotal");
    expect(result.filesChanged).toBe(1);
  });

  it("renames all call sites within the same file", () => {
    const files = makeFiles({
      "src/math.ts": [
        "function add(a: number, b: number) { return a + b; }",
        "const result1 = add(1, 2);",
        "const result2 = add(3, 4);",
        "export { add };",
      ].join("\n"),
    });

    const { updatedFiles } = renameSymbol(files, "add", "sum");
    const content = updatedFiles.get("src/math.ts")!;
    expect(content).toContain("function sum(");
    expect(content).toContain("sum(1, 2)");
    expect(content).toContain("sum(3, 4)");
    expect(content).toContain("{ sum }");
    expect(content).not.toContain("add");
  });

  it("counts replacements correctly per file", () => {
    const files = makeFiles({
      "src/a.ts": "const foo = 1;\nconst bar = foo + foo;\nexport { foo };\n",
    });

    const { result } = renameSymbol(files, "foo", "baz");
    expect(result.changes[0]?.count).toBe(4); // declaration + 2 uses + export
  });
});

// ---------------------------------------------------------------------------
// 2. Import rename: renamed symbol updated in importing file
// ---------------------------------------------------------------------------

describe("import rename — named import updated", () => {
  it("updates the imported name in an import statement", () => {
    const files = makeFiles({
      "src/utils.ts": "export function fetchUser(id: string) { return id; }\n",
      "src/app.ts":
        "import { fetchUser } from './utils';\nconst u = fetchUser('1');\n",
    });

    const { updatedFiles } = renameSymbol(files, "fetchUser", "getUser");
    expect(updatedFiles.get("src/utils.ts")).toContain("function getUser");
    expect(updatedFiles.get("src/app.ts")).toContain("import { getUser }");
    expect(updatedFiles.get("src/app.ts")).toContain("getUser('1')");
  });

  it("leaves unrelated imports untouched", () => {
    const files = makeFiles({
      "src/lib.ts": "export const alpha = 1;\nexport const beta = 2;\n",
      "src/consumer.ts":
        "import { alpha, beta } from './lib';\nconsole.log(alpha, beta);\n",
    });

    const { updatedFiles } = renameSymbol(files, "alpha", "gamma");
    const consumer = updatedFiles.get("src/consumer.ts")!;
    expect(consumer).toContain("gamma");
    expect(consumer).toContain("beta"); // beta unchanged
    expect(consumer).not.toContain("alpha");
  });

  it("handles default import rename", () => {
    const files = makeFiles({
      "src/logger.ts":
        "export default function logger(msg: string) { console.log(msg); }\n",
      "src/main.ts": "import logger from './logger';\nlogger('hello');\n",
    });

    const { updatedFiles } = renameSymbol(files, "logger", "log");
    expect(updatedFiles.get("src/logger.ts")).toContain("function log(");
    expect(updatedFiles.get("src/main.ts")).toContain("import log from");
    expect(updatedFiles.get("src/main.ts")).toContain("log('hello')");
  });
});

// ---------------------------------------------------------------------------
// 3. Export rename: renamed export updated in barrel file
// ---------------------------------------------------------------------------

describe("export rename — barrel file updated", () => {
  it("updates re-export in barrel index", () => {
    const files = makeFiles({
      "src/services/userService.ts":
        "export function createUser(name: string) { return name; }\n",
      "src/services/index.ts": "export { createUser } from './userService';\n",
    });

    const { updatedFiles } = renameSymbol(files, "createUser", "makeUser");
    expect(updatedFiles.get("src/services/userService.ts")).toContain(
      "function makeUser"
    );
    expect(updatedFiles.get("src/services/index.ts")).toContain("makeUser");
    expect(updatedFiles.get("src/services/index.ts")).not.toContain(
      "createUser"
    );
  });

  it("updates named export list", () => {
    const files = makeFiles({
      "src/index.ts": "export { processData, validateData } from './data';\n",
      "src/data.ts":
        "export function processData(x: unknown) { return x; }\nexport function validateData(x: unknown) { return !!x; }\n",
    });

    const { updatedFiles } = renameSymbol(
      files,
      "processData",
      "transformData"
    );
    const barrel = updatedFiles.get("src/index.ts")!;
    expect(barrel).toContain("transformData");
    expect(barrel).toContain("validateData"); // unchanged
    expect(barrel).not.toContain("processData");
  });
});

// ---------------------------------------------------------------------------
// 4. Multi-file rename: rename propagates to all referencing files
// ---------------------------------------------------------------------------

describe("multi-file rename — propagates to all files", () => {
  it("renames across three files", () => {
    const files = makeFiles({
      "src/api.ts": "export function fetchData() { return []; }\n",
      "src/view.ts": "import { fetchData } from './api';\nfetchData();\n",
      "src/test.ts":
        "import { fetchData } from './api';\nconst d = fetchData();\n",
    });

    const { updatedFiles, result } = renameSymbol(
      files,
      "fetchData",
      "loadData"
    );
    expect(updatedFiles.get("src/api.ts")).toContain("function loadData");
    expect(updatedFiles.get("src/view.ts")).toContain("loadData");
    expect(updatedFiles.get("src/test.ts")).toContain("loadData");
    expect(result.filesChanged).toBe(3);
  });

  it("report contains an entry for every changed file", () => {
    const files = makeFiles({
      "a.ts": "export const myVar = 1;\n",
      "b.ts": "import { myVar } from './a';\nconsole.log(myVar);\n",
      "c.ts": "import { myVar } from './a';\nreturn myVar;\n",
      "d.ts": "export const unrelated = 42;\n",
    });

    const { result } = renameSymbol(files, "myVar", "myVariable");
    const changedPaths = result.changes.map((c) => c.path).sort();
    expect(changedPaths).toEqual(["a.ts", "b.ts", "c.ts"]);
    // d.ts has no reference and must NOT appear in the report
    expect(changedPaths).not.toContain("d.ts");
  });

  it("does not modify files that do not reference the symbol", () => {
    const files = makeFiles({
      "src/widget.ts": "export class Widget { render() {} }\n",
      "src/other.ts": 'export const UNRELATED = "hello";\n',
    });

    const { updatedFiles } = renameSymbol(files, "Widget", "Component");
    expect(updatedFiles.get("src/other.ts")).toBe(files.get("src/other.ts"));
  });
});

// ---------------------------------------------------------------------------
// 5. String literal preservation
// ---------------------------------------------------------------------------

describe("string literal preservation", () => {
  it("does not rename inside double-quoted strings", () => {
    const files = makeFiles({
      "src/config.ts":
        'const name = "processData";\nexport function processData() {}\n',
    });

    const { updatedFiles } = renameSymbol(files, "processData", "handleData");
    const content = updatedFiles.get("src/config.ts")!;
    expect(content).toContain('"processData"'); // string literal preserved
    expect(content).toContain("function handleData"); // declaration renamed
  });

  it("does not rename inside single-quoted strings", () => {
    const files = makeFiles({
      "src/routes.ts":
        "const route = '/processData';\nexport function processData() {}\n",
    });

    const { updatedFiles } = renameSymbol(files, "processData", "handleData");
    const content = updatedFiles.get("src/routes.ts")!;
    expect(content).toContain("'/processData'");
    expect(content).toContain("function handleData");
  });

  it("does not rename a string that exactly matches the symbol name", () => {
    const files = makeFiles({
      "src/registry.ts":
        'const key = "myFunc";\nexport function myFunc() { return key; }\n',
    });

    const { updatedFiles } = renameSymbol(files, "myFunc", "ourFunc");
    const content = updatedFiles.get("src/registry.ts")!;
    expect(content).toContain('"myFunc"');
    expect(content).not.toContain('"ourFunc"'); // string not renamed
    expect(content).toContain("function ourFunc"); // code renamed
  });
});

// ---------------------------------------------------------------------------
// 6. Comment preservation
// ---------------------------------------------------------------------------

describe("comment preservation", () => {
  it("does not rename inside line comments", () => {
    const files = makeFiles({
      "src/math.ts":
        "// computeTotal is deprecated\nexport function computeTotal(a: number) { return a; }\n",
    });

    const { updatedFiles } = renameSymbol(files, "computeTotal", "calcTotal");
    const content = updatedFiles.get("src/math.ts")!;
    expect(content).toContain("// computeTotal is deprecated");
    expect(content).toContain("function calcTotal(");
  });

  it("does not rename inside block comments", () => {
    const files = makeFiles({
      "src/api.ts":
        "/**\n * @deprecated Use fetchUser instead of loadUser\n */\nexport function loadUser(id: string) { return id; }\n",
    });

    const { updatedFiles } = renameSymbol(files, "loadUser", "getUser");
    const content = updatedFiles.get("src/api.ts")!;
    expect(content).toContain("Use fetchUser instead of loadUser");
    expect(content).toContain("function getUser(");
  });

  it("does not rename inside JSDoc @param tags", () => {
    const files = makeFiles({
      "src/helpers.ts":
        [
          "/**",
          " * @param processItem - the item processor",
          " */",
          "export function processItem(item: unknown) { return item; }",
        ].join("\n") + "\n",
    });

    const { updatedFiles } = renameSymbol(files, "processItem", "handleItem");
    const content = updatedFiles.get("src/helpers.ts")!;
    expect(content).toContain("@param processItem");
    expect(content).toContain("function handleItem(");
  });
});

// ---------------------------------------------------------------------------
// 7. Type annotation rename
// ---------------------------------------------------------------------------

describe("type annotation rename", () => {
  it("renames a type alias and all its usages", () => {
    const files = makeFiles({
      "src/types.ts":
        "export type UserRecord = { id: string; name: string };\n",
      "src/service.ts":
        "import type { UserRecord } from './types';\nfunction getUser(): UserRecord { return { id: '1', name: 'Alice' }; }\n",
    });

    const { updatedFiles } = renameSymbol(files, "UserRecord", "UserModel");
    expect(updatedFiles.get("src/types.ts")).toContain("type UserModel");
    const svc = updatedFiles.get("src/service.ts")!;
    expect(svc).toContain("{ UserModel }");
    expect(svc).toContain("getUser(): UserModel");
    expect(svc).not.toContain("UserRecord");
  });

  it("renames a generic type parameter reference", () => {
    const files = makeFiles({
      "src/container.ts":
        "export type Container<T> = { value: T };\nexport type StringContainer = Container<string>;\n",
      "src/usage.ts":
        "import { StringContainer } from './container';\nconst c: StringContainer = { value: 'hello' };\n",
    });

    const { updatedFiles } = renameSymbol(
      files,
      "StringContainer",
      "TextContainer"
    );
    expect(updatedFiles.get("src/container.ts")).toContain("TextContainer");
    expect(updatedFiles.get("src/usage.ts")).toContain("TextContainer");
  });
});

// ---------------------------------------------------------------------------
// 8. Interface rename
// ---------------------------------------------------------------------------

describe("interface rename", () => {
  it("renames an interface and all implementing classes", () => {
    const files = makeFiles({
      "src/contracts.ts":
        "export interface IRepository<T> { findById(id: string): T; }\n",
      "src/user-repo.ts":
        "import { IRepository } from './contracts';\nexport class UserRepo implements IRepository<User> { findById(id: string): User { return {} as User; } }\n",
    });

    const { updatedFiles } = renameSymbol(files, "IRepository", "IStore");
    expect(updatedFiles.get("src/contracts.ts")).toContain("interface IStore");
    const repo = updatedFiles.get("src/user-repo.ts")!;
    expect(repo).toContain("IStore");
    expect(repo).toContain("implements IStore");
    expect(repo).not.toContain("IRepository");
  });

  it("renames interface used as type annotation in function signatures", () => {
    const files = makeFiles({
      "src/types.ts": "export interface Config { debug: boolean; }\n",
      "src/factory.ts":
        "import { Config } from './types';\nexport function createApp(config: Config): void { console.log(config.debug); }\n",
    });

    const { updatedFiles } = renameSymbol(files, "Config", "AppConfig");
    const factory = updatedFiles.get("src/factory.ts")!;
    expect(factory).toContain("config: AppConfig");
    // "Config" no longer appears as a standalone identifier — only as part of AppConfig
    expect(factory).not.toMatch(/(?<![A-Za-z])Config(?!Config)/);
    expect(factory).toContain("import { AppConfig }");
  });
});

// ---------------------------------------------------------------------------
// 9. Class rename
// ---------------------------------------------------------------------------

describe("class rename", () => {
  it("renames a class and all instantiations", () => {
    const files = makeFiles({
      "src/database.ts": "export class DatabaseConnection { connect() {} }\n",
      "src/app.ts":
        "import { DatabaseConnection } from './database';\nconst db = new DatabaseConnection();\ndb.connect();\n",
    });

    const { updatedFiles } = renameSymbol(
      files,
      "DatabaseConnection",
      "DbConnection"
    );
    expect(updatedFiles.get("src/database.ts")).toContain("class DbConnection");
    const app = updatedFiles.get("src/app.ts")!;
    expect(app).toContain("new DbConnection()");
    expect(app).not.toContain("DatabaseConnection");
  });

  it("renames class used in extends clause", () => {
    const files = makeFiles({
      "src/base.ts": "export class BaseService { init() {} }\n",
      "src/user-service.ts":
        "import { BaseService } from './base';\nexport class UserService extends BaseService { getUser() {} }\n",
    });

    const { updatedFiles } = renameSymbol(files, "BaseService", "CoreService");
    expect(updatedFiles.get("src/base.ts")).toContain("class CoreService");
    expect(updatedFiles.get("src/user-service.ts")).toContain(
      "extends CoreService"
    );
  });

  it("renames class used as a type (typeof)", () => {
    const files = makeFiles({
      "src/client.ts":
        "export class ApiClient { get(url: string) { return url; } }\n",
      "src/factory.ts":
        "import { ApiClient } from './client';\nfunction make(): ApiClient { return new ApiClient(); }\n",
    });

    const { updatedFiles } = renameSymbol(files, "ApiClient", "HttpClient");
    const factory = updatedFiles.get("src/factory.ts")!;
    expect(factory).toContain("make(): HttpClient");
    expect(factory).toContain("new HttpClient()");
  });
});

// ---------------------------------------------------------------------------
// 10. Variable rename
// ---------------------------------------------------------------------------

describe("variable rename", () => {
  it("renames a const variable and all usages", () => {
    const files = makeFiles({
      "src/constants.ts": "export const MAX_RETRIES = 3;\n",
      "src/service.ts":
        "import { MAX_RETRIES } from './constants';\nfor (let i = 0; i < MAX_RETRIES; i++) {}\n",
    });

    const { updatedFiles } = renameSymbol(files, "MAX_RETRIES", "RETRY_LIMIT");
    expect(updatedFiles.get("src/constants.ts")).toContain("RETRY_LIMIT");
    const svc = updatedFiles.get("src/service.ts")!;
    expect(svc).toContain("RETRY_LIMIT");
    expect(svc).not.toContain("MAX_RETRIES");
  });

  it("renames exported let variable", () => {
    const files = makeFiles({
      "src/state.ts": "export let currentUser: string | null = null;\n",
      "src/auth.ts":
        "import { currentUser } from './state';\nif (currentUser) console.log(currentUser);\n",
    });

    const { updatedFiles } = renameSymbol(files, "currentUser", "activeUser");
    expect(updatedFiles.get("src/state.ts")).toContain("activeUser");
    const auth = updatedFiles.get("src/auth.ts")!;
    expect(auth).toContain("activeUser");
    expect(auth).not.toContain("currentUser");
  });
});

// ---------------------------------------------------------------------------
// 11. Alias import: import { foo as bar } — renaming foo does not rename alias
// ---------------------------------------------------------------------------

describe("alias import — source name updated, alias preserved", () => {
  it("updates the source name inside curly braces, not the alias", () => {
    const files = makeFiles({
      "src/math.ts": "export function compute(x: number) { return x * 2; }\n",
      "src/consumer.ts":
        "import { compute as calc } from './math';\nconst r = calc(5);\n",
    });

    const { updatedFiles } = renameSymbol(files, "compute", "transform");
    // Source is renamed
    expect(updatedFiles.get("src/math.ts")).toContain("function transform(");
    // In consumer the imported name should be updated; alias stays the same
    const consumer = updatedFiles.get("src/consumer.ts")!;
    expect(consumer).toContain("transform as calc");
    expect(consumer).toContain("calc(5)"); // alias usage unchanged
    expect(consumer).not.toContain("compute");
  });

  it("does not rename the local alias when it happens to share the old name", () => {
    const files = makeFiles({
      "src/lib.ts": "export function alpha() {}\n",
      // alias is "alpha" — same as old name; the alias side should NOT be renamed
      "src/usage.ts": "import { alpha as alpha } from './lib';\nalpha();\n",
    });

    // We rename the symbol "alpha" → "beta"
    // Result: import { beta as alpha } and alpha() call site stays as-is
    // because the alias "alpha" is now a local binding, not the exported symbol.
    const { updatedFiles } = renameSymbol(files, "alpha", "beta");
    expect(updatedFiles.get("src/lib.ts")).toContain("function beta()");
    // The import statement renames the source binding
    const usage = updatedFiles.get("src/usage.ts")!;
    expect(usage).toContain("beta");
  });
});

// ---------------------------------------------------------------------------
// 12. Re-export rename
// ---------------------------------------------------------------------------

describe("re-export rename", () => {
  it("updates wildcard re-export barrel when source symbol renamed", () => {
    const files = makeFiles({
      "src/validators.ts":
        "export function isEmail(s: string) { return s.includes('@'); }\n",
      "src/index.ts": "export * from './validators';\n",
      "src/app.ts":
        "import { isEmail } from './index';\nisEmail('test@example.com');\n",
    });

    const { updatedFiles } = renameSymbol(files, "isEmail", "validateEmail");
    expect(updatedFiles.get("src/validators.ts")).toContain(
      "function validateEmail"
    );
    // Barrel uses `export *` so the new name flows through automatically;
    // the app import site must be updated
    expect(updatedFiles.get("src/app.ts")).toContain("validateEmail");
    expect(updatedFiles.get("src/app.ts")).not.toContain("isEmail");
  });

  it("updates named re-export that matches old name", () => {
    const files = makeFiles({
      "src/core.ts":
        "export function parseQuery(sql: string) { return sql; }\n",
      "src/public-api.ts": "export { parseQuery } from './core';\n",
    });

    const { updatedFiles } = renameSymbol(files, "parseQuery", "parseSQL");
    expect(updatedFiles.get("src/public-api.ts")).toContain("parseSQL");
    expect(updatedFiles.get("src/public-api.ts")).not.toContain("parseQuery");
  });
});

// ---------------------------------------------------------------------------
// 13. Destructuring
// ---------------------------------------------------------------------------

describe("destructuring rename", () => {
  it("renames destructured property matching old name", () => {
    // When `count` is a property on an object AND an exported symbol,
    // a rename of `count` updates object-key destructuring of that symbol.
    const files = makeFiles({
      "src/store.ts": "export const count = 0;\n",
      "src/view.ts":
        "import { count } from './store';\nconst { count: localCount } = { count };\nconsole.log(count, localCount);\n",
    });

    const { updatedFiles } = renameSymbol(files, "count", "total");
    const view = updatedFiles.get("src/view.ts")!;
    expect(view).toContain("total"); // import and usage renamed
    expect(view).toContain("localCount"); // local alias unchanged
  });

  it("renames array-destructuring variable", () => {
    const files = makeFiles({
      "src/pair.ts": "export const firstItem = 'a';\n",
      "src/consumer.ts":
        "import { firstItem } from './pair';\nconst [x, y] = [firstItem, 'b'];\n",
    });

    const { updatedFiles } = renameSymbol(files, "firstItem", "headItem");
    expect(updatedFiles.get("src/consumer.ts")).toContain("headItem");
    expect(updatedFiles.get("src/consumer.ts")).not.toContain("firstItem");
  });
});

// ---------------------------------------------------------------------------
// 14. No-op rename: rename to same name → zero changes
// ---------------------------------------------------------------------------

describe("no-op rename — same old and new name", () => {
  it("returns filesChanged = 0 when old === new", () => {
    const files = makeFiles({
      "src/utils.ts": "export function doWork() {}\n",
      "src/app.ts": "import { doWork } from './utils';\ndoWork();\n",
    });

    const { updatedFiles, result } = renameSymbol(files, "doWork", "doWork");
    expect(result.filesChanged).toBe(0);
    expect(result.changes).toHaveLength(0);
    // File contents must be identical
    expect(updatedFiles.get("src/utils.ts")).toBe(files.get("src/utils.ts"));
    expect(updatedFiles.get("src/app.ts")).toBe(files.get("src/app.ts"));
  });

  it("returns unchanged files map reference values when no-op", () => {
    const files = makeFiles({ "a.ts": "const x = 1;\n" });
    const { result } = renameSymbol(files, "x", "x");
    expect(result.filesChanged).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 15. Rename collision: new name already exists → RenameCollisionError
// ---------------------------------------------------------------------------

describe("rename collision detection", () => {
  it("throws RenameCollisionError when newName is already declared in the same file", () => {
    const files = makeFiles({
      "src/math.ts":
        [
          "export function oldFn(x: number) { return x; }",
          "export function newFn(x: number) { return x * 2; }",
        ].join("\n") + "\n",
    });

    expect(() => renameSymbol(files, "oldFn", "newFn")).toThrowError(
      RenameCollisionError
    );
  });

  it("error message identifies the new name and file", () => {
    const files = makeFiles({
      "src/service.ts":
        "export class OldService {}\nexport class NewService {}\n",
    });

    let caught: RenameCollisionError | null = null;
    try {
      renameSymbol(files, "OldService", "NewService");
    } catch (e) {
      caught = e as RenameCollisionError;
    }

    expect(caught).toBeInstanceOf(RenameCollisionError);
    expect(caught!.newName).toBe("NewService");
    expect(caught!.filePath).toBe("src/service.ts");
    expect(caught!.message).toContain("NewService");
    expect(caught!.message).toContain("src/service.ts");
  });

  it("does NOT throw when newName exists only in a different file that lacks old name", () => {
    const files = makeFiles({
      "src/a.ts": "export function oldFn() {}\n",
      "src/b.ts": "export function newFn() {}\n", // different file, no oldFn
    });

    // Should not throw — b.ts has newFn but no reference to oldFn
    expect(() => renameSymbol(files, "oldFn", "newFn")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 16. Rename report
// ---------------------------------------------------------------------------

describe("rename report — result structure", () => {
  it("report lists all changed files with correct counts", () => {
    const files = makeFiles({
      "src/core.ts": "export const myConst = 1;\n",
      "src/a.ts": "import { myConst } from './core';\nconsole.log(myConst);\n",
      "src/b.ts":
        "import { myConst } from './core';\nreturn myConst + myConst;\n",
    });

    const { result } = renameSymbol(files, "myConst", "MY_CONST");
    expect(result.filesChanged).toBe(3);

    const coreChange = result.changes.find((c) => c.path === "src/core.ts");
    expect(coreChange?.count).toBeGreaterThanOrEqual(1);

    const bChange = result.changes.find((c) => c.path === "src/b.ts");
    expect(bChange?.count).toBeGreaterThanOrEqual(2); // two usages in one line
  });

  it("report has zero changes for a symbol not found anywhere", () => {
    const files = makeFiles({
      "src/utils.ts": "export function doSomething() {}\n",
    });

    const { result } = renameSymbol(files, "nonExistentSymbol", "anotherName");
    expect(result.filesChanged).toBe(0);
    expect(result.changes).toHaveLength(0);
  });

  it("result type satisfies RenameResult interface", () => {
    const files = makeFiles({ "src/x.ts": "const val = 1;\n" });
    const { result } = renameSymbol(files, "val", "value");
    const typed: RenameResult = result;
    expect(typeof typed.filesChanged).toBe("number");
    expect(Array.isArray(typed.changes)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 17. renameSymbol paths option — restrict rename to specified files
// ---------------------------------------------------------------------------

describe("renameSymbol — paths restriction", () => {
  it("restricts rename to specified paths option", () => {
    const files = makeFiles({
      "src/a.ts": "export function helper() {}\n",
      "src/b.ts": "import { helper } from './a';\nhelper();\n",
      "src/c.ts": "import { helper } from './a';\nhelper();\n",
    });

    const { updatedFiles, result } = renameSymbol(files, "helper", "assist", {
      paths: ["src/a.ts", "src/b.ts"],
    });

    expect(result.filesChanged).toBeLessThanOrEqual(2);
    // c.ts was excluded
    expect(updatedFiles.get("src/c.ts")).toBe(files.get("src/c.ts"));
  });
});

// ---------------------------------------------------------------------------
// 18. Template literal preservation
// ---------------------------------------------------------------------------

describe("template literal preservation", () => {
  it("does not rename inside backtick template literals", () => {
    const files = makeFiles({
      "src/messages.ts":
        "export function greet() {}\nconst msg = `Call greet now`;\n",
    });

    const { updatedFiles } = renameSymbol(files, "greet", "hello");
    const content = updatedFiles.get("src/messages.ts")!;
    expect(content).toContain("`Call greet now`"); // template literal untouched
    expect(content).toContain("function hello("); // declaration renamed
  });

  it("does not rename expression inside ${} in template literal", () => {
    const files = makeFiles({
      "src/display.ts":
        'export const label = "foo";\nconst html = `value: ${label}`;\n',
    });

    // In this case `${label}` is code, not a string — it SHOULD be renamed
    // because the tokenizer treats ${...} as code embedded in the template.
    // This test documents the CURRENT behaviour: the identifier inside ${} IS
    // renamed because it is a code expression.
    const { updatedFiles } = renameSymbol(files, "label", "caption");
    const content = updatedFiles.get("src/display.ts")!;
    expect(content).toContain("const caption");
    // The template itself contains the identifier in a ${} expression
    expect(content).toContain("caption");
  });
});

// ---------------------------------------------------------------------------
// 19. Partial-word preservation — substrings not renamed
// ---------------------------------------------------------------------------

describe("partial-word preservation — no substring matches", () => {
  it("does not rename substrings of the old name", () => {
    const files = makeFiles({
      "src/types.ts":
        "export type UserConfig = {};\nexport type SuperUserConfig = {};\n",
    });

    const { updatedFiles } = renameSymbol(files, "UserConfig", "UserSettings");
    const content = updatedFiles.get("src/types.ts")!;
    expect(content).toContain("UserSettings"); // exact match renamed
    expect(content).toContain("SuperUserConfig"); // prefix match not touched
  });

  it("does not rename when old name appears as a suffix", () => {
    const files = makeFiles({
      "src/events.ts":
        "export function onClick() {}\nexport function onRightClick() {}\n",
    });

    const { updatedFiles } = renameSymbol(files, "onClick", "onPress");
    const content = updatedFiles.get("src/events.ts")!;
    expect(content).toContain("function onPress("); // exact match
    expect(content).toContain("function onRightClick("); // suffix not touched
  });

  it("does not rename when old name appears as a prefix", () => {
    const files = makeFiles({
      "src/vars.ts": "export const count = 1;\nexport const counter = 2;\n",
    });

    const { updatedFiles } = renameSymbol(files, "count", "total");
    const content = updatedFiles.get("src/vars.ts")!;
    expect(content).toContain("total"); // renamed
    expect(content).toContain("counter"); // prefix match not renamed
  });
});

// ---------------------------------------------------------------------------
// 20. Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("handles an empty file gracefully", () => {
    const files = makeFiles({
      "src/empty.ts": "",
      "src/other.ts": "export function myFn() {}\n",
    });

    expect(() => renameSymbol(files, "myFn", "ourFn")).not.toThrow();
    const { updatedFiles } = renameSymbol(files, "myFn", "ourFn");
    expect(updatedFiles.get("src/empty.ts")).toBe("");
  });

  it("handles a single occurrence in a single file", () => {
    const files = makeFiles({
      "src/single.ts": "export const MAGIC = 42;\n",
    });

    const { updatedFiles, result } = renameSymbol(files, "MAGIC", "CONSTANT");
    expect(updatedFiles.get("src/single.ts")).toBe(
      "export const CONSTANT = 42;\n"
    );
    expect(result.filesChanged).toBe(1);
    expect(result.changes[0]?.count).toBe(1);
  });

  it("handles identifier at the very start of a file", () => {
    const files = makeFiles({
      "src/start.ts": "myFunc();\n",
    });

    const { updatedFiles } = renameSymbol(files, "myFunc", "ourFunc");
    expect(updatedFiles.get("src/start.ts")).toBe("ourFunc();\n");
  });

  it("handles identifier at the very end of a file (no newline)", () => {
    const files = makeFiles({
      "src/end.ts": "export { myFunc }",
    });

    const { updatedFiles } = renameSymbol(files, "myFunc", "ourFunc");
    expect(updatedFiles.get("src/end.ts")).toBe("export { ourFunc }");
  });

  it("handles a file with only comments", () => {
    const files = makeFiles({
      "src/comments-only.ts":
        "// This is a placeholder for myFunc\n/* myFunc goes here */\n",
      "src/real.ts": "export function myFunc() {}\n",
    });

    const { updatedFiles } = renameSymbol(files, "myFunc", "ourFunc");
    const commentsOnly = updatedFiles.get("src/comments-only.ts")!;
    // Comments must NOT be renamed
    expect(commentsOnly).toContain("myFunc");
    expect(commentsOnly).not.toContain("ourFunc");
    // The real file is renamed
    expect(updatedFiles.get("src/real.ts")).toContain("ourFunc");
  });

  it("produces the same result when called twice with inverse renames", () => {
    const files = makeFiles({
      "src/lib.ts": "export function alpha() { return 1; }\n",
    });

    const { updatedFiles: after1 } = renameSymbol(files, "alpha", "beta");
    const { updatedFiles: after2 } = renameSymbol(after1, "beta", "alpha");
    expect(after2.get("src/lib.ts")).toBe(files.get("src/lib.ts"));
  });

  it("handles multiple symbols renamed sequentially", () => {
    let files = makeFiles({
      "src/constants.ts": "export const FOO = 1;\nexport const BAR = 2;\n",
    });

    const { updatedFiles: step1 } = renameSymbol(files, "FOO", "ALPHA");
    const { updatedFiles: step2 } = renameSymbol(step1, "BAR", "BETA");
    const content = step2.get("src/constants.ts")!;
    expect(content).toContain("ALPHA");
    expect(content).toContain("BETA");
    expect(content).not.toContain("FOO");
    expect(content).not.toContain("BAR");
  });
});
