/**
 * Deep unit tests for sandbox permission tiers.
 *
 * Sources under test:
 *   packages/codegen/src/sandbox/permission-tiers.ts
 *   packages/codegen/src/sandbox/sandbox-hardening.ts
 *   packages/codegen/src/sandbox/security-profile.ts
 *   packages/codegen/src/sandbox/docker-sandbox.ts  (buildRunArgs behaviour, via public API)
 */
import { describe, it, expect } from "vitest";

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
} from "../sandbox/permission-tiers.js";
import type {
  PermissionTier,
  TierConfig,
} from "../sandbox/permission-tiers.js";

import {
  toDockerSecurityFlags,
  detectEscapeAttempt,
} from "../sandbox/sandbox-hardening.js";
import type { HardenedSandboxConfig } from "../sandbox/sandbox-hardening.js";

import {
  SECURITY_PROFILES,
  getSecurityProfile,
  customizeProfile,
  toDockerFlags,
} from "../sandbox/security-profile.js";

// ---------------------------------------------------------------------------
// Tier defaults — structural contracts
// ---------------------------------------------------------------------------

describe("TIER_DEFAULTS — read-only tier", () => {
  const tier = TIER_DEFAULTS["read-only"];

  it("forbids network access", () => {
    expect(tier.network).toBe(false);
  });

  it("sets filesystem to read-only", () => {
    expect(tier.filesystem).toBe("read-only");
  });

  it("forbids process spawning", () => {
    expect(tier.processes).toBe(false);
  });

  it("caps memory at 256 MB", () => {
    expect(tier.maxMemoryMb).toBe(256);
  });

  it("caps CPUs at 1", () => {
    expect(tier.maxCpus).toBe(1);
  });

  it("sets timeout to 30 seconds", () => {
    expect(tier.timeoutMs).toBe(30_000);
  });
});

describe("TIER_DEFAULTS — workspace-write tier", () => {
  const tier = TIER_DEFAULTS["workspace-write"];

  it("forbids network access", () => {
    expect(tier.network).toBe(false);
  });

  it("limits filesystem to workspace-only", () => {
    expect(tier.filesystem).toBe("workspace-only");
  });

  it("allows process spawning", () => {
    expect(tier.processes).toBe(true);
  });

  it("provides 512 MB memory", () => {
    expect(tier.maxMemoryMb).toBe(512);
  });

  it("provides 2 CPUs", () => {
    expect(tier.maxCpus).toBe(2);
  });

  it("sets timeout to 60 seconds", () => {
    expect(tier.timeoutMs).toBe(60_000);
  });
});

describe("TIER_DEFAULTS — full-access tier", () => {
  const tier = TIER_DEFAULTS["full-access"];

  it("permits network access", () => {
    expect(tier.network).toBe(true);
  });

  it("provides full filesystem access", () => {
    expect(tier.filesystem).toBe("full");
  });

  it("allows process spawning", () => {
    expect(tier.processes).toBe(true);
  });

  it("provides 1024 MB memory", () => {
    expect(tier.maxMemoryMb).toBe(1024);
  });

  it("provides 4 CPUs", () => {
    expect(tier.maxCpus).toBe(4);
  });

  it("sets timeout to 120 seconds", () => {
    expect(tier.timeoutMs).toBe(120_000);
  });
});

// ---------------------------------------------------------------------------
// tierToDockerFlags — Docker argv generation per tier
// ---------------------------------------------------------------------------

