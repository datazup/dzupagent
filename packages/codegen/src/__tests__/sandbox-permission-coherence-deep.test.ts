/**
 * W25-A2 — Sandbox Permission Tiers + Pipeline Coherence Deep Coverage
 *
 * Targets gaps not covered by sandbox-protocol-and-factory.test.ts (TIER_DEFAULTS +
 * tierToDockerFlags only) or codegen-multiedit-repomap-deep.test.ts (multi-edit +
 * pipeline-executor). New coverage:
 *
 *  - Permission tier semantics: read-only / workspace-write / full-access
 *    (filesystem, network, processes per tier)
 *  - Tier escalation/downgrade: tierSatisfies, compareTiers, mostRestrictiveTier
 *  - Tier config validation + merge + E2B conversion
 *  - tierAllowsWrite + assertTierAllowsWrite + PermissionTierViolationError
 *  - Write tools fail fast at issuance under read-only tier (write_file, edit_file)
 *  - SandboxedWorkspace: reads delegate locally, writes route to sandbox,
 *    command allowlist enforcement, no real filesystem mutation
 *  - Multi-edit atomicity / no-partial-state-on-failure
 *  - Pipeline three-stage coherence: stage-2 failure halts stage-3, prior state visible
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  TIER_DEFAULTS,
  tierToDockerFlags,
  validateTierConfig,
  mergeTierConfig,
  tierToE2bConfig,
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
import { createMultiEditTool } from "../tools/multi-edit.tool.js";
import { MockSandbox } from "../sandbox/mock-sandbox.js";
import { SandboxedWorkspace } from "../workspace/sandboxed-workspace.js";
import type { LocalWorkspace } from "../workspace/local-workspace.js";
import type {
  WorkspaceOptions,
  CommandResult,
  SearchResult,
} from "../workspace/types.js";
import {
  PipelineExecutor,
  type PhaseConfig,
} from "../pipeline/pipeline-executor.js";

const TIERS: PermissionTier[] = ["read-only", "workspace-write", "full-access"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function callMultiEdit(
  vfs: VirtualFS,
  fileEdits: Array<{
    filePath: string;
    edits: Array<{ oldText: string; newText: string }>;
  }>
): Promise<string> {
  const tool = createMultiEditTool(vfs);
  return (
    tool as unknown as {
      _call: (args: Record<string, unknown>) => Promise<string>;
    }
  )._call({ fileEdits });
}

function makePhase(
  id: string,
  execute: (state: Record<string, unknown>) => Promise<Record<string, unknown>>,
  overrides?: Partial<PhaseConfig>
): PhaseConfig {
  return { id, name: id, execute, ...overrides };
}

/**
 * Build a minimal LocalWorkspace stand-in exposing only what SandboxedWorkspace
 * delegates to (reads + rootDir + options). Reads are tracked so we can prove
 * they never touch the sandbox.
 */
