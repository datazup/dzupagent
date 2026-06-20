# Jailed-Fs Path-Escape Guard for MCP Tools — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a path-escape guard to `MCPClient.invokeTool()` that rejects any string argument whose resolved absolute path escapes a configured `filesystemRoot`, preventing a tenant-supplied path like `../../other-tenant/secret` from reaching a filesystem MCP tool handler.

**Architecture:** Two additive changes — (1) a pure `assertPathWithinRoot(path, root)` guard in `mcp-security.ts` using `node:path` `resolve`/`relative`, parallel to `validateMcpExecutablePath`; (2) an optional `filesystemRoot?: string` field in `MCPServerConfig` that `invokeTool()` reads to validate path-typed string args before forwarding them to the tool. Path args are identified by key name (`path`, `filePath`, `file`, `dir`, `root`, `directory`) — the same set that filesystem MCP tools conventionally use. When `filesystemRoot` is absent, the guard is a no-op (backwards compatible). No changes to the tool handler contract.

**Tech Stack:** TypeScript, `node:path` (resolve, relative, isAbsolute), Vitest, `ForgeError`

## Current Status — 2026-06-20

Status: implemented and validated against the current `dzupagent` codebase.

- `assertPathWithinRoot()` and `PATH_ARG_KEYS` are implemented in `packages/core/src/mcp/mcp-security.ts`.
- `MCPServerConfig.filesystemRoot` is implemented in `packages/core/src/mcp/mcp-types.ts`.
- `MCPClient.invokeTool()` validates configured filesystem-root path arguments before dispatching tool calls.
- Tests include both the pure path guard and `MCPClient` integration coverage, including root-prefix escape cases.
- Push steps were not run in this validation pass.

Validation:

- `dzupagent/packages/core`: `node ../../node_modules/vitest/vitest.mjs run src/mcp/__tests__/mcp-security.test.ts src/mcp/__tests__/mcp-client-path-guard.test.ts` passed (51 tests).
- `dzupagent/packages/core`: `node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` passed.

---

## Files

- **Modify:** `packages/core/src/mcp/mcp-security.ts` — add `assertPathWithinRoot()` and `PATH_ARG_KEYS` constant
- **Modify:** `packages/core/src/mcp/mcp-types.ts` — add `filesystemRoot?: string` to `MCPServerConfig`
- **Modify:** `packages/core/src/mcp/mcp-client.ts` — call guard in `invokeTool()` before `executeToolCall()`
- **Modify:** `packages/core/src/mcp/__tests__/mcp-security.test.ts` — add `assertPathWithinRoot` test cases

---

### Task 1: Add `assertPathWithinRoot()` to `mcp-security.ts`

**Files:**

- Modify: `packages/core/src/mcp/mcp-security.ts`
- Modify: `packages/core/src/mcp/__tests__/mcp-security.test.ts`

- [ ] **Step 1: Read current `mcp-security.ts` to understand structure**

Read `packages/core/src/mcp/mcp-security.ts` lines 1-50 to understand imports and existing function pattern.

- [ ] **Step 2: Write failing tests for `assertPathWithinRoot`**

Add a new `describe` block at the end of `packages/core/src/mcp/__tests__/mcp-security.test.ts`:

```typescript
import { resolve } from "node:path";
import { assertPathWithinRoot } from "../mcp-security.js";

describe("assertPathWithinRoot", () => {
  const ROOT = "/workspace/tenant-a";

  it("allows a path directly within the root", () => {
    expect(() => assertPathWithinRoot("src/main.ts", ROOT)).not.toThrow();
  });

  it("allows a deeply nested path within the root", () => {
    expect(() => assertPathWithinRoot("a/b/c/file.txt", ROOT)).not.toThrow();
  });

  it("allows the root itself (empty relative path)", () => {
    expect(() => assertPathWithinRoot(".", ROOT)).not.toThrow();
  });

  it("rejects a relative traversal that escapes the root", () => {
    expect(() => assertPathWithinRoot("../../etc/passwd", ROOT)).toThrow(
      ForgeError
    );
    try {
      assertPathWithinRoot("../../etc/passwd", ROOT);
    } catch (e) {
      expect((e as ForgeError).code).toBe("MCP_PATH_ESCAPE");
    }
  });

  it("rejects an absolute path outside the root", () => {
    expect(() => assertPathWithinRoot("/etc/shadow", ROOT)).toThrow(ForgeError);
    try {
      assertPathWithinRoot("/etc/shadow", ROOT);
    } catch (e) {
      expect((e as ForgeError).code).toBe("MCP_PATH_ESCAPE");
    }
  });

  it("rejects an absolute path for a different tenant root", () => {
    expect(() =>
      assertPathWithinRoot("/workspace/tenant-b/secret.key", ROOT)
    ).toThrow(ForgeError);
  });

  it("allows an absolute path that IS within the root", () => {
    expect(() =>
      assertPathWithinRoot(`${ROOT}/src/index.ts`, ROOT)
    ).not.toThrow();
  });

  it("rejects a path that resolves to exactly the parent of root", () => {
    expect(() => assertPathWithinRoot("..", ROOT)).toThrow(ForgeError);
  });
});
```

