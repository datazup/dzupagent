/**
 * Sandbox permission tiers — comprehensive coverage of sandbox permission
 * enforcement surfaces not covered by the existing test files.
 *
 * Existing coverage in:
 *   - sandbox/permission-tiers.test.ts         (TIER_DEFAULTS, tierToDockerFlags,
 *                                               validateTierConfig, mergeTierConfig,
 *                                               tierToE2bConfig, compareTiers,
 *                                               mostRestrictiveTier)
 *   - permission-tiers.test.ts                 (repeat of above + tierAllowsWrite,
 *                                               assertTierAllowsWrite,
 *                                               PermissionTierViolationError,
 *                                               sandbox-hardening, security-profile)
 *   - sandbox-permission-coherence-deep.test.ts (tier × write-tools × SandboxedWorkspace
 *                                               × pipeline-executor integration)
 *   - lint-sandbox-permissions-deep.test.ts    (permission-tiers + sandbox-hardening
 *                                               + security-profile deep branches)
 *
 * NEW coverage areas in this file:
 *
 *  A. AuditedSandbox — execute redaction, upload recording, download recording,
 *     cleanup recording, getAuditTrail, verifyAuditChain, runId propagation
 *
 *  B. redactSecrets — API key patterns, Bearer token, AWS AKIA key, generic
 *     hex/base64 secrets, combined redaction, idempotency, no false positives
 *
 *  C. InMemoryAuditStore — hash-chain integrity across multiple sandboxes,
 *     verifyChain after append, empty chain, getBySandbox isolation,
 *     returns copies (mutation safety), brokenAt detection
 *
 *  D. SandboxPool — acquire/release lifecycle, minIdle warm-up, maxSize
 *     exhaustion → PoolExhaustedError, drain rejects waiters, metrics tracking,
 *     healthCheck on acquire evicts unhealthy sandbox, start() creates idle
 *
 *  E. CapabilityGuard — grant/revoke lifecycle, isGranted, listGranted,
 *     check throws CapabilityDeniedError, check passes after grant,
 *     check still throws after revoke, empty initial set, all capabilities
 *
 *  F. DockerResetStrategy / CloudResetStrategy — reset success/failure,
 *     CloudResetStrategy always returns false, no-exec path returns true
 *
 *  G. MockSandbox — configure/execute routing, default success, uploadFiles
 *     accumulates, downloadFiles returns subset, cleanup resets state,
 *     isAvailable respects setAvailable
 *
 *  H. Tier × capability mapping — read-only tier maps to read-only WASI
 *     capabilities, workspace-write maps to fs-write, full-access enables all
 *
 *  I. PermissionTierViolationError — stack trace preserved, instanceof chain,
 *     multiple instances independent, error properties serialisable to JSON
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  TIER_DEFAULTS,
  tierAllowsWrite,
  assertTierAllowsWrite,
  PermissionTierViolationError,
  type PermissionTier,
} from "../sandbox/permission-tiers.js";

import {
  AuditedSandbox,
  redactSecrets,
} from "../sandbox/audit/audited-sandbox.js";
import { InMemoryAuditStore } from "../sandbox/audit/memory-audit-store.js";

import {
  SandboxPool,
  PoolExhaustedError,
  type PooledSandbox,
  type SandboxPoolConfig,
} from "../sandbox/pool/sandbox-pool.js";

import {
  DockerResetStrategy,
  CloudResetStrategy,
} from "../sandbox/pool/sandbox-reset.js";

import {
  CapabilityGuard,
  CapabilityDeniedError,
  type WasiCapability,
} from "../sandbox/wasm/capability-guard.js";

import { MockSandbox } from "../sandbox/mock-sandbox.js";

// ===========================================================================
// A. redactSecrets
// ===========================================================================

describe("redactSecrets", () => {
  it("replaces api_key=<value> patterns", () => {
    const result = redactSecrets("export api_key=supersecret123");
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("supersecret123");
  });

  it("replaces token=<value> patterns", () => {
    const result = redactSecrets("token=abcdef-ghijkl");
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("abcdef-ghijkl");
  });

  it("replaces secret: <value> patterns", () => {
    const result = redactSecrets("secret: s3cr3tValue");
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("s3cr3tValue");
  });

  it("replaces Bearer token patterns", () => {
    const result = redactSecrets(
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
    );
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("replaces AWS AKIA key patterns", () => {
    const result = redactSecrets("aws_key=AKIAIOSFODNN7EXAMPLE");
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("replaces sk-prefixed generic secrets (32+ chars)", () => {
    const longSecret = "sk_" + "a".repeat(32);
    const result = redactSecrets(`MY_SECRET=${longSecret}`);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain(longSecret);
  });

  it("returns the input unchanged for a benign command", () => {
    const cmd = "node --version";
    expect(redactSecrets(cmd)).toBe(cmd);
  });

  it("returns the input unchanged when there is no sensitive value", () => {
    const cmd = "echo hello world";
    expect(redactSecrets(cmd)).toBe(cmd);
  });

  it("handles an empty string without throwing", () => {
    expect(() => redactSecrets("")).not.toThrow();
    expect(redactSecrets("")).toBe("");
  });

  it("redacts multiple secrets in one string", () => {
    const input = "token=abc123 Bearer xyz789abc";
    const result = redactSecrets(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("abc123");
    expect(result).not.toContain("xyz789abc");
  });

  it("is idempotent (redacting an already-redacted string is safe)", () => {
    const once = redactSecrets("token=secret");
    const twice = redactSecrets(once);
    expect(twice).toBe(once);
  });
});

// ===========================================================================
// B. InMemoryAuditStore
// ===========================================================================

describe("InMemoryAuditStore", () => {
  let store: InMemoryAuditStore;

  beforeEach(() => {
    store = new InMemoryAuditStore();
  });

  it("returns an empty trail for an unknown sandboxId", async () => {
    const trail = await store.getBySandbox("nonexistent");
    expect(trail).toEqual([]);
  });

  it("verifyChain returns valid:true for an empty chain", async () => {
    const result = await store.verifyChain("empty-sandbox");
    expect(result.valid).toBe(true);
    expect(result.brokenAt).toBeUndefined();
  });

  it("assigns seq=0 to the first entry", async () => {
    const entry = await store.append({
      id: "entry-1",
      sandboxId: "sb1",
      action: "execute",
      details: {},
      timestamp: new Date(),
    });
    expect(entry.seq).toBe(0);
  });

  it("assigns seq=1 to the second entry in the same chain", async () => {
    await store.append({
      id: "e1",
      sandboxId: "sb1",
      action: "execute",
      details: {},
      timestamp: new Date(),
    });
    const e2 = await store.append({
      id: "e2",
      sandboxId: "sb1",
      action: "upload",
      details: {},
      timestamp: new Date(),
    });
    expect(e2.seq).toBe(1);
  });

  it('sets previousHash="" for seq=0', async () => {
    const e = await store.append({
      id: "e0",
      sandboxId: "sb1",
      action: "execute",
      details: {},
      timestamp: new Date(),
    });
    expect(e.previousHash).toBe("");
  });

  it("sets previousHash to the prior entry hash for seq>0", async () => {
    const e1 = await store.append({
      id: "e1",
      sandboxId: "sb1",
      action: "execute",
      details: {},
      timestamp: new Date(),
    });
    const e2 = await store.append({
      id: "e2",
      sandboxId: "sb1",
      action: "upload",
      details: {},
      timestamp: new Date(),
    });
    expect(e2.previousHash).toBe(e1.hash);
  });

  it("verifyChain returns valid:true for a fresh chain", async () => {
    await store.append({
      id: "e1",
      sandboxId: "sb2",
      action: "execute",
      details: {},
      timestamp: new Date(),
    });
    await store.append({
      id: "e2",
      sandboxId: "sb2",
      action: "upload",
      details: {},
      timestamp: new Date(),
    });
    const result = await store.verifyChain("sb2");
    expect(result.valid).toBe(true);
  });

  it("isolates chains — different sandboxIds do not share seq", async () => {
    await store.append({
      id: "a1",
      sandboxId: "sbA",
      action: "execute",
      details: {},
      timestamp: new Date(),
    });
    const b1 = await store.append({
      id: "b1",
      sandboxId: "sbB",
      action: "execute",
      details: {},
      timestamp: new Date(),
    });
    expect(b1.seq).toBe(0);
  });

  it("getBySandbox returns copies — mutations do not affect the stored chain", async () => {
    await store.append({
      id: "e1",
      sandboxId: "sb3",
      action: "execute",
      details: {},
      timestamp: new Date(),
    });
    const trail = await store.getBySandbox("sb3");
    trail[0]!.action = "cleanup";
    const trail2 = await store.getBySandbox("sb3");
    expect(trail2[0]!.action).toBe("execute");
  });

  it("detects a broken chain when hash is tampered", async () => {
    await store.append({
      id: "e1",
      sandboxId: "sb4",
      action: "execute",
      details: {},
      timestamp: new Date(),
    });
    await store.append({
      id: "e2",
      sandboxId: "sb4",
      action: "upload",
      details: {},
      timestamp: new Date(),
    });
    // Directly tamper with the internal chain (reflection via private field)
    const chains = (store as unknown as { chains: Map<string, unknown[]> })
      .chains;
    const chain = chains.get("sb4")!;
    (chain[0] as Record<string, unknown>)["hash"] = "ffffffff";
    const result = await store.verifyChain("sb4");
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(0);
  });

  it("getBySandbox returns entries in seq order", async () => {
    await store.append({
      id: "a",
      sandboxId: "sb5",
      action: "execute",
      details: {},
      timestamp: new Date(),
    });
    await store.append({
      id: "b",
      sandboxId: "sb5",
      action: "upload",
      details: {},
      timestamp: new Date(),
    });
    await store.append({
      id: "c",
      sandboxId: "sb5",
      action: "download",
      details: {},
      timestamp: new Date(),
    });
    const trail = await store.getBySandbox("sb5");
    expect(trail.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it("append returns an entry with a non-empty hash", async () => {
    const e = await store.append({
      id: "e",
      sandboxId: "sb6",
      action: "cleanup",
      details: {},
      timestamp: new Date(),
    });
    expect(e.hash).toBeTruthy();
    expect(e.hash.length).toBeGreaterThan(0);
  });

  it("runId is preserved when provided", async () => {
    const e = await store.append({
      id: "e",
      sandboxId: "sb7",
      action: "execute",
      details: {},
      timestamp: new Date(),
      runId: "run-42",
    });
    expect(e.runId).toBe("run-42");
  });
});

// ===========================================================================
// C. AuditedSandbox
// ===========================================================================

describe("AuditedSandbox", () => {
  let inner: MockSandbox;
  let auditStore: InMemoryAuditStore;
  let sut: AuditedSandbox;

  beforeEach(() => {
    inner = new MockSandbox();
    auditStore = new InMemoryAuditStore();
    sut = new AuditedSandbox({
      sandbox: inner,
      store: auditStore,
      sandboxId: "test-sb",
    });
  });

  it("execute delegates to the inner sandbox", async () => {
    inner.configure("echo hi", {
      exitCode: 0,
      stdout: "hi\n",
      stderr: "",
      timedOut: false,
    });
    const result = await sut.execute("echo hi");
    expect(result.stdout).toBe("hi\n");
    expect(result.exitCode).toBe(0);
  });

  it("execute records an audit entry", async () => {
    await sut.execute("ls /work");
    const trail = await sut.getAuditTrail();
    expect(trail.length).toBe(1);
    expect(trail[0]!.action).toBe("execute");
  });

  it("execute audit entry records exit code and command", async () => {
    inner.configure('node -e "1"', {
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    });
    await sut.execute('node -e "1"');
    const trail = await sut.getAuditTrail();
    expect(trail[0]!.details["exitCode"]).toBe(0);
    expect(trail[0]!.details["command"]).toBe('node -e "1"');
  });

  it("execute redacts secrets in the audit entry command", async () => {
    await sut.execute("export token=supersecret && node app.js");
    const trail = await sut.getAuditTrail();
    const cmd = trail[0]!.details["command"] as string;
    expect(cmd).toContain("[REDACTED]");
    expect(cmd).not.toContain("supersecret");
  });

  it("execute returns the original (un-redacted) result to the caller", async () => {
    // The caller still gets the real result; only the audit log is redacted
    inner.configure("run", {
      exitCode: 0,
      stdout: "output",
      stderr: "",
      timedOut: false,
    });
    const result = await sut.execute("run");
    expect(result.stdout).toBe("output");
  });

  it("uploadFiles delegates to the inner sandbox", async () => {
    await sut.uploadFiles({ "/work/a.ts": "const x = 1" });
    const files = inner.getUploadedFiles();
    expect(files["/work/a.ts"]).toBe("const x = 1");
  });

  it("uploadFiles records an audit entry", async () => {
    await sut.uploadFiles({
      "/work/a.ts": "const x = 1",
      "/work/b.ts": "const y = 2",
    });
    const trail = await sut.getAuditTrail();
    expect(trail.length).toBe(1);
    expect(trail[0]!.action).toBe("upload");
  });

  it("uploadFiles audit entry lists uploaded file paths", async () => {
    await sut.uploadFiles({ "/work/a.ts": "content" });
    const trail = await sut.getAuditTrail();
    const files = trail[0]!.details["files"] as string[];
    expect(files).toContain("/work/a.ts");
  });

  it("uploadFiles audit entry records total bytes", async () => {
    await sut.uploadFiles({ "/work/a.ts": "hello" });
    const trail = await sut.getAuditTrail();
    expect(trail[0]!.details["totalBytes"]).toBe(5);
  });

  it("downloadFiles delegates to the inner sandbox", async () => {
    await inner.uploadFiles({ "/work/out.ts": "export {}" });
    const result = await sut.downloadFiles(["/work/out.ts"]);
    expect(result["/work/out.ts"]).toBe("export {}");
  });

  it("downloadFiles records an audit entry", async () => {
    await inner.uploadFiles({ "/work/file.ts": "x" });
    await sut.downloadFiles(["/work/file.ts"]);
    const trail = await sut.getAuditTrail();
    expect(trail.length).toBe(1);
    expect(trail[0]!.action).toBe("download");
  });

  it("downloadFiles audit entry includes requested and returned paths", async () => {
    await inner.uploadFiles({ "/work/found.ts": "y" });
    await sut.downloadFiles(["/work/found.ts", "/work/missing.ts"]);
    const trail = await sut.getAuditTrail();
    const details = trail[0]!.details;
    expect((details["requestedPaths"] as string[]).length).toBe(2);
    expect((details["returnedPaths"] as string[]).length).toBe(1);
  });

  it("cleanup records an audit entry with action=cleanup", async () => {
    await sut.cleanup();
    const trail = await sut.getAuditTrail();
    expect(trail.length).toBe(1);
    expect(trail[0]!.action).toBe("cleanup");
  });

  it("multiple operations produce sequential audit entries", async () => {
    await sut.execute("ls");
    await sut.uploadFiles({ "/work/a.ts": "a" });
    await sut.cleanup();
    const trail = await sut.getAuditTrail();
    expect(trail.length).toBe(3);
    expect(trail.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it("verifyAuditChain returns valid:true for a fresh chain", async () => {
    await sut.execute("ls");
    await sut.uploadFiles({ "/work/a.ts": "a" });
    const result = await sut.verifyAuditChain();
    expect(result.valid).toBe(true);
  });

  it("isAvailable delegates to the inner sandbox", async () => {
    inner.setAvailable(false);
    expect(await sut.isAvailable()).toBe(false);
    inner.setAvailable(true);
    expect(await sut.isAvailable()).toBe(true);
  });

  it("runId is recorded in audit entries when provided", async () => {
    const sutWithRun = new AuditedSandbox({
      sandbox: inner,
      store: auditStore,
      sandboxId: "run-sb",
      runId: "run-99",
    });
    await sutWithRun.execute("pwd");
    const trail = await sutWithRun.getAuditTrail();
    expect(trail[0]!.runId).toBe("run-99");
  });
});

// ===========================================================================
// D. SandboxPool
// ===========================================================================

function makeSandbox(id: string): PooledSandbox {
  return { id, createdAt: new Date(), lastUsedAt: new Date() };
}

function makePool(overrides: Partial<SandboxPoolConfig> = {}): SandboxPool {
  let seq = 0;
  return new SandboxPool({
    createSandbox: async () => makeSandbox(`sb-${++seq}`),
    destroySandbox: async () => {},
    ...overrides,
  });
}

describe("SandboxPool — basic acquire/release", () => {
  it("acquire returns a sandbox", async () => {
    const pool = makePool();
    const sb = await pool.acquire();
    expect(sb).toBeDefined();
    expect(sb.id).toBeTruthy();
  });

  it("acquired sandbox is tracked as active", async () => {
    const pool = makePool();
    await pool.acquire();
    expect(pool.metrics().currentActive).toBe(1);
  });

  it("released sandbox moves from active to idle", async () => {
    const pool = makePool();
    const sb = await pool.acquire();
    await pool.release(sb);
    expect(pool.metrics().currentActive).toBe(0);
    expect(pool.metrics().currentIdle).toBe(1);
  });

  it("released sandbox can be re-acquired without creating a new one", async () => {
    const pool = makePool();
    const sb1 = await pool.acquire();
    await pool.release(sb1);
    const sb2 = await pool.acquire();
    expect(sb2.id).toBe(sb1.id);
    expect(pool.metrics().totalCreated).toBe(1);
  });

  it("acquire creates up to maxSize sandboxes", async () => {
    const pool = makePool({ maxSize: 3 });
    const a = await pool.acquire();
    const b = await pool.acquire();
    const c = await pool.acquire();
    expect(pool.metrics().totalCreated).toBe(3);
    await pool.release(a);
    await pool.release(b);
    await pool.release(c);
  });

  it("acquire throws PoolExhaustedError after maxSize and timeout", async () => {
    const pool = makePool({ maxSize: 1, maxWaitMs: 50 });
    await pool.acquire(); // exhausts the pool
    await expect(pool.acquire()).rejects.toBeInstanceOf(PoolExhaustedError);
  }, 5000);

  it("PoolExhaustedError message includes the wait time", async () => {
    const pool = makePool({ maxSize: 1, maxWaitMs: 50 });
    await pool.acquire();
    try {
      await pool.acquire();
      expect.fail("should throw");
    } catch (err) {
      expect((err as PoolExhaustedError).message).toContain("50");
    }
  }, 5000);

  it("PoolExhaustedError name is PoolExhaustedError", async () => {
    const err = new PoolExhaustedError(1000);
    expect(err.name).toBe("PoolExhaustedError");
  });

  it("PoolExhaustedError is an Error subclass", () => {
    const err = new PoolExhaustedError(1000);
    expect(err).toBeInstanceOf(Error);
  });
});

describe("SandboxPool — metrics", () => {
  it("totalCreated increments with each new sandbox", async () => {
    const pool = makePool();
    await pool.acquire();
    await pool.acquire();
    expect(pool.metrics().totalCreated).toBe(2);
  });

  it("totalDestroyed increments after drain", async () => {
    const pool = makePool();
    const sb = await pool.acquire();
    await pool.release(sb);
    await pool.drain();
    expect(pool.metrics().totalDestroyed).toBe(1);
  });

  it("acquireWaitMs records a wait time per acquire", async () => {
    const pool = makePool();
    await pool.acquire();
    await pool.acquire();
    expect(pool.metrics().acquireWaitMs.length).toBe(2);
  });

  it("currentIdle is 0 before any release", async () => {
    const pool = makePool();
    await pool.acquire();
    expect(pool.metrics().currentIdle).toBe(0);
  });
});

describe("SandboxPool — start() pre-warming", () => {
  it("start() creates minIdle sandboxes in the idle pool", async () => {
    const pool = makePool({ minIdle: 3 });
    await pool.start();
    expect(pool.metrics().currentIdle).toBe(3);
    expect(pool.metrics().totalCreated).toBe(3);
    await pool.drain();
  });

  it("start() with minIdle=0 creates no sandboxes", async () => {
    const pool = makePool({ minIdle: 0 });
    await pool.start();
    expect(pool.metrics().currentIdle).toBe(0);
    await pool.drain();
  });
});

describe("SandboxPool — drain()", () => {
  it("drain() destroys idle sandboxes", async () => {
    const destroyed: string[] = [];
    const pool = new SandboxPool({
      createSandbox: async () => makeSandbox(`sb-drain-${Date.now()}`),
      destroySandbox: async (sb) => {
        destroyed.push(sb.id);
      },
    });
    const sb = await pool.acquire();
    await pool.release(sb);
    await pool.drain();
    expect(destroyed).toContain(sb.id);
  });

  it("drain() rejects pending waiters with PoolExhaustedError", async () => {
    const pool = makePool({ maxSize: 1, maxWaitMs: 60_000 });
    await pool.acquire(); // hold the only sandbox — pool is now at maxSize

    // Start a waiter (will block because pool is exhausted) and drain concurrently.
    // We must not await the waiter before draining or the test would time out.
    const waiterPromise = pool.acquire(); // queued — does NOT resolve yet
    // Drain on the next microtask so the waiter is already registered
    await Promise.resolve(); // yield to the event loop
    await pool.drain(); // should reject the waiter
    await expect(waiterPromise).rejects.toBeInstanceOf(PoolExhaustedError);
  });

  it("acquire() after drain() throws PoolExhaustedError immediately", async () => {
    const pool = makePool();
    await pool.drain();
    await expect(pool.acquire()).rejects.toBeInstanceOf(PoolExhaustedError);
  });
});

describe("SandboxPool — healthCheck on acquire", () => {
  it("evicts unhealthy idle sandbox and creates a new one", async () => {
    let callCount = 0;
    const pool = new SandboxPool({
      createSandbox: async () => makeSandbox(`sb-health-${++callCount}`),
      destroySandbox: async () => {},
      healthCheckOnAcquire: true,
      healthCheck: async (sb) => sb.id !== "sb-health-1",
    });
    const first = await pool.acquire();
    await pool.release(first); // parks sb-health-1 in idle

    const second = await pool.acquire(); // should evict unhealthy, create new
    expect(second.id).not.toBe(first.id);
  });
});

describe("SandboxPool — stale eviction failure isolation (ERR-C-03)", () => {
  it("one failing destroy does not abandon the remaining evictions", async () => {
    const destroyed: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const pool = new SandboxPool({
      createSandbox: async () => makeSandbox("unused"),
      destroySandbox: async (sb) => {
        if (sb.id === "boom") throw new Error("destroy failed");
        destroyed.push(sb.id);
      },
      idleEvictionMs: 10,
      minIdle: 0,
    });

    // Park three stale idle sandboxes directly (bypass acquire/release).
    const stale = new Date(Date.now() - 60_000);
    const idle = (pool as unknown as { idle: PooledSandbox[] }).idle;
    idle.push(
      { id: "a", createdAt: stale, lastUsedAt: stale },
      { id: "boom", createdAt: stale, lastUsedAt: stale },
      { id: "b", createdAt: stale, lastUsedAt: stale },
    );

    // Invoke the private eviction pass; it must resolve (not reject) even
    // though one destroy rejects, and the other two must still be destroyed.
    await expect(
      (pool as unknown as { evictStale: () => Promise<void> }).evictStale(),
    ).resolves.toBeUndefined();

    expect(destroyed.sort()).toEqual(["a", "b"]);
    expect(pool.metrics().currentIdle).toBe(0);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("the eviction timer callback never rejects when a destroy fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const pool = new SandboxPool({
        createSandbox: async () => makeSandbox("unused"),
        destroySandbox: async () => {
          throw new Error("destroy failed");
        },
        idleEvictionMs: 10, // timer fires every max(5ms floor) => 5_000ms; drive manually
        minIdle: 0,
      });

      const stale = new Date(Date.now() - 60_000);
      const idle = (pool as unknown as { idle: PooledSandbox[] }).idle;
      idle.push({ id: "x", createdAt: stale, lastUsedAt: stale });

      // Simulate the timer body: evictStale() with the same .catch the timer attaches.
      await expect(
        (pool as unknown as { evictStale: () => Promise<void> })
          .evictStale()
          .catch(() => {
            /* timer swallow — must not be reached because evictStale is allSettled */
          }),
      ).resolves.toBeUndefined();

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      errorSpy.mockRestore();
    }
  });
});