function fakeLocalWorkspace(opts: {
  options?: WorkspaceOptions;
  files?: Record<string, string>;
}): LocalWorkspace & { readCalls: string[]; writeCalls: string[] } {
  const files = opts.files ?? {};
  const readCalls: string[] = [];
  const writeCalls: string[] = [];
  const options: WorkspaceOptions = opts.options ?? { rootDir: "/work" };
  const inner = {
    rootDir: options.rootDir ?? "/work",
    options,
    readCalls,
    writeCalls,
    async readFile(path: string): Promise<string> {
      readCalls.push(path);
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    async listFiles(_glob: string): Promise<string[]> {
      return Object.keys(files);
    },
    async search(_q: string): Promise<SearchResult[]> {
      return [];
    },
    async exists(path: string): Promise<boolean> {
      return path in files;
    },
    async writeFile(path: string, content: string): Promise<void> {
      // Should NOT be called by SandboxedWorkspace — it routes writes to sandbox.
      writeCalls.push(path);
      files[path] = content;
    },
    async runCommand(): Promise<CommandResult> {
      throw new Error(
        "inner.runCommand should not be called by SandboxedWorkspace"
      );
    },
  };
  return inner as unknown as LocalWorkspace & {
    readCalls: string[];
    writeCalls: string[];
  };
}

// ===========================================================================
// Tier capability matrix — read-only / workspace-write / full-access
// ===========================================================================

describe("PermissionTier capability matrix", () => {
  it("read-only blocks writes, network, and processes", () => {
    const t = TIER_DEFAULTS["read-only"];
    expect(t.filesystem).toBe("read-only");
    expect(t.network).toBe(false);
    expect(t.processes).toBe(false);
  });

  it("workspace-write allows in-workspace writes + processes but blocks network", () => {
    const t = TIER_DEFAULTS["workspace-write"];
    expect(t.filesystem).toBe("workspace-only");
    expect(t.network).toBe(false);
    expect(t.processes).toBe(true);
  });

  it("full-access allows writes, network, and processes", () => {
    const t = TIER_DEFAULTS["full-access"];
    expect(t.filesystem).toBe("full");
    expect(t.network).toBe(true);
    expect(t.processes).toBe(true);
  });

  it("only read-only forbids filesystem writes", () => {
    expect(TIER_DEFAULTS["read-only"].filesystem).toBe("read-only");
    expect(TIER_DEFAULTS["workspace-write"].filesystem).not.toBe("read-only");
    expect(TIER_DEFAULTS["full-access"].filesystem).not.toBe("read-only");
  });

  it("only full-access permits network egress", () => {
    expect(TIER_DEFAULTS["read-only"].network).toBe(false);
    expect(TIER_DEFAULTS["workspace-write"].network).toBe(false);
    expect(TIER_DEFAULTS["full-access"].network).toBe(true);
  });

  it("process spawning is gated to workspace-write and above", () => {
    expect(TIER_DEFAULTS["read-only"].processes).toBe(false);
    expect(TIER_DEFAULTS["workspace-write"].processes).toBe(true);
    expect(TIER_DEFAULTS["full-access"].processes).toBe(true);
  });

  it("resource ceilings widen monotonically with permissiveness", () => {
    const ro = TIER_DEFAULTS["read-only"];
    const ww = TIER_DEFAULTS["workspace-write"];
    const fa = TIER_DEFAULTS["full-access"];
    expect(ro.maxMemoryMb).toBeLessThan(ww.maxMemoryMb);
    expect(ww.maxMemoryMb).toBeLessThan(fa.maxMemoryMb);
    expect(ro.maxCpus).toBeLessThanOrEqual(ww.maxCpus);
    expect(ww.maxCpus).toBeLessThanOrEqual(fa.maxCpus);
    expect(ro.timeoutMs).toBeLessThan(ww.timeoutMs);
    expect(ww.timeoutMs).toBeLessThan(fa.timeoutMs);
  });
});

// ===========================================================================
// tierToDockerFlags — security-relevant flag derivation
// ===========================================================================

describe("tierToDockerFlags — enforcement flags", () => {
  it("read-only emits --read-only, --network=none, and pids-limit", () => {
    const flags = tierToDockerFlags("read-only");
    expect(flags).toContain("--read-only");
    expect(flags).toContain("--network=none");
    expect(flags).toContain("--pids-limit=5");
  });

  it("workspace-write drops --read-only and pids-limit but keeps --network=none", () => {
    const flags = tierToDockerFlags("workspace-write");
    expect(flags).not.toContain("--read-only");
    expect(flags).not.toContain("--pids-limit=5");
    expect(flags).toContain("--network=none");
  });

  it("full-access has neither --read-only nor --network=none", () => {
    const flags = tierToDockerFlags("full-access");
    expect(flags).not.toContain("--read-only");
    expect(flags).not.toContain("--network=none");
  });

  it("every tier hardens with --no-new-privileges", () => {
    for (const tier of TIERS) {
      expect(tierToDockerFlags(tier)).toContain("--no-new-privileges");
    }
  });

  it("memory and cpu flags reflect the tier defaults", () => {
    for (const tier of TIERS) {
      const cfg = TIER_DEFAULTS[tier];
      const flags = tierToDockerFlags(tier);
      expect(flags).toContain(`--memory=${cfg.maxMemoryMb}m`);
      expect(flags).toContain(`--cpus=${cfg.maxCpus}`);
    }
  });
});

// ===========================================================================
// Tier escalation / downgrade — tierSatisfies + compareTiers
// ===========================================================================

describe("Tier escalation and downgrade semantics", () => {
  it("a tier satisfies its own requirement (reflexive)", () => {
    for (const tier of TIERS) {
      expect(tierSatisfies(tier, tier)).toBe(true);
    }
  });

  it("full-access satisfies any lower requirement (downgrade allowed)", () => {
    expect(tierSatisfies("full-access", "workspace-write")).toBe(true);
    expect(tierSatisfies("full-access", "read-only")).toBe(true);
  });

  it("read-only cannot satisfy a higher requirement (no escalation)", () => {
    expect(tierSatisfies("read-only", "workspace-write")).toBe(false);
    expect(tierSatisfies("read-only", "full-access")).toBe(false);
  });

  it("workspace-write escalates past read-only but not full-access", () => {
    expect(tierSatisfies("workspace-write", "read-only")).toBe(true);
    expect(tierSatisfies("workspace-write", "full-access")).toBe(false);
  });

  it("compareTiers orders read-only < workspace-write < full-access", () => {
    expect(compareTiers("read-only", "workspace-write")).toBe(-1);
    expect(compareTiers("workspace-write", "full-access")).toBe(-1);
    expect(compareTiers("full-access", "read-only")).toBe(1);
  });

  it("compareTiers returns 0 for identical tiers", () => {
    for (const tier of TIERS) {
      expect(compareTiers(tier, tier)).toBe(0);
    }
  });

  it("compareTiers is antisymmetric across the ordering", () => {
    expect(compareTiers("read-only", "full-access")).toBe(-1);
    expect(compareTiers("full-access", "read-only")).toBe(1);
    expect(compareTiers("workspace-write", "read-only")).toBe(1);
    expect(compareTiers("read-only", "workspace-write")).toBe(-1);
  });

  it("mostRestrictiveTier picks the lower of two tiers", () => {
    expect(mostRestrictiveTier("full-access", "read-only")).toBe("read-only");
    expect(mostRestrictiveTier("workspace-write", "full-access")).toBe(
      "workspace-write"
    );
    expect(mostRestrictiveTier("read-only", "workspace-write")).toBe(
      "read-only"
    );
  });

  it("mostRestrictiveTier returns the first arg on a tie", () => {
    for (const tier of TIERS) {
      expect(mostRestrictiveTier(tier, tier)).toBe(tier);
    }
  });

  it("mostRestrictiveTier is order-independent in result for distinct tiers", () => {
    expect(mostRestrictiveTier("full-access", "read-only")).toBe(
      mostRestrictiveTier("read-only", "full-access")
    );
  });
});

// ===========================================================================
// validateTierConfig — override range checks
// ===========================================================================

describe("validateTierConfig", () => {
  it("accepts an empty override", () => {
    const r = validateTierConfig({});
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("accepts overrides at the minimum thresholds", () => {
    const r = validateTierConfig({
      maxMemoryMb: MIN_MEMORY_MB,
      maxCpus: MIN_CPUS,
      timeoutMs: MIN_TIMEOUT_MS,
    });
    expect(r.valid).toBe(true);
  });

  it("rejects memory below the minimum", () => {
    const r = validateTierConfig({ maxMemoryMb: MIN_MEMORY_MB - 1 });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("maxMemoryMb"))).toBe(true);
  });

  it("rejects cpu below the minimum", () => {
    const r = validateTierConfig({ maxCpus: MIN_CPUS - 1 });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("maxCpus"))).toBe(true);
  });

  it("rejects timeout below the minimum", () => {
    const r = validateTierConfig({ timeoutMs: MIN_TIMEOUT_MS - 1 });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("timeoutMs"))).toBe(true);
  });

  it("rejects an unknown filesystem mode", () => {
    const r = validateTierConfig({
      filesystem: "everything" as TierConfig["filesystem"],
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("filesystem"))).toBe(true);
  });

  it("accepts each valid filesystem mode", () => {
    for (const fs of ["read-only", "workspace-only", "full"] as const) {
      expect(validateTierConfig({ filesystem: fs }).valid).toBe(true);
    }
  });

  it("accumulates multiple errors in a single call", () => {
    const r = validateTierConfig({ maxMemoryMb: 1, maxCpus: 0, timeoutMs: 0 });
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });

  it("passes through values above the minimum unflagged", () => {
    const r = validateTierConfig({
      maxMemoryMb: 8192,
      maxCpus: 16,
      timeoutMs: 600_000,
    });
    expect(r.valid).toBe(true);
  });
});