Note: `resolve`, `ForgeError`, and `assertPathWithinRoot` must all be imported at the top of the test file. Add the import for `resolve` from `node:path` and `assertPathWithinRoot` from `../mcp-security.js` to the existing imports at the top.

- [ ] **Step 3: Run tests to confirm they fail (function not yet exported)**

```bash
node ../../node_modules/vitest/vitest.mjs run src/mcp/__tests__/mcp-security.test.ts -t "assertPathWithinRoot" 2>&1 | tail -15
```

Expected: FAIL — `assertPathWithinRoot is not a function` or import error.

- [ ] **Step 4: Add `assertPathWithinRoot` to `mcp-security.ts`**

Add at the top of `mcp-security.ts`, after the existing `ForgeError` import:

```typescript
import { resolve, relative, isAbsolute } from "node:path";
```

Then add this function after the existing `sanitizeMcpEnv` export at the bottom of the file:

```typescript
/**
 * Path-like argument key names used by filesystem MCP tools.
 * `invokeTool()` validates any arg whose key is in this set when
 * `MCPServerConfig.filesystemRoot` is configured.
 */
export const PATH_ARG_KEYS: ReadonlySet<string> = new Set([
  "path",
  "filePath",
  "file",
  "dir",
  "root",
  "directory",
]);

/**
 * Assert that `userPath` resolves to a location within `rootDir`.
 *
 * Accepts relative paths (resolved against `rootDir`) and absolute paths
 * that start with `rootDir`. Rejects traversal sequences and any path that
 * resolves outside the root.
 *
 * @throws ForgeError with code `MCP_PATH_ESCAPE` when the path escapes.
 */
export function assertPathWithinRoot(userPath: string, rootDir: string): void {
  const abs = isAbsolute(userPath) ? userPath : resolve(rootDir, userPath);
  const rel = relative(rootDir, abs);
  // rel starts with '..' when abs is outside rootDir, or is absolute when
  // rootDir and abs are on different drives (Windows). Both are escapes.
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new ForgeError({
      code: "MCP_PATH_ESCAPE",
      message: `MCP tool path argument escapes the filesystem root: "${userPath}"`,
      recoverable: false,
      context: { attemptedPath: userPath, filesystemRoot: rootDir },
    });
  }
}
```

- [ ] **Step 5: Run assertPathWithinRoot tests to verify they pass**

```bash
node ../../node_modules/vitest/vitest.mjs run src/mcp/__tests__/mcp-security.test.ts -t "assertPathWithinRoot" 2>&1 | tail -10
```

Expected: all 8 pass.

- [ ] **Step 6: Run full mcp-security test file for regressions**

```bash
node ../../node_modules/vitest/vitest.mjs run src/mcp/__tests__/mcp-security.test.ts 2>&1 | tail -8
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/mcp/mcp-security.ts \
        packages/core/src/mcp/__tests__/mcp-security.test.ts
git commit -m "feat(core/mcp): add assertPathWithinRoot guard + PATH_ARG_KEYS (Tier-4 jailed-fs)"
```

(Check `git status` first — auto-committer may have already committed.)

---

### Task 2: Wire the guard into `MCPClient.invokeTool()`

**Files:**