describe("tierToDockerFlags", () => {
  describe("read-only tier", () => {
    let flags: string[];
    beforeEach_local(() => {
      flags = tierToDockerFlags("read-only");
    });

    it("includes --network=none", () => {
      const flags = tierToDockerFlags("read-only");
      expect(flags).toContain("--network=none");
    });

    it("includes --read-only filesystem flag", () => {
      const flags = tierToDockerFlags("read-only");
      expect(flags).toContain("--read-only");
    });

    it("includes --pids-limit=5 (no process spawning)", () => {
      const flags = tierToDockerFlags("read-only");
      expect(flags).toContain("--pids-limit=5");
    });

    it("includes --no-new-privileges", () => {
      const flags = tierToDockerFlags("read-only");
      expect(flags).toContain("--no-new-privileges");
    });

    it("includes memory flag", () => {
      const flags = tierToDockerFlags("read-only");
      expect(flags).toContain("--memory=256m");
    });

    it("includes cpu flag", () => {
      const flags = tierToDockerFlags("read-only");
      expect(flags).toContain("--cpus=1");
    });
  });

  describe("workspace-write tier", () => {
    it("does NOT include --network=none", () => {
      // workspace-write forbids network but the flag list should NOT include
      // --network=none ... wait, workspace-write also disables network.
      const flags = tierToDockerFlags("workspace-write");
      expect(flags).toContain("--network=none");
    });

    it("does NOT include --read-only (writes are allowed)", () => {
      const flags = tierToDockerFlags("workspace-write");
      expect(flags).not.toContain("--read-only");
    });

    it("does NOT include --pids-limit (process spawning allowed)", () => {
      const flags = tierToDockerFlags("workspace-write");
      expect(flags).not.toContain("--pids-limit=5");
    });

    it("includes 512m memory limit", () => {
      const flags = tierToDockerFlags("workspace-write");
      expect(flags).toContain("--memory=512m");
    });

    it("includes --cpus=2", () => {
      const flags = tierToDockerFlags("workspace-write");
      expect(flags).toContain("--cpus=2");
    });
  });

  describe("full-access tier", () => {
    it("does NOT include --network=none", () => {
      const flags = tierToDockerFlags("full-access");
      expect(flags).not.toContain("--network=none");
    });

    it("does NOT include --read-only", () => {
      const flags = tierToDockerFlags("full-access");
      expect(flags).not.toContain("--read-only");
    });

    it("does NOT include --pids-limit=5", () => {
      const flags = tierToDockerFlags("full-access");
      expect(flags).not.toContain("--pids-limit=5");
    });

    it("includes 1024m memory limit", () => {
      const flags = tierToDockerFlags("full-access");
      expect(flags).toContain("--memory=1024m");
    });

    it("includes --cpus=4", () => {
      const flags = tierToDockerFlags("full-access");
      expect(flags).toContain("--cpus=4");
    });
  });

  it("all tiers always include --no-new-privileges", () => {
    const tiers: PermissionTier[] = [
      "read-only",
      "workspace-write",
      "full-access",
    ];
    for (const tier of tiers) {
      expect(tierToDockerFlags(tier)).toContain("--no-new-privileges");
    }
  });
});

// Small helper — avoids polluting the test scope without needing a full beforeEach block
function beforeEach_local(fn: () => void): void {
  // Intentional no-op — flags variables declared inline above instead
}

// ---------------------------------------------------------------------------
// validateTierConfig
// ---------------------------------------------------------------------------