// ===========================================================================
// mergeTierConfig — non-mutating override
// ===========================================================================

describe("mergeTierConfig", () => {
  it("overlays overrides onto base defaults", () => {
    const merged = mergeTierConfig("read-only", { maxMemoryMb: 512 });
    expect(merged.maxMemoryMb).toBe(512);
    expect(merged.filesystem).toBe("read-only"); // base preserved
  });

  it("does not mutate TIER_DEFAULTS", () => {
    const beforeMem = TIER_DEFAULTS["read-only"].maxMemoryMb;
    mergeTierConfig("read-only", { maxMemoryMb: 9999 });
    expect(TIER_DEFAULTS["read-only"].maxMemoryMb).toBe(beforeMem);
  });

  it("returns a fresh object distinct from the base", () => {
    const merged = mergeTierConfig("full-access", {});
    expect(merged).not.toBe(TIER_DEFAULTS["full-access"]);
    expect(merged).toEqual(TIER_DEFAULTS["full-access"]);
  });

  it("can override every field", () => {
    const merged = mergeTierConfig("read-only", {
      network: true,
      filesystem: "full",
      processes: true,
      maxMemoryMb: 2048,
      maxCpus: 8,
      timeoutMs: 90_000,
    });
    expect(merged).toEqual({
      network: true,
      filesystem: "full",
      processes: true,
      maxMemoryMb: 2048,
      maxCpus: 8,
      timeoutMs: 90_000,
    });
  });
});