// ===========================================================================
// E. DockerResetStrategy / CloudResetStrategy
// ===========================================================================

describe("DockerResetStrategy", () => {
  it("returns true when no exec function is provided", async () => {
    const strategy = new DockerResetStrategy();
    const sb = makeSandbox("sb-reset");
    expect(await strategy.reset(sb)).toBe(true);
  });

  it("returns true when exec exits 0", async () => {
    const strategy = new DockerResetStrategy({
      exec: async () => ({ exitCode: 0 }),
    });
    expect(await strategy.reset(makeSandbox("sb-ok"))).toBe(true);
  });

  it("returns false when exec exits non-zero", async () => {
    const strategy = new DockerResetStrategy({
      exec: async () => ({ exitCode: 1 }),
    });
    expect(await strategy.reset(makeSandbox("sb-fail"))).toBe(false);
  });

  it("returns false when exec throws", async () => {
    const strategy = new DockerResetStrategy({
      exec: async () => {
        throw new Error("exec failed");
      },
    });
    expect(await strategy.reset(makeSandbox("sb-throw"))).toBe(false);
  });

  it("exec receives the sandboxId", async () => {
    const calledWith: string[] = [];
    const strategy = new DockerResetStrategy({
      exec: async (id) => {
        calledWith.push(id);
        return { exitCode: 0 };
      },
    });
    await strategy.reset(makeSandbox("my-sandbox-id"));
    expect(calledWith).toContain("my-sandbox-id");
  });

  it("uses custom wipePaths in the exec command", async () => {
    const commands: string[] = [];
    const strategy = new DockerResetStrategy({
      wipePaths: ["/custom/path"],
      exec: async (_id, cmd) => {
        commands.push(cmd);
        return { exitCode: 0 };
      },
    });
    await strategy.reset(makeSandbox("sb"));
    expect(commands[0]).toContain("/custom/path");
  });
});