- Modify: `packages/core/src/mcp/mcp-types.ts` — add `filesystemRoot?: string` to `MCPServerConfig`
- Modify: `packages/core/src/mcp/mcp-client.ts` — call guard before `executeToolCall()`

- [ ] **Step 1: Read `mcp-types.ts` MCPServerConfig and `mcp-client.ts` invokeTool() to understand insertion points**

Read `packages/core/src/mcp/mcp-types.ts` lines 15-42 (MCPServerConfig) and `packages/core/src/mcp/mcp-client.ts` lines 198-250 (invokeTool).

- [ ] **Step 2: Add `filesystemRoot` to `MCPServerConfig` in `mcp-types.ts`**

In the `MCPServerConfig` interface (after the `stdioArgPolicy` field), add:

```typescript
  /**
   * Optional filesystem jail root for this server's tools.
   *
   * When set, any string argument whose key is a known path field
   * (`path`, `filePath`, `file`, `dir`, `root`, `directory`) is validated
   * against this root before the tool is invoked. Paths that resolve outside
   * the root are rejected with `MCP_PATH_ESCAPE`. Leave unset to skip the
   * guard (default, backwards compatible).
   */
  filesystemRoot?: string;
```

- [ ] **Step 3: Write a failing integration test for the path guard in `mcp-client`**

There is no existing `mcp-client` test file. Add path-guard cases to `packages/core/src/mcp/__tests__/mcp-server.test.ts` (or create a focused `mcp-client-path-guard.test.ts`). Create a new file:

`packages/core/src/mcp/__tests__/mcp-client-path-guard.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MCPClient } from "../mcp-client.js";
import type { MCPServerConfig } from "../mcp-types.js";
import { ForgeError } from "../../errors/forge-error.js";

/**
 * Build a minimal MCPClient with one "connected" server that has a
 * tool registered, so invokeTool() reaches the path-guard check.
 */
function makeClient(filesystemRoot?: string): MCPClient {
  const client = new MCPClient();
  const serverConfig: MCPServerConfig = {
    id: "test-fs-server",
    name: "Test FS Server",
    url: "stdio://test",
    transport: "stdio",
    ...(filesystemRoot !== undefined ? { filesystemRoot } : {}),
  };
  // Inject a fake connected server + tool directly into the client internals.
  // MCPClient keeps connections in a private Map — access via cast.
  const connections = (client as unknown as Record<string, unknown>)[
    "connections"
  ] as Map<
    string,
    { state: string; config: MCPServerConfig; tools: unknown[] }
  >;
  connections.set("test-fs-server", {
    state: "connected",
    config: serverConfig,
    tools: [],
  });
  const toolIndex = (client as unknown as Record<string, unknown>)[
    "toolIndex"
  ] as Map<string, { serverId: string; tool: { name: string } }>;
  toolIndex.set("read_file", {
    serverId: "test-fs-server",
    tool: { name: "read_file" },
  });
  return client;
}

describe("MCPClient path-escape guard", () => {
  it("allows a safe relative path when filesystemRoot is configured", async () => {
    const client = makeClient("/workspace/tenant-a");
    // findTool returns a descriptor → guard runs → executeToolCall is called.
    // executeToolCall will fail (no real transport) — we just need the guard not to throw.
    const result = await client.invokeTool("read_file", {
      path: "src/main.ts",
    });
    // Fails because there is no real transport, but not with MCP_PATH_ESCAPE.
    if (result.isError) {
      expect(result.content[0]?.text).not.toContain("MCP_PATH_ESCAPE");
    }
  });

  it("rejects a traversal path when filesystemRoot is configured", async () => {
    const client = makeClient("/workspace/tenant-a");
    const result = await client.invokeTool("read_file", {
      path: "../../etc/passwd",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("MCP_PATH_ESCAPE");
  });

  it("rejects an absolute path outside root when filesystemRoot is configured", async () => {
    const client = makeClient("/workspace/tenant-a");
    const result = await client.invokeTool("read_file", {
      path: "/etc/shadow",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("MCP_PATH_ESCAPE");
  });

  it("does NOT apply the guard when filesystemRoot is not configured", async () => {
    const client = makeClient(); // no filesystemRoot
    // A normally-rejected path is allowed through (guard is inactive).
    const result = await client.invokeTool("read_file", {
      path: "../../etc/passwd",
    });
    // Will fail for transport reasons, not for path-escape.
    if (result.isError) {
      expect(result.content[0]?.text).not.toContain("MCP_PATH_ESCAPE");
    }
  });

  it("does not block non-path argument keys", async () => {
    const client = makeClient("/workspace/tenant-a");
    // 'query' is not a path key — no guard applied even with traversal-like value.
    const result = await client.invokeTool("read_file", {
      query: "../../etc/passwd",
    });
    if (result.isError) {
      expect(result.content[0]?.text).not.toContain("MCP_PATH_ESCAPE");
    }
  });
});
```