// ===========================================================================
// tierToE2bConfig — sandbox-provider conversion
// ===========================================================================

describe("tierToE2bConfig", () => {
  it("maps timeout from the tier default", () => {
    const cfg = tierToE2bConfig("workspace-write");
    expect(cfg["timeout"]).toBe(TIER_DEFAULTS["workspace-write"].timeoutMs);
  });

  it("carries tier metadata for observability", () => {
    const cfg = tierToE2bConfig("full-access");
    const meta = cfg["metadata"] as Record<string, unknown>;
    expect(meta["tier"]).toBe("full-access");
    expect(meta["filesystem"]).toBe("full");
    expect(meta["network"]).toBe(true);
    expect(meta["processes"]).toBe(true);
  });

  it("uses the base template and empty envs", () => {
    const cfg = tierToE2bConfig("read-only");
    expect(cfg["template"]).toBe("base");
    expect(cfg["envs"]).toEqual({});
  });

  it("reflects restrictive metadata for read-only", () => {
    const meta = tierToE2bConfig("read-only")["metadata"] as Record<
      string,
      unknown
    >;
    expect(meta["network"]).toBe(false);
    expect(meta["processes"]).toBe(false);
    expect(meta["filesystem"]).toBe("read-only");
  });
});

// ===========================================================================
// tierAllowsWrite / assertTierAllowsWrite / PermissionTierViolationError
// ===========================================================================

