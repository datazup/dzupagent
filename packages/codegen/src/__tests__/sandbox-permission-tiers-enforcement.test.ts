/**
 * Sandbox Permission Tiers — Enforcement Test Suite (+70 tests)
 *
 * Focuses on the *behavioural enforcement* of permission tiers across codegen
 * operations rather than the pure config helpers already covered by
 * `sandbox/permission-tiers.test.ts` and `sandbox-permission-coherence-deep.test.ts`.
 *
 * Coverage map (per the requested scenarios):
 *  - Read-only tier: can read, cannot write / delete / edit / execute-arbitrary
 *  - Workspace-write tier: read + scoped writes, no network, no arbitrary shell
 *  - Full-access tier: all operations allowed
 *  - Escalation attempts: read-only attempting writes throws fail-fast
 *  - Path-traversal prevention in workspace-write (cannot escape root)
 *  - Tier enforcement consistency across edit / create / delete / run
 *  - Tier configuration validation (invalid overrides rejected)
 *  - Default tier behaviour (no tier specified => no fail-fast)
 *  - Tier inheritance in nested / merged operations
 *  - Actionable error messages (state required permission)
 *
 * Construction patterns mirror existing tests (vitest, mock sandbox via vi.fn,
 * LocalWorkspace + SandboxedWorkspace, VirtualFS-backed tools).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile as fsWriteFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  TIER_DEFAULTS,
  tierToDockerFlags,
  tierToE2bConfig,
  mergeTierConfig,
  validateTierConfig,
  compareTiers,
  mostRestrictiveTier,
  tierAllowsWrite,
  assertTierAllowsWrite,
  PermissionTierViolationError,
  MIN_MEMORY_MB,
  MIN_CPUS,
  MIN_TIMEOUT_MS,
  type PermissionTier,
  type TierConfig,
} from "../sandbox/permission-tiers.js";
import { tierSatisfies } from "@dzupagent/core/tools";
import { VirtualFS } from "../vfs/virtual-fs.js";
import { createWriteFileTool } from "../tools/write-file.tool.js";
import { createEditFileTool } from "../tools/edit-file.tool.js";
import { LocalWorkspace } from "../workspace/local-workspace.js";
import { SandboxedWorkspace } from "../workspace/sandboxed-workspace.js";
import { WorkspacePathSecurityError } from "../workspace/types.js";
import type { WorkspaceOptions } from "../workspace/types.js";

const ALL_TIERS: PermissionTier[] = [
  "read-only",
  "workspace-write",
  "full-access",
];
const WRITE_TIERS: PermissionTier[] = ["workspace-write", "full-access"];

// ---------------------------------------------------------------------------
// Mock sandbox — records calls so we can assert routing without real I/O.
// ---------------------------------------------------------------------------
function createRecordingSandbox() {
  return {
    execute: vi.fn(async (_cmd: string) => ({
      stdout: "mock stdout",
      stderr: "",
      exitCode: 0,
    })),
    uploadFiles: vi.fn(async (_files: Record<string, string>) => undefined),
    downloadFiles: vi.fn(async (_paths: string[]) => ({})),
  };
}

// ===========================================================================
// READ-ONLY TIER — capabilities & restrictions
// ===========================================================================

describe("read-only tier — capabilities", () => {
  it("config disallows writes (filesystem read-only)", () => {
    expect(TIER_DEFAULTS["read-only"].filesystem).toBe("read-only");
  });

  it("tierAllowsWrite returns false for read-only", () => {
    expect(tierAllowsWrite("read-only")).toBe(false);
  });

  it("disallows network access", () => {
    expect(TIER_DEFAULTS["read-only"].network).toBe(false);
  });

  it("disallows process spawning", () => {
    expect(TIER_DEFAULTS["read-only"].processes).toBe(false);
  });

  it("docker flags include --read-only (no filesystem writes)", () => {
    expect(tierToDockerFlags("read-only")).toContain("--read-only");
  });

  it("docker flags include --network=none (no execute-over-network)", () => {
    expect(tierToDockerFlags("read-only")).toContain("--network=none");
  });

  it("docker flags include --pids-limit=5 (no arbitrary process execution)", () => {
    expect(tierToDockerFlags("read-only")).toContain("--pids-limit=5");
  });

  it("createWriteFileTool throws synchronously under read-only", () => {
    expect(() =>
      createWriteFileTool({
        vfs: new VirtualFS(),
        permissionTier: "read-only",
      }),
    ).toThrow(PermissionTierViolationError);
  });

  it("createEditFileTool throws synchronously under read-only", () => {
    expect(() =>
      createEditFileTool({ vfs: new VirtualFS(), permissionTier: "read-only" }),
    ).toThrow(PermissionTierViolationError);
  });

  it("a VirtualFS read still works regardless of tier (reads are always allowed)", () => {
    const vfs = new VirtualFS({ "a.ts": "export const a = 1" });
    expect(vfs.read("a.ts")).toBe("export const a = 1");
  });
});

// ===========================================================================
// WORKSPACE-WRITE TIER — capabilities & restrictions
// ===========================================================================

describe("workspace-write tier — capabilities", () => {
  it("allows writes (filesystem workspace-only)", () => {
    expect(TIER_DEFAULTS["workspace-write"].filesystem).toBe("workspace-only");
  });

  it("tierAllowsWrite returns true for workspace-write", () => {
    expect(tierAllowsWrite("workspace-write")).toBe(true);
  });

  it("disallows network access", () => {
    expect(TIER_DEFAULTS["workspace-write"].network).toBe(false);
  });

  it("docker flags block network (no arbitrary network shell)", () => {
    expect(tierToDockerFlags("workspace-write")).toContain("--network=none");
  });

  it("allows processes (test runners, compilers)", () => {
    expect(TIER_DEFAULTS["workspace-write"].processes).toBe(true);
  });

  it("docker flags omit --read-only (writes permitted)", () => {
    expect(tierToDockerFlags("workspace-write")).not.toContain("--read-only");
  });

  it("docker flags omit --pids-limit=5 (processes permitted)", () => {
    expect(tierToDockerFlags("workspace-write")).not.toContain(
      "--pids-limit=5",
    );
  });

  it("createWriteFileTool succeeds under workspace-write", () => {
    expect(() =>
      createWriteFileTool({
        vfs: new VirtualFS(),
        permissionTier: "workspace-write",
      }),
    ).not.toThrow();
  });

  it("createEditFileTool succeeds under workspace-write", () => {
    expect(() =>
      createEditFileTool({
        vfs: new VirtualFS(),
        permissionTier: "workspace-write",
      }),
    ).not.toThrow();
  });
});

// ===========================================================================
// FULL-ACCESS TIER — all operations allowed
// ===========================================================================

describe("full-access tier — capabilities", () => {
  it("allows full filesystem access", () => {
    expect(TIER_DEFAULTS["full-access"].filesystem).toBe("full");
  });

  it("tierAllowsWrite returns true for full-access", () => {
    expect(tierAllowsWrite("full-access")).toBe(true);
  });

  it("allows network access", () => {
    expect(TIER_DEFAULTS["full-access"].network).toBe(true);
  });

  it("allows process spawning", () => {
    expect(TIER_DEFAULTS["full-access"].processes).toBe(true);
  });

  it("docker flags omit --network=none", () => {
    expect(tierToDockerFlags("full-access")).not.toContain("--network=none");
  });

  it("docker flags omit --read-only", () => {
    expect(tierToDockerFlags("full-access")).not.toContain("--read-only");
  });

  it("docker flags omit --pids-limit=5", () => {
    expect(tierToDockerFlags("full-access")).not.toContain("--pids-limit=5");
  });

  it("createWriteFileTool succeeds under full-access", () => {
    expect(() =>
      createWriteFileTool({
        vfs: new VirtualFS(),
        permissionTier: "full-access",
      }),
    ).not.toThrow();
  });

  it("createEditFileTool succeeds under full-access", () => {
    expect(() =>
      createEditFileTool({
        vfs: new VirtualFS(),
        permissionTier: "full-access",
      }),
    ).not.toThrow();
  });

  it("all docker flags still enforce --no-new-privileges hardening", () => {
    expect(tierToDockerFlags("full-access")).toContain("--no-new-privileges");
  });
});

// ===========================================================================
// PERMISSION ESCALATION ATTEMPTS
// ===========================================================================

describe("permission escalation attempts", () => {
  it("read-only attempting write throws PermissionTierViolationError", () => {
    expect(() => assertTierAllowsWrite("read-only", "file write")).toThrow(
      PermissionTierViolationError,
    );
  });

  it("thrown error carries the offending tier", () => {
    try {
      assertTierAllowsWrite("read-only", "edit_file");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PermissionTierViolationError);
      expect((err as PermissionTierViolationError).tier).toBe("read-only");
    }
  });

  it("thrown error carries the attempted action", () => {
    try {
      assertTierAllowsWrite("read-only", "delete_file");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as PermissionTierViolationError).action).toBe("delete_file");
    }
  });

  it("read-only does NOT satisfy workspace-write requirement", () => {
    expect(tierSatisfies("read-only", "workspace-write")).toBe(false);
  });

  it("read-only does NOT satisfy full-access requirement", () => {
    expect(tierSatisfies("read-only", "full-access")).toBe(false);
  });

  it("workspace-write does NOT satisfy full-access requirement", () => {
    expect(tierSatisfies("workspace-write", "full-access")).toBe(false);
  });

  it("full-access satisfies workspace-write requirement", () => {
    expect(tierSatisfies("full-access", "workspace-write")).toBe(true);
  });

  it("full-access satisfies read-only requirement", () => {
    expect(tierSatisfies("full-access", "read-only")).toBe(true);
  });

  it("workspace-write satisfies read-only requirement", () => {
    expect(tierSatisfies("workspace-write", "read-only")).toBe(true);
  });

  it("any tier satisfies its own requirement (reflexive)", () => {
    for (const t of ALL_TIERS) {
      expect(tierSatisfies(t, t)).toBe(true);
    }
  });

  it("merging a read-only base does not silently grant write via filesystem override absence", () => {
    // Merge without overriding filesystem keeps read-only — tier remains non-writable.
    const merged = mergeTierConfig("read-only", { maxMemoryMb: 2048 });
    expect(merged.filesystem).toBe("read-only");
  });

  it("escalation guard is synchronous (no async round-trip)", () => {
    // assertTierAllowsWrite must throw before any promise is created.
    let threw = false;
    try {
      assertTierAllowsWrite("read-only");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

// ===========================================================================
// PATH TRAVERSAL PREVENTION (workspace-write scope)
// ===========================================================================

describe("path traversal prevention in workspace-write scope", () => {
  let tempDir: string;
  let ws: SandboxedWorkspace;
  let sandbox: ReturnType<typeof createRecordingSandbox>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), `tier-pt-${randomUUID()}-`));
    const opts: WorkspaceOptions = {
      rootDir: tempDir,
      search: { provider: "builtin" },
      command: { timeoutMs: 5_000, allowedCommands: ["echo", "node"] },
    };
    const inner = new LocalWorkspace(opts);
    sandbox = createRecordingSandbox();
    ws = new SandboxedWorkspace(inner, sandbox as never);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("rejects reading a parent-relative path (../)", async () => {
    await expect(ws.readFile("../escape.txt")).rejects.toThrow(
      WorkspacePathSecurityError,
    );
  });

  it("rejects reading a deeply nested traversal path", async () => {
    await expect(ws.readFile("../../../../etc/passwd")).rejects.toThrow(
      WorkspacePathSecurityError,
    );
  });

  it("rejects reading an absolute path outside the root", async () => {
    await expect(ws.readFile("/etc/passwd")).rejects.toThrow(
      WorkspacePathSecurityError,
    );
  });

  it("rejects an embedded traversal segment (sub/../../escape)", async () => {
    await expect(ws.readFile("sub/../../escape.txt")).rejects.toThrow(
      WorkspacePathSecurityError,
    );
  });

  it("allows reading a legitimate in-root relative path", async () => {
    await fsWriteFile(join(tempDir, "in-root.txt"), "safe", "utf-8");
    await expect(ws.readFile("in-root.txt")).resolves.toBe("safe");
  });

  it("allows reading a nested in-root path", async () => {
    await mkdir(join(tempDir, "nested"), { recursive: true });
    await fsWriteFile(join(tempDir, "nested", "deep.txt"), "deep", "utf-8");
    await expect(ws.readFile("nested/deep.txt")).resolves.toBe("deep");
  });

  it("path-security error message names the workspace root", async () => {
    try {
      await ws.readFile("../escape.txt");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspacePathSecurityError);
      expect((err as WorkspacePathSecurityError).message).toContain(
        "workspace root",
      );
    }
  });

  it("path-security error retains the attempted path", async () => {
    try {
      await ws.readFile("../../secret");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as WorkspacePathSecurityError).attemptedPath).toBe(
        "../../secret",
      );
    }
  });

  it("exists() on a traversal path is rejected (does not leak outside root)", async () => {
    await expect(ws.exists("../../../etc/hosts")).rejects.toThrow(
      WorkspacePathSecurityError,
    );
  });
});

// ===========================================================================
// TIER ENFORCEMENT CONSISTENCY ACROSS OPERATIONS (edit / create / run)
// ===========================================================================

describe("tier enforcement consistency across operations", () => {
  it("write_file action label is rejected under read-only", () => {
    expect(() => assertTierAllowsWrite("read-only", "write_file")).toThrow();
  });

  it("edit_file action label is rejected under read-only", () => {
    expect(() => assertTierAllowsWrite("read-only", "edit_file")).toThrow();
  });

  it("delete_file action label is rejected under read-only", () => {
    expect(() => assertTierAllowsWrite("read-only", "delete_file")).toThrow();
  });

  it("run/exec write-side action label is rejected under read-only", () => {
    expect(() =>
      assertTierAllowsWrite("read-only", "run command writes"),
    ).toThrow();
  });

  it.each(WRITE_TIERS)("write_file is permitted under %s", (tier) => {
    expect(() => assertTierAllowsWrite(tier, "write_file")).not.toThrow();
  });

  it.each(WRITE_TIERS)("edit_file is permitted under %s", (tier) => {
    expect(() => assertTierAllowsWrite(tier, "edit_file")).not.toThrow();
  });

  it.each(WRITE_TIERS)("delete_file is permitted under %s", (tier) => {
    expect(() => assertTierAllowsWrite(tier, "delete_file")).not.toThrow();
  });

  it("createWriteFileTool and createEditFileTool agree under read-only (both throw)", () => {
    expect(() =>
      createWriteFileTool({
        vfs: new VirtualFS(),
        permissionTier: "read-only",
      }),
    ).toThrow(PermissionTierViolationError);
    expect(() =>
      createEditFileTool({ vfs: new VirtualFS(), permissionTier: "read-only" }),
    ).toThrow(PermissionTierViolationError);
  });

  it.each(WRITE_TIERS)(
    "createWriteFileTool and createEditFileTool agree under %s (both succeed)",
    (tier) => {
      expect(() =>
        createWriteFileTool({ vfs: new VirtualFS(), permissionTier: tier }),
      ).not.toThrow();
      expect(() =>
        createEditFileTool({ vfs: new VirtualFS(), permissionTier: tier }),
      ).not.toThrow();
    },
  );

  it("tierAllowsWrite is consistent with assertTierAllowsWrite for every tier", () => {
    for (const tier of ALL_TIERS) {
      const allowed = tierAllowsWrite(tier);
      if (allowed) {
        expect(() => assertTierAllowsWrite(tier)).not.toThrow();
      } else {
        expect(() => assertTierAllowsWrite(tier)).toThrow(
          PermissionTierViolationError,
        );
      }
    }
  });
});

// ===========================================================================
// SANDBOXED WORKSPACE — operation routing under workspace-scoped tier
// ===========================================================================

describe("SandboxedWorkspace operation routing", () => {
  let tempDir: string;
  let ws: SandboxedWorkspace;
  let sandbox: ReturnType<typeof createRecordingSandbox>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), `tier-route-${randomUUID()}-`));
    const opts: WorkspaceOptions = {
      rootDir: tempDir,
      search: { provider: "builtin" },
      command: { timeoutMs: 5_000, allowedCommands: ["echo", "node"] },
    };
    const inner = new LocalWorkspace(opts);
    sandbox = createRecordingSandbox();
    ws = new SandboxedWorkspace(inner, sandbox as never);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("reads delegate locally and never invoke the sandbox", async () => {
    await fsWriteFile(join(tempDir, "r.txt"), "content", "utf-8");
    const out = await ws.readFile("r.txt");
    expect(out).toBe("content");
    expect(sandbox.execute).not.toHaveBeenCalled();
    expect(sandbox.uploadFiles).not.toHaveBeenCalled();
  });

  it("writes route through the sandbox uploadFiles channel", async () => {
    await ws.writeFile("out.ts", "export const z = 1");
    expect(sandbox.uploadFiles).toHaveBeenCalledTimes(1);
    expect(sandbox.uploadFiles).toHaveBeenCalledWith({
      "out.ts": "export const z = 1",
    });
  });

  it("allowed command executes through the sandbox", async () => {
    const result = await ws.runCommand("echo", ["hello"]);
    expect(result.exitCode).toBe(0);
    expect(sandbox.execute).toHaveBeenCalledTimes(1);
  });

  it("disallowed (arbitrary shell) command is blocked before hitting sandbox", async () => {
    const result = await ws.runCommand("rm", ["-rf", "/"]);
    expect(result.exitCode).not.toBe(0);
    expect(sandbox.execute).not.toHaveBeenCalled();
  });

  it("blocked command result explains the allowlist restriction", async () => {
    const result = await ws.runCommand("curl", ["http://evil"]);
    expect(result.stderr.toLowerCase()).toContain("allowed");
    expect(sandbox.execute).not.toHaveBeenCalled();
  });

  it("another disallowed command (wget) is also blocked", async () => {
    const result = await ws.runCommand("wget", ["http://evil"]);
    expect(sandbox.execute).not.toHaveBeenCalled();
    expect(result.exitCode).not.toBe(0);
  });

  it("second allowed command (node) also routes through the sandbox", async () => {
    await ws.runCommand("node", ["-e", "console.log(1)"]);
    expect(sandbox.execute).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// TIER CONFIGURATION VALIDATION (invalid overrides rejected)
// ===========================================================================

describe("tier configuration validation", () => {
  it("valid override returns valid:true", () => {
    expect(
      validateTierConfig({ maxMemoryMb: 256, maxCpus: 2, timeoutMs: 5_000 })
        .valid,
    ).toBe(true);
  });

  it("memory below minimum is rejected", () => {
    const r = validateTierConfig({ maxMemoryMb: MIN_MEMORY_MB - 1 });
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain("maxMemoryMb");
  });

  it("cpus below minimum is rejected", () => {
    const r = validateTierConfig({ maxCpus: MIN_CPUS - 1 });
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain("maxCpus");
  });

  it("timeout below minimum is rejected", () => {
    const r = validateTierConfig({ timeoutMs: MIN_TIMEOUT_MS - 1 });
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain("timeoutMs");
  });

  it("invalid filesystem mode string is rejected", () => {
    const r = validateTierConfig({
      filesystem: "everything" as unknown as TierConfig["filesystem"],
    });
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain("filesystem");
  });

  it("valid filesystem mode (workspace-only) passes", () => {
    expect(validateTierConfig({ filesystem: "workspace-only" }).valid).toBe(
      true,
    );
  });

  it("multiple invalid fields accumulate multiple errors", () => {
    const r = validateTierConfig({ maxMemoryMb: 1, maxCpus: 0, timeoutMs: 0 });
    expect(r.errors.length).toBe(3);
  });

  it("minimum boundary values are accepted (inclusive)", () => {
    const r = validateTierConfig({
      maxMemoryMb: MIN_MEMORY_MB,
      maxCpus: MIN_CPUS,
      timeoutMs: MIN_TIMEOUT_MS,
    });
    expect(r.valid).toBe(true);
  });

  it("every default tier config passes validation", () => {
    for (const tier of ALL_TIERS) {
      expect(validateTierConfig(TIER_DEFAULTS[tier]).valid).toBe(true);
    }
  });

  it("validation error message reports the offending value", () => {
    const r = validateTierConfig({ maxMemoryMb: 7 });
    expect(r.errors[0]).toContain("7");
  });
});

// ===========================================================================
// DEFAULT TIER BEHAVIOUR (no tier specified)
// ===========================================================================

describe("default tier behaviour", () => {
  it("createWriteFileTool with no context does not fail fast", () => {
    expect(() => createWriteFileTool()).not.toThrow();
  });

  it("createWriteFileTool with context but no permissionTier does not fail fast", () => {
    expect(() => createWriteFileTool({ vfs: new VirtualFS() })).not.toThrow();
  });

  it("createEditFileTool with a bare VirtualFS (legacy, no tier) does not fail fast", () => {
    expect(() => createEditFileTool(new VirtualFS())).not.toThrow();
  });

  it("createEditFileTool with context lacking permissionTier does not fail fast", () => {
    expect(() => createEditFileTool({ vfs: new VirtualFS() })).not.toThrow();
  });

  it("read-only is documented as the safest / canonical default tier", () => {
    // The most-restrictive tier sorts first and is the conservative default choice.
    expect(compareTiers("read-only", "workspace-write")).toBe(-1);
    expect(compareTiers("read-only", "full-access")).toBe(-1);
  });

  it("explicitly choosing read-only restores fail-fast behaviour", () => {
    expect(() =>
      createWriteFileTool({
        vfs: new VirtualFS(),
        permissionTier: "read-only",
      }),
    ).toThrow(PermissionTierViolationError);
  });
});

// ===========================================================================
// TIER INHERITANCE IN NESTED / MERGED OPERATIONS
// ===========================================================================

describe("tier inheritance and combination", () => {
  it("most-restrictive of read-only + full-access is read-only", () => {
    expect(mostRestrictiveTier("read-only", "full-access")).toBe("read-only");
  });

  it("most-restrictive of workspace-write + full-access is workspace-write", () => {
    expect(mostRestrictiveTier("workspace-write", "full-access")).toBe(
      "workspace-write",
    );
  });

  it("most-restrictive is commutative", () => {
    expect(mostRestrictiveTier("full-access", "read-only")).toBe(
      mostRestrictiveTier("read-only", "full-access"),
    );
  });

  it("a nested operation inheriting the most-restrictive tier loses write capability", () => {
    const effective = mostRestrictiveTier("full-access", "read-only");
    expect(tierAllowsWrite(effective)).toBe(false);
  });

  it("a nested operation inheriting workspace-write retains write capability", () => {
    const effective = mostRestrictiveTier("workspace-write", "full-access");
    expect(tierAllowsWrite(effective)).toBe(true);
  });

  it("merged config inherits unspecified fields from the base tier", () => {
    const merged = mergeTierConfig("workspace-write", { maxMemoryMb: 2048 });
    expect(merged.network).toBe(TIER_DEFAULTS["workspace-write"].network);
    expect(merged.processes).toBe(TIER_DEFAULTS["workspace-write"].processes);
    expect(merged.filesystem).toBe(TIER_DEFAULTS["workspace-write"].filesystem);
  });

  it("merging never mutates the shared TIER_DEFAULTS base", () => {
    const before = { ...TIER_DEFAULTS["full-access"] };
    mergeTierConfig("full-access", { maxMemoryMb: 99999 });
    expect(TIER_DEFAULTS["full-access"]).toEqual(before);
  });

  it("tierToE2bConfig propagates the parent tier into nested metadata", () => {
    const cfg = tierToE2bConfig("workspace-write");
    const meta = cfg.metadata as { tier: PermissionTier; filesystem: string };
    expect(meta.tier).toBe("workspace-write");
    expect(meta.filesystem).toBe("workspace-only");
  });

  it("most-restrictive of two identical tiers returns that tier", () => {
    for (const t of ALL_TIERS) {
      expect(mostRestrictiveTier(t, t)).toBe(t);
    }
  });

  it("compareTiers + mostRestrictiveTier are consistent", () => {
    for (const a of ALL_TIERS) {
      for (const b of ALL_TIERS) {
        const cmp = compareTiers(a, b);
        const most = mostRestrictiveTier(a, b);
        if (cmp < 0) expect(most).toBe(a);
        else if (cmp > 0) expect(most).toBe(b);
        else expect(most).toBe(a);
      }
    }
  });
});

// ===========================================================================
// ACTIONABLE ERROR MESSAGES
// ===========================================================================

describe("actionable error messages", () => {
  it("violation message names the forbidden tier", () => {
    const err = new PermissionTierViolationError("read-only", "write_file");
    expect(err.message).toContain("read-only");
  });

  it("violation message names the attempted action", () => {
    const err = new PermissionTierViolationError("read-only", "write_file");
    expect(err.message).toContain("write_file");
  });

  it("violation message tells the user which tiers DO permit the action", () => {
    const err = new PermissionTierViolationError("read-only", "write_file");
    expect(err.message).toContain("workspace-write");
    expect(err.message).toContain("full-access");
  });

  it("violation error has the conventional name property", () => {
    const err = new PermissionTierViolationError("read-only", "edit_file");
    expect(err.name).toBe("PermissionTierViolationError");
  });

  it("violation error is an instanceof Error", () => {
    const err = new PermissionTierViolationError("read-only", "edit_file");
    expect(err).toBeInstanceOf(Error);
  });

  it("default action label is used when none provided", () => {
    try {
      assertTierAllowsWrite("read-only");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as PermissionTierViolationError).action).toBe("file write");
    }
  });

  it("path-security message instructs paths must stay within the root", () => {
    const err = new WorkspacePathSecurityError("../x", "/root");
    expect(err.message.toLowerCase()).toContain("within");
  });

  it("validation errors are human-readable strings", () => {
    const r = validateTierConfig({ maxCpus: 0 });
    expect(typeof r.errors[0]).toBe("string");
    expect(r.errors[0].length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// CROSS-TIER INVARIANTS (sanity matrix)
// ===========================================================================

describe("cross-tier invariants", () => {
  it("exactly one tier (read-only) forbids writes", () => {
    const noWrite = ALL_TIERS.filter((t) => !tierAllowsWrite(t));
    expect(noWrite).toEqual(["read-only"]);
  });

  it("memory budgets increase monotonically with permissiveness", () => {
    expect(TIER_DEFAULTS["read-only"].maxMemoryMb).toBeLessThan(
      TIER_DEFAULTS["workspace-write"].maxMemoryMb,
    );
    expect(TIER_DEFAULTS["workspace-write"].maxMemoryMb).toBeLessThan(
      TIER_DEFAULTS["full-access"].maxMemoryMb,
    );
  });

  it("cpu budgets are non-decreasing with permissiveness", () => {
    expect(TIER_DEFAULTS["read-only"].maxCpus).toBeLessThanOrEqual(
      TIER_DEFAULTS["workspace-write"].maxCpus,
    );
    expect(TIER_DEFAULTS["workspace-write"].maxCpus).toBeLessThanOrEqual(
      TIER_DEFAULTS["full-access"].maxCpus,
    );
  });

  it("timeouts are non-decreasing with permissiveness", () => {
    expect(TIER_DEFAULTS["read-only"].timeoutMs).toBeLessThanOrEqual(
      TIER_DEFAULTS["workspace-write"].timeoutMs,
    );
    expect(TIER_DEFAULTS["workspace-write"].timeoutMs).toBeLessThanOrEqual(
      TIER_DEFAULTS["full-access"].timeoutMs,
    );
  });

  it("only full-access permits network", () => {
    const net = ALL_TIERS.filter((t) => TIER_DEFAULTS[t].network);
    expect(net).toEqual(["full-access"]);
  });

  it("read-only is the only tier that forbids processes", () => {
    const noProc = ALL_TIERS.filter((t) => !TIER_DEFAULTS[t].processes);
    expect(noProc).toEqual(["read-only"]);
  });

  it("every tier always carries --no-new-privileges hardening", () => {
    for (const t of ALL_TIERS) {
      expect(tierToDockerFlags(t)).toContain("--no-new-privileges");
    }
  });

  it("every tier emits a well-formed --memory flag", () => {
    for (const t of ALL_TIERS) {
      const mem = tierToDockerFlags(t).find((f) => f.startsWith("--memory="));
      expect(mem).toMatch(/^--memory=\d+m$/);
    }
  });

  it("every tier emits a well-formed --cpus flag", () => {
    for (const t of ALL_TIERS) {
      const cpu = tierToDockerFlags(t).find((f) => f.startsWith("--cpus="));
      expect(cpu).toMatch(/^--cpus=\d+$/);
    }
  });

  it("tier ordering via tierSatisfies forms a total order", () => {
    // read-only <= workspace-write <= full-access
    expect(tierSatisfies("full-access", "read-only")).toBe(true);
    expect(tierSatisfies("read-only", "read-only")).toBe(true);
    expect(tierSatisfies("read-only", "full-access")).toBe(false);
  });
});