- [ ] **Step 4: Run the new tests to verify they fail**

```bash
node ../../node_modules/vitest/vitest.mjs run src/mcp/__tests__/mcp-client-path-guard.test.ts 2>&1 | tail -15
```

Expected: tests 2 and 3 fail (no guard yet).

- [ ] **Step 5: Wire the guard in `mcp-client.ts` `invokeTool()`**

First read `packages/core/src/mcp/mcp-client.ts` to find the import block at the top and the `invokeTool()` method. Then:

1. Add to the imports at the top of `mcp-client.ts`:

```typescript
import { assertPathWithinRoot, PATH_ARG_KEYS } from "./mcp-security.js";
```

2. In `invokeTool()`, after the `conn` connectivity check (after line `if (!conn || conn.state !== 'connected')`) and before the `try { return await this.executeToolCall(...)` block, add:

```typescript
// Jailed-fs guard: reject path args that escape the server's filesystem root.
const { filesystemRoot } = conn.config;
if (filesystemRoot) {
  for (const [key, value] of Object.entries(args)) {
    if (PATH_ARG_KEYS.has(key) && typeof value === "string") {
      try {
        assertPathWithinRoot(value, filesystemRoot);
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                err instanceof Error
                  ? `MCP_PATH_ESCAPE: ${err.message}`
                  : "MCP_PATH_ESCAPE: path rejected",
            },
          ],
          isError: true,
        };
      }
    }
  }
}
```

- [ ] **Step 6: Run path guard tests to verify they pass**

```bash
node ../../node_modules/vitest/vitest.mjs run src/mcp/__tests__/mcp-client-path-guard.test.ts 2>&1 | tail -10
```

Expected: all 5 pass.

- [ ] **Step 7: Run the full core suite**

```bash
node ../../node_modules/vitest/vitest.mjs run 2>&1 | tail -8
```

Expected: all pass, no regressions.

- [ ] **Step 8: Typecheck core**

```bash
node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json 2>&1 | tail -5
```

Expected: 0 errors.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/mcp/mcp-types.ts \
        packages/core/src/mcp/mcp-client.ts \
        packages/core/src/mcp/__tests__/mcp-client-path-guard.test.ts
git commit -m "feat(core/mcp): wire jailed-fs path-escape guard into MCPClient.invokeTool()"
```

---

## Self-Review

**Spec coverage:**

- ✅ `assertPathWithinRoot` rejects `../` traversal → `MCP_PATH_ESCAPE` — Task 1
- ✅ `assertPathWithinRoot` rejects absolute path outside root → same error — Task 1
- ✅ `assertPathWithinRoot` allows safe relative and safe absolute paths — Task 1
- ✅ `filesystemRoot` field on `MCPServerConfig` — Task 2
- ✅ `invokeTool()` calls guard for known path key names — Task 2
- ✅ Guard is no-op when `filesystemRoot` not set (backwards compatible) — Task 2
- ✅ Non-path keys not blocked — Task 2

**Placeholder scan:** None found — all steps have concrete code.

**Type consistency:** `PATH_ARG_KEYS` exported from `mcp-security.ts`, imported in `mcp-client.ts`. `assertPathWithinRoot` signature is `(userPath: string, rootDir: string): void` — consistent across Task 1 and Task 2. `filesystemRoot` added as `string` (not `string | undefined`) in the call site since it's guarded by `if (filesystemRoot)`.

**Note on test isolation:** The `mcp-client-path-guard.test.ts` tests reach into `MCPClient` private fields via cast to set up a fake connected state. This is acceptable for testing the guard logic without requiring a real stdio/HTTP transport. The cast is explicit and isolated to the test file.