describe("tierAllowsWrite predicate", () => {
  it("is false only for read-only", () => {
    expect(tierAllowsWrite("read-only")).toBe(false);
    expect(tierAllowsWrite("workspace-write")).toBe(true);
    expect(tierAllowsWrite("full-access")).toBe(true);
  });

  it("never throws (pure predicate)", () => {
    for (const tier of TIERS) {
      expect(() => tierAllowsWrite(tier)).not.toThrow();
    }
  });
});

describe("assertTierAllowsWrite", () => {
  it("throws PermissionTierViolationError on read-only", () => {
    expect(() => assertTierAllowsWrite("read-only")).toThrow(
      PermissionTierViolationError
    );
  });

  it("is silent for writable tiers", () => {
    expect(() => assertTierAllowsWrite("workspace-write")).not.toThrow();
    expect(() => assertTierAllowsWrite("full-access")).not.toThrow();
  });

  it("includes the offending tier and action on the error", () => {
    try {
      assertTierAllowsWrite("read-only", "custom_write_action");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PermissionTierViolationError);
      const e = err as PermissionTierViolationError;
      expect(e.tier).toBe("read-only");
      expect(e.action).toBe("custom_write_action");
      expect(e.name).toBe("PermissionTierViolationError");
      expect(e.message).toContain("read-only");
      expect(e.message).toContain("custom_write_action");
    }
  });

  it('defaults the action label to "file write"', () => {
    try {
      assertTierAllowsWrite("read-only");
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as PermissionTierViolationError).action).toBe("file write");
    }
  });
});

describe("PermissionTierViolationError", () => {
  it("is an Error subclass carrying structured fields", () => {
    const err = new PermissionTierViolationError("read-only", "edit_file");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(PermissionTierViolationError);
    expect(err.tier).toBe("read-only");
    expect(err.action).toBe("edit_file");
  });

  it("message names a remediation tier", () => {
    const err = new PermissionTierViolationError("read-only", "write_file");
    expect(err.message).toMatch(/workspace-write|full-access/);
  });
});

// ===========================================================================
// Write tools fail fast at issuance under read-only tier
// ===========================================================================

describe("Write tools enforce tier at issuance", () => {
  it("createWriteFileTool throws under read-only context", () => {
    expect(() =>
      createWriteFileTool({ vfs: new VirtualFS(), permissionTier: "read-only" })
    ).toThrow(PermissionTierViolationError);
  });

  it("createWriteFileTool succeeds under workspace-write context", () => {
    expect(() =>
      createWriteFileTool({
        vfs: new VirtualFS(),
        permissionTier: "workspace-write",
      })
    ).not.toThrow();
  });

  it("createWriteFileTool succeeds under full-access context", () => {
    expect(() =>
      createWriteFileTool({
        vfs: new VirtualFS(),
        permissionTier: "full-access",
      })
    ).not.toThrow();
  });

  it("createWriteFileTool is permissive when no tier is provided", () => {
    expect(() => createWriteFileTool({ vfs: new VirtualFS() })).not.toThrow();
    expect(() => createWriteFileTool()).not.toThrow();
  });

  it("createWriteFileTool tags the violation action as write_file", () => {
    try {
      createWriteFileTool({
        vfs: new VirtualFS(),
        permissionTier: "read-only",
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as PermissionTierViolationError).action).toBe("write_file");
    }
  });

  it("createEditFileTool throws under read-only context", () => {
    expect(() =>
      createEditFileTool({ vfs: new VirtualFS(), permissionTier: "read-only" })
    ).toThrow(PermissionTierViolationError);
  });

  it("createEditFileTool tags the violation action as edit_file", () => {
    try {
      createEditFileTool({ vfs: new VirtualFS(), permissionTier: "read-only" });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as PermissionTierViolationError).action).toBe("edit_file");
    }
  });

  it("createEditFileTool succeeds under writable tiers", () => {
    expect(() =>
      createEditFileTool({
        vfs: new VirtualFS(),
        permissionTier: "workspace-write",
      })
    ).not.toThrow();
    expect(() =>
      createEditFileTool({
        vfs: new VirtualFS(),
        permissionTier: "full-access",
      })
    ).not.toThrow();
  });

  it("createEditFileTool does not enforce tier when given a bare VirtualFS", () => {
    // Legacy VFS path: no CodegenToolContext means no tier check.
    expect(() => createEditFileTool(new VirtualFS())).not.toThrow();
  });
});

