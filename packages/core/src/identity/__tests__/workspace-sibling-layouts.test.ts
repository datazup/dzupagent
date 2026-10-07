import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { resolveAuditWorkspaceRoot } from "./workspace-sibling.js";

test("canonical and linked checkouts resolve the same siblings; a standalone clone requires an explicit root", () => {
  const root = mkdtempSync(join(tmpdir(), "audit-layouts-"));
  const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" });
  try {
    const workspace = join(root, "workspace");
    const canonical = join(workspace, "dzupagent");
    const linked = join(root, "linked");
    const clone = join(root, "standalone", "dzupagent");
    mkdirSync(canonical, { recursive: true });
    mkdirSync(join(workspace, "scripts"));
    writeFileSync(join(workspace, "scripts/package.json"), "{}");
    writeFileSync(join(canonical, "fixture"), "source");
    git("init", "-q", canonical);
    git("-C", canonical, "add", ".");
    git("-C", canonical, "-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "commit", "-q", "-m", "fixture");
    git("-C", canonical, "worktree", "add", "--detach", linked);
    git("clone", "-q", canonical, clone);
    expect(resolveAuditWorkspaceRoot(canonical)).toBe(workspace);
    expect(resolveAuditWorkspaceRoot(linked)).toBe(workspace);
    expect(() => resolveAuditWorkspaceRoot(clone)).toThrow(/Required workspace siblings missing/);
    expect(resolveAuditWorkspaceRoot(clone, workspace)).toBe(workspace);
    expect(() => resolveAuditWorkspaceRoot(clone, "relative")).toThrow(/must be absolute/);
    expect(() => resolveAuditWorkspaceRoot(clone, root)).toThrow(/Required workspace siblings missing/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