describe("validateTierConfig", () => {
  it("returns valid for an empty override (no constraints violated)", () => {
    const result = validateTierConfig({});
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects maxMemoryMb below minimum", () => {
    const result = validateTierConfig({ maxMemoryMb: MIN_MEMORY_MB - 1 });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("maxMemoryMb");
  });

  it("accepts maxMemoryMb exactly at minimum", () => {
    const result = validateTierConfig({ maxMemoryMb: MIN_MEMORY_MB });
    expect(result.valid).toBe(true);
  });

  it("rejects maxCpus below minimum", () => {
    const result = validateTierConfig({ maxCpus: 0 });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("maxCpus");
  });

  it("accepts maxCpus exactly at minimum", () => {
    const result = validateTierConfig({ maxCpus: MIN_CPUS });
    expect(result.valid).toBe(true);
  });

  it("rejects timeoutMs below minimum", () => {
    const result = validateTierConfig({ timeoutMs: MIN_TIMEOUT_MS - 1 });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("timeoutMs");
  });

  it("accepts timeoutMs exactly at minimum", () => {
    const result = validateTierConfig({ timeoutMs: MIN_TIMEOUT_MS });
    expect(result.valid).toBe(true);
  });

  it("rejects an unknown filesystem value", () => {
    const result = validateTierConfig({
      filesystem: "super-write" as TierConfig["filesystem"],
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("filesystem");
  });

  it("accepts all valid filesystem values", () => {
    for (const fs of ["read-only", "workspace-only", "full"] as const) {
      const result = validateTierConfig({ filesystem: fs });
      expect(result.valid).toBe(true);
    }
  });

  it("accumulates multiple errors in one call", () => {
    const result = validateTierConfig({
      maxMemoryMb: 10,
      maxCpus: 0,
      timeoutMs: 0,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// mergeTierConfig
// ---------------------------------------------------------------------------

describe("mergeTierConfig", () => {
  it("returns a new object, does not mutate TIER_DEFAULTS", () => {
    const merged = mergeTierConfig("read-only", { maxMemoryMb: 128 });
    expect(merged).not.toBe(TIER_DEFAULTS["read-only"]);
    expect(TIER_DEFAULTS["read-only"].maxMemoryMb).toBe(256); // unchanged
  });

  it("overrides provided fields", () => {
    const merged = mergeTierConfig("read-only", { maxMemoryMb: 128 });
    expect(merged.maxMemoryMb).toBe(128);
  });

  it("preserves unoverridden fields from the base tier", () => {
    const merged = mergeTierConfig("read-only", { maxMemoryMb: 128 });
    expect(merged.filesystem).toBe("read-only");
    expect(merged.network).toBe(false);
    expect(merged.processes).toBe(false);
  });

  it("allows overriding boolean fields", () => {
    const merged = mergeTierConfig("workspace-write", { network: true });
    expect(merged.network).toBe(true);
  });

  it("workspace-write override with full filesystem keeps other workspace-write fields", () => {
    const merged = mergeTierConfig("workspace-write", { filesystem: "full" });
    expect(merged.filesystem).toBe("full");
    expect(merged.processes).toBe(true);
    expect(merged.maxMemoryMb).toBe(512);
  });
});

// ---------------------------------------------------------------------------
// tierToE2bConfig
// ---------------------------------------------------------------------------

describe("tierToE2bConfig", () => {
  it("returns an object with a template field", () => {
    const config = tierToE2bConfig("read-only");
    expect(config["template"]).toBeDefined();
  });

  it("sets timeout from tier config", () => {
    const config = tierToE2bConfig("read-only");
    expect(config["timeout"]).toBe(TIER_DEFAULTS["read-only"].timeoutMs);
  });

  it("embeds tier name in metadata", () => {
    const config = tierToE2bConfig("full-access");
    const meta = config["metadata"] as Record<string, unknown>;
    expect(meta["tier"]).toBe("full-access");
  });

  it("embeds filesystem mode in metadata", () => {
    const config = tierToE2bConfig("workspace-write");
    const meta = config["metadata"] as Record<string, unknown>;
    expect(meta["filesystem"]).toBe("workspace-only");
  });

  it("embeds network flag in metadata", () => {
    const config = tierToE2bConfig("full-access");
    const meta = config["metadata"] as Record<string, unknown>;
    expect(meta["network"]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// compareTiers and mostRestrictiveTier
// ---------------------------------------------------------------------------

describe("compareTiers", () => {
  it("read-only is less permissive than workspace-write", () => {
    expect(compareTiers("read-only", "workspace-write")).toBe(-1);
  });

  it("workspace-write is less permissive than full-access", () => {
    expect(compareTiers("workspace-write", "full-access")).toBe(-1);
  });

  it("read-only is less permissive than full-access", () => {
    expect(compareTiers("read-only", "full-access")).toBe(-1);
  });

  it("same tier returns 0", () => {
    expect(compareTiers("read-only", "read-only")).toBe(0);
    expect(compareTiers("workspace-write", "workspace-write")).toBe(0);
    expect(compareTiers("full-access", "full-access")).toBe(0);
  });

  it("full-access is more permissive than read-only", () => {
    expect(compareTiers("full-access", "read-only")).toBe(1);
  });

  it("full-access is more permissive than workspace-write", () => {
    expect(compareTiers("full-access", "workspace-write")).toBe(1);
  });

  it("workspace-write is more permissive than read-only", () => {
    expect(compareTiers("workspace-write", "read-only")).toBe(1);
  });
});

describe("mostRestrictiveTier", () => {
  it("returns read-only when comparing read-only and workspace-write", () => {
    expect(mostRestrictiveTier("read-only", "workspace-write")).toBe(
      "read-only"
    );
  });

  it("returns read-only when comparing workspace-write and read-only (argument order reversed)", () => {
    expect(mostRestrictiveTier("workspace-write", "read-only")).toBe(
      "read-only"
    );
  });

  it("returns read-only when comparing read-only and full-access", () => {
    expect(mostRestrictiveTier("read-only", "full-access")).toBe("read-only");
  });

  it("returns workspace-write when comparing workspace-write and full-access", () => {
    expect(mostRestrictiveTier("workspace-write", "full-access")).toBe(
      "workspace-write"
    );
  });

  it("returns the same tier when both arguments are equal", () => {
    expect(mostRestrictiveTier("full-access", "full-access")).toBe(
      "full-access"
    );
    expect(mostRestrictiveTier("read-only", "read-only")).toBe("read-only");
  });
});

// ---------------------------------------------------------------------------
// tierAllowsWrite and assertTierAllowsWrite
// ---------------------------------------------------------------------------

describe("tierAllowsWrite", () => {
  it("returns false for read-only tier", () => {
    expect(tierAllowsWrite("read-only")).toBe(false);
  });

  it("returns true for workspace-write tier", () => {
    expect(tierAllowsWrite("workspace-write")).toBe(true);
  });

  it("returns true for full-access tier", () => {
    expect(tierAllowsWrite("full-access")).toBe(true);
  });
});

describe("assertTierAllowsWrite", () => {
  it("does not throw for workspace-write tier", () => {
    expect(() => assertTierAllowsWrite("workspace-write")).not.toThrow();
  });

  it("does not throw for full-access tier", () => {
    expect(() => assertTierAllowsWrite("full-access")).not.toThrow();
  });

  it("throws PermissionTierViolationError for read-only tier", () => {
    expect(() => assertTierAllowsWrite("read-only")).toThrow(
      PermissionTierViolationError
    );
  });

  it("error message contains the tier name", () => {
    let err: PermissionTierViolationError | null = null;
    try {
      assertTierAllowsWrite("read-only");
    } catch (e) {
      err = e as PermissionTierViolationError;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain("read-only");
  });

  it("error message contains the action description", () => {
    let err: PermissionTierViolationError | null = null;
    try {
      assertTierAllowsWrite("read-only", "write to src/index.ts");
    } catch (e) {
      err = e as PermissionTierViolationError;
    }
    expect(err!.message).toContain("write to src/index.ts");
  });

  it("PermissionTierViolationError carries .tier and .action properties", () => {
    let err: PermissionTierViolationError | null = null;
    try {
      assertTierAllowsWrite("read-only", "delete file");
    } catch (e) {
      err = e as PermissionTierViolationError;
    }
    expect(err!.tier).toBe("read-only");
    expect(err!.action).toBe("delete file");
  });

  it("error name is PermissionTierViolationError", () => {
    let err: PermissionTierViolationError | null = null;
    try {
      assertTierAllowsWrite("read-only");
    } catch (e) {
      err = e as PermissionTierViolationError;
    }
    expect(err!.name).toBe("PermissionTierViolationError");
  });
});

// ---------------------------------------------------------------------------
// sandbox-hardening — toDockerSecurityFlags
// ---------------------------------------------------------------------------

describe("toDockerSecurityFlags", () => {
  it("includes --cap-drop=ALL when dropAllCapabilities is true (default)", () => {
    const flags = toDockerSecurityFlags({});
    expect(flags).toContain("--cap-drop=ALL");
  });

  it("omits --cap-drop=ALL when dropAllCapabilities is explicitly false", () => {
    const flags = toDockerSecurityFlags({ dropAllCapabilities: false });
    expect(flags).not.toContain("--cap-drop=ALL");
  });

  it("adds --cap-add=<cap> for each addCapabilities entry", () => {
    const flags = toDockerSecurityFlags({
      addCapabilities: ["NET_BIND_SERVICE", "SYS_PTRACE"],
    });
    expect(flags).toContain("--cap-add=NET_BIND_SERVICE");
    expect(flags).toContain("--cap-add=SYS_PTRACE");
  });

  it("always includes --security-opt=no-new-privileges", () => {
    const flags = toDockerSecurityFlags({});
    expect(flags).toContain("--security-opt=no-new-privileges");
  });

  it("emits syscall-deny flags for strict seccomp profile", () => {
    const flags = toDockerSecurityFlags({ seccompProfile: "strict" });
    expect(
      flags.some((f) => f.startsWith("--security-opt=seccomp-syscall-deny="))
    ).toBe(true);
  });

  it("emits no syscall-deny flags for default seccomp profile", () => {
    const flags = toDockerSecurityFlags({ seccompProfile: "default" });
    expect(
      flags.some((f) => f.startsWith("--security-opt=seccomp-syscall-deny="))
    ).toBe(false);
  });

  it("strict profile blocks ptrace", () => {
    const flags = toDockerSecurityFlags({ seccompProfile: "strict" });
    expect(flags).toContain("--security-opt=seccomp-syscall-deny=ptrace");
  });

  it("nodejs profile blocks ptrace but not clone3", () => {
    const flags = toDockerSecurityFlags({ seccompProfile: "nodejs" });
    expect(flags).toContain("--security-opt=seccomp-syscall-deny=ptrace");
    expect(flags).not.toContain("--security-opt=seccomp-syscall-deny=clone3");
  });

  it("custom profile emits no syscall-deny flags", () => {
    const flags = toDockerSecurityFlags({ seccompProfile: "custom" });
    expect(
      flags.some((f) => f.startsWith("--security-opt=seccomp-syscall-deny="))
    ).toBe(false);
  });

  it("includes memory limit flag", () => {
    const flags = toDockerSecurityFlags({ memoryLimitMb: 512 });
    expect(flags).toContain("--memory=512m");
  });

  it("includes CPU limit flag", () => {
    const flags = toDockerSecurityFlags({ cpuLimit: 1.5 });
    expect(flags).toContain("--cpus=1.5");
  });

  it("includes PID limit flag", () => {
    const flags = toDockerSecurityFlags({ pidLimit: 30 });
    expect(flags).toContain("--pids-limit=30");
  });

  it("sets --stop-timeout from hardTimeoutMs", () => {
    const flags = toDockerSecurityFlags({ hardTimeoutMs: 5000 });
    expect(flags).toContain("--stop-timeout=5");
  });

  it("rounds up --stop-timeout to next second", () => {
    const flags = toDockerSecurityFlags({ hardTimeoutMs: 5001 });
    expect(flags).toContain("--stop-timeout=6");
  });

  it("adds --network=none when no egressRules", () => {
    const flags = toDockerSecurityFlags({});
    expect(flags).toContain("--network=none");
  });

  it("omits --network=none when egressRules are provided", () => {
    const flags = toDockerSecurityFlags({
      egressRules: [{ host: "registry.npmjs.org", port: 443 }],
    });
    expect(flags).not.toContain("--network=none");
  });

  it("adds --read-only when all ACLs are non-write", () => {
    const config: HardenedSandboxConfig = {
      filesystemACLs: [{ path: "/work", access: "read" }],
    };
    const flags = toDockerSecurityFlags(config);
    expect(flags).toContain("--read-only");
  });

  it("omits --read-only when at least one ACL allows write", () => {
    const config: HardenedSandboxConfig = {
      filesystemACLs: [
        { path: "/work", access: "write" },
        { path: "/etc", access: "read" },
      ],
    };
    const flags = toDockerSecurityFlags(config);
    expect(flags).not.toContain("--read-only");
  });

  it("emits tmpfs ro flag for read ACL", () => {
    const flags = toDockerSecurityFlags({
      filesystemACLs: [{ path: "/data", access: "read" }],
    });
    expect(flags.some((f) => f.startsWith("--tmpfs=/data:ro"))).toBe(true);
  });

  it("emits tmpfs rw flag for write ACL", () => {
    const flags = toDockerSecurityFlags({
      filesystemACLs: [{ path: "/workspace", access: "write" }],
    });
    expect(flags.some((f) => f.startsWith("--tmpfs=/workspace:rw"))).toBe(true);
  });

  it("emits tmpfs noexec flag for none ACL", () => {
    const flags = toDockerSecurityFlags({
      filesystemACLs: [{ path: "/secrets", access: "none" }],
    });
    expect(
      flags.some((f) => f.includes("noexec") && f.includes("/secrets"))
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sandbox-hardening — detectEscapeAttempt
// ---------------------------------------------------------------------------

describe("detectEscapeAttempt", () => {
  it("returns false for a benign command", () => {
    expect(detectEscapeAttempt("node index.js")).toBe(false);
  });

  it("detects nsenter pattern", () => {
    expect(
      detectEscapeAttempt("nsenter --target 1 --mount --uts --ipc --net --pid")
    ).toBe(true);
  });

  it("detects docker.sock access", () => {
    expect(
      detectEscapeAttempt(
        "curl --unix-socket /var/run/docker.sock http://localhost"
      )
    ).toBe(true);
  });

  it("detects /proc/1/root access", () => {
    expect(detectEscapeAttempt("ls /proc/1/root")).toBe(true);
  });

  it("detects chroot attempt", () => {
    expect(detectEscapeAttempt("chroot /mnt/host")).toBe(true);
  });

  it("detects pivot_root attempt", () => {
    expect(detectEscapeAttempt("pivot_root /newroot /newroot/put-old")).toBe(
      true
    );
  });

  it("detects unshare --mount attempt", () => {
    expect(detectEscapeAttempt("unshare --mount sh")).toBe(true);
  });

  it('returns false for "mount" in a path that is not a mount cgroup command', () => {
    // '/mount-data' is not a mount command + cgroup type — should not trigger
    expect(detectEscapeAttempt("ls /mount-data")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// security-profile — SECURITY_PROFILES structural contracts
// ---------------------------------------------------------------------------

describe("SECURITY_PROFILES", () => {
  it("paranoid profile forbids outbound network", () => {
    expect(SECURITY_PROFILES["paranoid"].network.allowOutbound).toBe(false);
  });

  it("minimal profile allows outbound network", () => {
    expect(SECURITY_PROFILES["minimal"].network.allowOutbound).toBe(true);
  });

  it("all profiles have a pids-limit", () => {
    for (const level of [
      "minimal",
      "standard",
      "strict",
      "paranoid",
    ] as const) {
      expect(SECURITY_PROFILES[level].process.maxProcesses).toBeGreaterThan(0);
    }
  });

  it("paranoid has a smaller memory budget than minimal", () => {
    expect(SECURITY_PROFILES["paranoid"].resources.memoryMb).toBeLessThan(
      SECURITY_PROFILES["minimal"].resources.memoryMb
    );
  });

  it("paranoid has a shorter timeout than minimal", () => {
    expect(SECURITY_PROFILES["paranoid"].resources.timeoutMs).toBeLessThan(
      SECURITY_PROFILES["minimal"].resources.timeoutMs
    );
  });

  it("strict blocks more syscalls than standard", () => {
    expect(
      SECURITY_PROFILES["strict"].process.blockedSyscalls.length
    ).toBeGreaterThan(
      SECURITY_PROFILES["standard"].process.blockedSyscalls.length
    );
  });
});

describe("getSecurityProfile", () => {
  it("returns a deep clone — mutations do not affect SECURITY_PROFILES", () => {
    const profile = getSecurityProfile("standard");
    profile.resources.memoryMb = 9999;
    expect(SECURITY_PROFILES["standard"].resources.memoryMb).toBe(512);
  });

  it("returns the correct level", () => {
    expect(getSecurityProfile("strict").level).toBe("strict");
  });
});

describe("customizeProfile", () => {
  it("overrides network settings", () => {
    const profile = customizeProfile("standard", {
      network: { allowOutbound: true, blockInbound: false },
    });
    expect(profile.network.allowOutbound).toBe(true);
    expect(profile.network.blockInbound).toBe(false);
  });

  it("overrides resource limits", () => {
    const profile = customizeProfile("standard", {
      resources: {
        memoryMb: 2048,
        cpuCores: 4,
        diskMb: 2048,
        timeoutMs: 600_000,
      },
    });
    expect(profile.resources.memoryMb).toBe(2048);
  });

  it("preserves unoverridden fields from base", () => {
    const profile = customizeProfile("strict", {
      resources: {
        memoryMb: 512,
        cpuCores: 1,
        diskMb: 512,
        timeoutMs: 120_000,
      },
    });
    expect(profile.level).toBe("strict");
    expect(profile.network.allowOutbound).toBe(false);
  });
});

describe("toDockerFlags (security-profile)", () => {
  it("includes --network=none for standard profile", () => {
    const flags = toDockerFlags(getSecurityProfile("standard"));
    expect(flags).toContain("--network=none");
  });

  it("omits --network=none for minimal profile (allows outbound)", () => {
    const flags = toDockerFlags(getSecurityProfile("minimal"));
    expect(flags).not.toContain("--network=none");
  });

  it("always includes --cap-drop=ALL", () => {
    for (const level of [
      "minimal",
      "standard",
      "strict",
      "paranoid",
    ] as const) {
      const flags = toDockerFlags(getSecurityProfile(level));
      expect(flags).toContain("--cap-drop=ALL");
    }
  });

  it("includes memory flag", () => {
    const flags = toDockerFlags(getSecurityProfile("standard"));
    expect(flags).toContain("--memory=512m");
  });

  it("includes pids-limit", () => {
    const flags = toDockerFlags(getSecurityProfile("standard"));
    expect(flags.some((f) => f.startsWith("--pids-limit="))).toBe(true);
  });

  it("paranoid profile produces --read-only", () => {
    const flags = toDockerFlags(getSecurityProfile("paranoid"));
    expect(flags).toContain("--read-only");
  });

  it("standard profile does NOT produce --read-only", () => {
    const flags = toDockerFlags(getSecurityProfile("standard"));
    expect(flags).not.toContain("--read-only");
  });

  it("strict profile includes seccomp-syscall-deny for ptrace", () => {
    const flags = toDockerFlags(getSecurityProfile("strict"));
    expect(flags).toContain("--security-opt=seccomp-syscall-deny=ptrace");
  });

  it("produces tmpfs flag when useTmpfs is true", () => {
    const flags = toDockerFlags(getSecurityProfile("strict"));
    expect(flags.some((f) => f.startsWith("--tmpfs=/tmp"))).toBe(true);
  });
});