describe("CloudResetStrategy", () => {
  it("always returns false", async () => {
    const strategy = new CloudResetStrategy();
    expect(await strategy.reset(makeSandbox("cloud-1"))).toBe(false);
    expect(await strategy.reset(makeSandbox("cloud-2"))).toBe(false);
  });

  it("never throws", async () => {
    const strategy = new CloudResetStrategy();
    await expect(strategy.reset(makeSandbox("any"))).resolves.not.toThrow();
  });
});

// ===========================================================================
// F. CapabilityGuard
// ===========================================================================

describe("CapabilityGuard", () => {
  it("check passes for a granted capability", () => {
    const guard = new CapabilityGuard(new Set<WasiCapability>(["fs-read"]));
    expect(() => guard.check("fs-read")).not.toThrow();
  });

  it("check throws CapabilityDeniedError for a missing capability", () => {
    const guard = new CapabilityGuard(new Set<WasiCapability>(["fs-read"]));
    expect(() => guard.check("fs-write")).toThrow(CapabilityDeniedError);
  });

  it("CapabilityDeniedError carries the capability name", () => {
    const guard = new CapabilityGuard(new Set<WasiCapability>());
    try {
      guard.check("env");
      expect.fail("should throw");
    } catch (err) {
      expect((err as CapabilityDeniedError).capability).toBe("env");
    }
  });

  it("CapabilityDeniedError message contains the capability", () => {
    const guard = new CapabilityGuard(new Set<WasiCapability>());
    try {
      guard.check("clock");
    } catch (err) {
      expect((err as CapabilityDeniedError).message).toContain("clock");
    }
  });

  it("CapabilityDeniedError name is CapabilityDeniedError", () => {
    const err = new CapabilityDeniedError("stdin");
    expect(err.name).toBe("CapabilityDeniedError");
  });

  it("CapabilityDeniedError is an Error subclass", () => {
    expect(new CapabilityDeniedError("stdout")).toBeInstanceOf(Error);
  });

  it("isGranted returns true for granted capability", () => {
    const guard = new CapabilityGuard(new Set<WasiCapability>(["stdout"]));
    expect(guard.isGranted("stdout")).toBe(true);
  });

  it("isGranted returns false for missing capability", () => {
    const guard = new CapabilityGuard(new Set<WasiCapability>(["stdout"]));
    expect(guard.isGranted("stderr")).toBe(false);
  });

  it("grant adds a capability", () => {
    const guard = new CapabilityGuard(new Set<WasiCapability>());
    guard.grant("random");
    expect(guard.isGranted("random")).toBe(true);
    expect(() => guard.check("random")).not.toThrow();
  });

  it("revoke removes a previously granted capability", () => {
    const guard = new CapabilityGuard(new Set<WasiCapability>(["clock"]));
    guard.revoke("clock");
    expect(guard.isGranted("clock")).toBe(false);
    expect(() => guard.check("clock")).toThrow(CapabilityDeniedError);
  });

  it("listGranted returns all currently granted capabilities", () => {
    const guard = new CapabilityGuard(
      new Set<WasiCapability>(["fs-read", "stdout", "clock"]),
    );
    const granted = guard.listGranted();
    expect(granted.sort()).toEqual(["clock", "fs-read", "stdout"]);
  });

  it("listGranted returns an empty array for an empty guard", () => {
    const guard = new CapabilityGuard(new Set<WasiCapability>());
    expect(guard.listGranted()).toEqual([]);
  });

  it("grant is idempotent — granting twice does not duplicate", () => {
    const guard = new CapabilityGuard(new Set<WasiCapability>());
    guard.grant("env");
    guard.grant("env");
    expect(guard.listGranted().filter((c) => c === "env").length).toBe(1);
  });

  it("revoking a non-granted capability does not throw", () => {
    const guard = new CapabilityGuard(new Set<WasiCapability>());
    expect(() => guard.revoke("fs-write")).not.toThrow();
  });

  it("initial constructor capabilities are independent copies", () => {
    const initial = new Set<WasiCapability>(["fs-read"]);
    const guard = new CapabilityGuard(initial);
    initial.add("fs-write");
    expect(guard.isGranted("fs-write")).toBe(false);
  });
});