// ===========================================================================
// SandboxedWorkspace — reads local, writes route to sandbox
// ===========================================================================

describe("SandboxedWorkspace request routing", () => {
  let sandbox: MockSandbox;

  beforeEach(() => {
    sandbox = new MockSandbox();
  });

  it("delegates readFile to the local workspace (never the sandbox)", async () => {
    const inner = fakeLocalWorkspace({
      files: { "src/a.ts": "export const a = 1" },
      options: { rootDir: "/work" },
    });
    const ws = new SandboxedWorkspace(inner, sandbox);
    const content = await ws.readFile("src/a.ts");
    expect(content).toBe("export const a = 1");
    expect(inner.readCalls).toContain("src/a.ts");
    // No upload happened — read does not touch the sandbox.
    expect(sandbox.getUploadedFiles()).toEqual({});
  });

  it("routes writeFile to the sandbox, not the local fs", async () => {
    const inner = fakeLocalWorkspace({ options: { rootDir: "/work" } });
    const ws = new SandboxedWorkspace(inner, sandbox);
    await ws.writeFile("src/new.ts", "export const n = 1");
    expect(sandbox.getUploadedFiles()["src/new.ts"]).toBe("export const n = 1");
    // Inner local writeFile must NOT have been invoked.
    expect(inner.writeCalls).toEqual([]);
  });

  it("routes runCommand to the sandbox and records the command", async () => {
    const inner = fakeLocalWorkspace({ options: { rootDir: "/work" } });
    const ws = new SandboxedWorkspace(inner, sandbox);
    sandbox.configure("npm test", {
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      timedOut: false,
    });
    const result = await ws.runCommand("npm", ["test"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
    expect(sandbox.getExecutedCommands().some((c) => c.includes("npm"))).toBe(
      true
    );
  });

  it("blocks a command absent from allowedCommands without touching the sandbox", async () => {
    const inner = fakeLocalWorkspace({
      options: { rootDir: "/work", command: { allowedCommands: ["npm"] } },
    });
    const ws = new SandboxedWorkspace(inner, sandbox);
    const result = await ws.runCommand("rm", ["-rf", "/"]);
    expect(result.exitCode).toBe(126);
    expect(result.stderr).toContain("not in the allowed commands list");
    expect(sandbox.getExecutedCommands()).toEqual([]);
  });

  it("permits an allowlisted command through to the sandbox", async () => {
    const inner = fakeLocalWorkspace({
      options: {
        rootDir: "/work",
        command: { allowedCommands: ["npm", "node"] },
      },
    });
    const ws = new SandboxedWorkspace(inner, sandbox);
    await ws.runCommand("node", ["index.js"]);
    expect(
      sandbox.getExecutedCommands().some((c) => c.startsWith("node"))
    ).toBe(true);
  });

  it("escapes shell args with special characters when building the command", async () => {
    const inner = fakeLocalWorkspace({ options: { rootDir: "/work" } });
    const ws = new SandboxedWorkspace(inner, sandbox);
    await ws.runCommand("echo", ["hello world; rm -rf /"]);
    const executed = sandbox.getExecutedCommands()[0]!;
    // The dangerous arg is single-quoted, not passed as bare shell tokens.
    expect(executed).toContain("'hello world; rm -rf /'");
  });

  it("forwards exists() to the local workspace", async () => {
    const inner = fakeLocalWorkspace({
      files: { "present.ts": "x" },
      options: { rootDir: "/work" },
    });
    const ws = new SandboxedWorkspace(inner, sandbox);
    expect(await ws.exists("present.ts")).toBe(true);
    expect(await ws.exists("absent.ts")).toBe(false);
  });

  it("propagates a non-zero sandbox exit code from runCommand", async () => {
    const inner = fakeLocalWorkspace({ options: { rootDir: "/work" } });
    const ws = new SandboxedWorkspace(inner, sandbox);
    sandbox.configure("npm run build", {
      exitCode: 2,
      stdout: "",
      stderr: "build failed",
      timedOut: false,
    });
    const result = await ws.runCommand("npm", ["run", "build"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("build failed");
  });

  it("surfaces a timedOut flag from the sandbox", async () => {
    const inner = fakeLocalWorkspace({ options: { rootDir: "/work" } });
    const ws = new SandboxedWorkspace(inner, sandbox);
    sandbox.configure("sleep", {
      exitCode: 124,
      stdout: "",
      stderr: "",
      timedOut: true,
    });
    const result = await ws.runCommand("sleep", ["100"]);
    expect(result.timedOut).toBe(true);
  });

  it("exposes rootDir and options from the inner workspace", () => {
    const inner = fakeLocalWorkspace({
      options: { rootDir: "/repo", command: { allowedCommands: ["ls"] } },
    });
    const ws = new SandboxedWorkspace(inner, sandbox);
    expect(ws.rootDir).toBe("/repo");
    expect(ws.options.command?.allowedCommands).toEqual(["ls"]);
  });
});

// ===========================================================================
// MultiEdit atomicity — no partial state visible on failure
// ===========================================================================

describe("MultiEdit atomicity and coherence", () => {
  let vfs: VirtualFS;

  beforeEach(() => {
    vfs = new VirtualFS({
      "src/a.ts": "const a = 1\n",
      "src/b.ts": "const b = 2\n",
    });
  });

  it("commits all files when every edit matches", async () => {
    await callMultiEdit(vfs, [
      {
        filePath: "src/a.ts",
        edits: [{ oldText: "a = 1", newText: "a = 10" }],
      },
      {
        filePath: "src/b.ts",
        edits: [{ oldText: "b = 2", newText: "b = 20" }],
      },
    ]);
    expect(vfs.read("src/a.ts")).toContain("a = 10");
    expect(vfs.read("src/b.ts")).toContain("b = 20");
  });

  it("a file whose every edit fails is left byte-for-byte unchanged", async () => {
    const before = vfs.read("src/a.ts")!;
    await callMultiEdit(vfs, [
      { filePath: "src/a.ts", edits: [{ oldText: "NOPE", newText: "X" }] },
    ]);
    expect(vfs.read("src/a.ts")).toBe(before);
  });

  it("a missing file never causes a phantom write", async () => {
    const sizeBefore = vfs.size;
    await callMultiEdit(vfs, [
      { filePath: "src/ghost.ts", edits: [{ oldText: "a", newText: "b" }] },
    ]);
    expect(vfs.exists("src/ghost.ts")).toBe(false);
    expect(vfs.size).toBe(sizeBefore);
  });

  it("successful files commit even when a sibling file is missing", async () => {
    const before = vfs.read("src/b.ts")!;
    await callMultiEdit(vfs, [
      { filePath: "missing.ts", edits: [{ oldText: "x", newText: "y" }] },
      {
        filePath: "src/b.ts",
        edits: [{ oldText: "b = 2", newText: "b = 99" }],
      },
    ]);
    expect(vfs.read("src/b.ts")).toContain("b = 99");
    expect(vfs.read("src/b.ts")).not.toBe(before);
  });

  it("only the first occurrence is replaced per edit step", async () => {
    vfs.write("dup.ts", "k = 1\nk = 1\n");
    await callMultiEdit(vfs, [
      { filePath: "dup.ts", edits: [{ oldText: "k = 1", newText: "k = 2" }] },
    ]);
    const content = vfs.read("dup.ts")!;
    expect(content.split("k = 2").length - 1).toBe(1);
    expect(content.split("k = 1").length - 1).toBe(1);
  });

  it("keeps imports coherent across a cross-file rename in one batch", async () => {
    vfs.write("lib.ts", "export const Old = 1\n");
    vfs.write("use.ts", 'import { Old } from "./lib"\nOld\n');
    await callMultiEdit(vfs, [
      { filePath: "lib.ts", edits: [{ oldText: "Old", newText: "New" }] },
      {
        filePath: "use.ts",
        edits: [
          { oldText: "import { Old }", newText: "import { New }" },
          { oldText: "\nOld\n", newText: "\nNew\n" },
        ],
      },
    ]);
    expect(vfs.read("lib.ts")).toContain("New");
    expect(vfs.read("use.ts")).not.toContain("Old");
  });
});

// ===========================================================================
// Pipeline three-stage coherence
// ===========================================================================

describe("Pipeline three-stage coherence", () => {
  it("commits all three stages when every stage succeeds", async () => {
    const ex = new PipelineExecutor();
    const phases: PhaseConfig[] = [
      makePhase("s1", async () => ({ s1: "w1" })),
      makePhase("s2", async () => ({ s2: "w2" })),
      makePhase("s3", async () => ({ s3: "w3" })),
    ];
    const result = await ex.execute(phases, {});
    expect(result.status).toBe("completed");
    expect(result.state["s1"]).toBe("w1");
    expect(result.state["s2"]).toBe("w2");
    expect(result.state["s3"]).toBe("w3");
  });

  it("stage-2 failure prevents stage-3 from starting", async () => {
    const stage3 = vi.fn();
    const ex = new PipelineExecutor();
    const phases: PhaseConfig[] = [
      makePhase("s1", async () => ({ s1: "w1" })),
      makePhase("s2", async () => {
        throw new Error("stage-2 broke");
      }),
      makePhase("s3", async () => {
        stage3();
        return { s3: "w3" };
      }),
    ];
    const result = await ex.execute(phases, {});
    expect(result.status).toBe("failed");
    expect(stage3).not.toHaveBeenCalled();
  });

  it("stage-1 state remains visible after a stage-2 failure", async () => {
    const ex = new PipelineExecutor();
    const phases: PhaseConfig[] = [
      makePhase("s1", async () => ({ written: "stage1-output" })),
      makePhase("s2", async () => {
        throw new Error("boom");
      }),
    ];
    const result = await ex.execute(phases, {});
    expect(result.status).toBe("failed");
    expect(result.state["written"]).toBe("stage1-output");
  });

  it("surfaces the failing stage error message on result.phases", async () => {
    const ex = new PipelineExecutor();
    const phases: PhaseConfig[] = [
      makePhase("s1", async () => ({})),
      makePhase("s2", async () => {
        throw new Error("coherence-violation-42");
      }),
    ];
    const result = await ex.execute(phases, {});
    const failed = result.phases.find((p) => p.phaseId === "s2");
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toContain("coherence-violation-42");
  });

  it("does not checkpoint a failed stage", async () => {
    const onCheckpoint = vi.fn(async () => {});
    const ex = new PipelineExecutor({ onCheckpoint });
    const phases: PhaseConfig[] = [
      makePhase("s1", async () => ({ ok: true })),
      makePhase("s2", async () => {
        throw new Error("no checkpoint for me");
      }),
    ];
    await ex.execute(phases, {});
    expect(onCheckpoint).toHaveBeenCalledTimes(1);
    expect(onCheckpoint.mock.calls[0]![0]).toBe("s1");
  });

  it("threads stage output forward so stage-3 sees stage-1 and stage-2 writes", async () => {
    const ex = new PipelineExecutor();
    const phases: PhaseConfig[] = [
      makePhase("s1", async () => ({ base: 1 })),
      makePhase("s2", async (s) => ({ plus: (s["base"] as number) + 1 })),
      makePhase("s3", async (s) => ({
        sum: (s["base"] as number) + (s["plus"] as number),
      })),
    ];
    const result = await ex.execute(phases, {});
    expect(result.state["sum"]).toBe(3);
  });
});