// ===========================================================================
// G. MockSandbox
// ===========================================================================

describe("MockSandbox", () => {
  let sut: MockSandbox;

  beforeEach(() => {
    sut = new MockSandbox();
  });

  it("isAvailable returns true by default", async () => {
    expect(await sut.isAvailable()).toBe(true);
  });

  it("setAvailable(false) makes isAvailable() return false", async () => {
    sut.setAvailable(false);
    expect(await sut.isAvailable()).toBe(false);
  });

  it("execute returns exit code 0 by default", async () => {
    const result = await sut.execute("ls");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("configure routes exact-match commands", async () => {
    sut.configure("node app.js", {
      exitCode: 1,
      stdout: "err",
      stderr: "",
      timedOut: false,
    });
    const result = await sut.execute("node app.js");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("err");
  });

  it("configure routes substring-match commands", async () => {
    sut.configure("yarn test", {
      exitCode: 0,
      stdout: "pass",
      stderr: "",
      timedOut: false,
    });
    const result = await sut.execute(
      "cd /work && yarn test --reporter=verbose",
    );
    expect(result.stdout).toBe("pass");
  });

  it("configure routes regex-match commands", async () => {
    sut.configure(/node --version/, {
      exitCode: 0,
      stdout: "v20.0.0",
      stderr: "",
      timedOut: false,
    });
    const result = await sut.execute("node --version");
    expect(result.stdout).toBe("v20.0.0");
  });

  it("getExecutedCommands records each executed command", async () => {
    await sut.execute("ls");
    await sut.execute("pwd");
    expect(sut.getExecutedCommands()).toEqual(["ls", "pwd"]);
  });

  it("uploadFiles stores files and getUploadedFiles returns them", async () => {
    await sut.uploadFiles({ "/work/a.ts": "const a = 1" });
    expect(sut.getUploadedFiles()["/work/a.ts"]).toBe("const a = 1");
  });

  it("uploadFiles accumulates across multiple calls", async () => {
    await sut.uploadFiles({ "/work/a.ts": "a" });
    await sut.uploadFiles({ "/work/b.ts": "b" });
    const files = sut.getUploadedFiles();
    expect(files["/work/a.ts"]).toBe("a");
    expect(files["/work/b.ts"]).toBe("b");
  });

  it("downloadFiles returns only files that were uploaded", async () => {
    await sut.uploadFiles({ "/work/a.ts": "a", "/work/b.ts": "b" });
    const result = await sut.downloadFiles(["/work/a.ts", "/work/missing.ts"]);
    expect(result["/work/a.ts"]).toBe("a");
    expect(result["/work/missing.ts"]).toBeUndefined();
  });

  it("cleanup resets stored files", async () => {
    await sut.uploadFiles({ "/work/a.ts": "content" });
    await sut.cleanup();
    expect(sut.getUploadedFiles()).toEqual({});
  });

  it("cleanup resets executed commands", async () => {
    await sut.execute("ls");
    await sut.cleanup();
    expect(sut.getExecutedCommands()).toEqual([]);
  });

  it("configure returns this for chaining", () => {
    const result = sut.configure("cmd", {
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    });
    expect(result).toBe(sut);
  });

  it("setAvailable returns this for chaining", () => {
    expect(sut.setAvailable(true)).toBe(sut);
  });

  it("first configure match wins over later ones", async () => {
    sut.configure("test", {
      exitCode: 0,
      stdout: "first",
      stderr: "",
      timedOut: false,
    });
    sut.configure("test", {
      exitCode: 1,
      stdout: "second",
      stderr: "",
      timedOut: false,
    });
    const result = await sut.execute("test");
    expect(result.stdout).toBe("first");
  });
});

// ===========================================================================
// H. Tier × CapabilityGuard mapping
// ===========================================================================

describe("Tier → CapabilityGuard mapping", () => {
  function capabilitiesForTier(tier: PermissionTier): Set<WasiCapability> {
    const base: WasiCapability[] = ["stdout", "stderr", "clock", "random"];
    if (tier === "read-only") {
      return new Set([...base, "fs-read"]);
    }
    if (tier === "workspace-write") {
      return new Set([...base, "fs-read", "fs-write"]);
    }
    // full-access
    return new Set([...base, "fs-read", "fs-write", "env", "stdin"]);
  }

  it("read-only tier: fs-read granted, fs-write denied", () => {
    const guard = new CapabilityGuard(capabilitiesForTier("read-only"));
    expect(() => guard.check("fs-read")).not.toThrow();
    expect(() => guard.check("fs-write")).toThrow(CapabilityDeniedError);
  });

  it("workspace-write tier: fs-read and fs-write both granted", () => {
    const guard = new CapabilityGuard(capabilitiesForTier("workspace-write"));
    expect(() => guard.check("fs-read")).not.toThrow();
    expect(() => guard.check("fs-write")).not.toThrow();
  });

  it("full-access tier: fs-write, env, stdin all granted", () => {
    const guard = new CapabilityGuard(capabilitiesForTier("full-access"));
    expect(() => guard.check("fs-write")).not.toThrow();
    expect(() => guard.check("env")).not.toThrow();
    expect(() => guard.check("stdin")).not.toThrow();
  });

  it("escalation: upgrading from read-only to workspace-write enables fs-write", () => {
    const guard = new CapabilityGuard(capabilitiesForTier("read-only"));
    expect(() => guard.check("fs-write")).toThrow(CapabilityDeniedError);
    // Simulate tier escalation by granting fs-write
    guard.grant("fs-write");
    expect(() => guard.check("fs-write")).not.toThrow();
  });

  it("de-escalation: downgrading from full-access to read-only blocks fs-write", () => {
    const guard = new CapabilityGuard(capabilitiesForTier("full-access"));
    expect(() => guard.check("fs-write")).not.toThrow();
    // Simulate de-escalation
    guard.revoke("fs-write");
    expect(() => guard.check("fs-write")).toThrow(CapabilityDeniedError);
  });

  it("tierAllowsWrite aligns with capability write permission for each tier", () => {
    const tiers: PermissionTier[] = [
      "read-only",
      "workspace-write",
      "full-access",
    ];
    for (const tier of tiers) {
      const guard = new CapabilityGuard(capabilitiesForTier(tier));
      const canWrite = tierAllowsWrite(tier);
      if (canWrite) {
        expect(() => guard.check("fs-write")).not.toThrow();
      } else {
        expect(() => guard.check("fs-write")).toThrow(CapabilityDeniedError);
      }
    }
  });
});

// ===========================================================================
// I. PermissionTierViolationError — extra property / serialization coverage
// ===========================================================================

describe("PermissionTierViolationError — extended coverage", () => {
  it("is an instance of Error", () => {
    const err = new PermissionTierViolationError("read-only", "write_file");
    expect(err).toBeInstanceOf(Error);
  });

  it("is an instance of PermissionTierViolationError", () => {
    const err = new PermissionTierViolationError("read-only", "write_file");
    expect(err).toBeInstanceOf(PermissionTierViolationError);
  });

  it("has a non-empty stack trace", () => {
    const err = new PermissionTierViolationError("read-only", "test_action");
    expect(err.stack).toBeTruthy();
  });

  it("tier property is read-only and stable", () => {
    const err = new PermissionTierViolationError("read-only", "act");
    expect(err.tier).toBe("read-only");
  });

  it("action property is read-only and stable", () => {
    const err = new PermissionTierViolationError(
      "workspace-write",
      "custom_op",
    );
    expect(err.action).toBe("custom_op");
  });

  it("two independent instances do not share state", () => {
    const e1 = new PermissionTierViolationError("read-only", "op1");
    const e2 = new PermissionTierViolationError("workspace-write", "op2");
    expect(e1.tier).not.toBe(e2.tier);
    expect(e1.action).not.toBe(e2.action);
  });

  it("JSON.stringify includes message, tier, and action", () => {
    const err = new PermissionTierViolationError("read-only", "delete_file");
    // Errors do not serialise by default, but we can use a replacer
    const serialised = JSON.stringify({
      message: err.message,
      tier: err.tier,
      action: err.action,
      name: err.name,
    });
    const parsed = JSON.parse(serialised) as Record<string, string>;
    expect(parsed.tier).toBe("read-only");
    expect(parsed.action).toBe("delete_file");
    expect(parsed.name).toBe("PermissionTierViolationError");
  });

  it("message mentions workspace-write or full-access as remediation", () => {
    const err = new PermissionTierViolationError("read-only", "write");
    expect(err.message).toMatch(/workspace-write|full-access/);
  });

  it('assertTierAllowsWrite default action is "file write"', () => {
    try {
      assertTierAllowsWrite("read-only");
      expect.fail("should throw");
    } catch (err) {
      expect((err as PermissionTierViolationError).action).toBe("file write");
    }
  });

  it("assertTierAllowsWrite propagates custom action to error", () => {
    try {
      assertTierAllowsWrite("read-only", "my_custom_action");
      expect.fail("should throw");
    } catch (err) {
      expect((err as PermissionTierViolationError).action).toBe(
        "my_custom_action",
      );
    }
  });

  it("assertTierAllowsWrite is silent for workspace-write with custom action", () => {
    expect(() =>
      assertTierAllowsWrite("workspace-write", "append_file"),
    ).not.toThrow();
  });

  it("assertTierAllowsWrite is silent for full-access with custom action", () => {
    expect(() =>
      assertTierAllowsWrite("full-access", "nuke_file"),
    ).not.toThrow();
  });
});
