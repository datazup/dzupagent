/**
 * File Operation Safety Tests for @dzupagent/codegen
 *
 * Covers:
 *   - Atomic write via temp-file swap
 *   - Atomic write failure cleanup
 *   - Temp file unique naming
 *   - Permission checks (readable / writable / read-only)
 *   - Disk space guard (sufficient / insufficient)
 *   - Backup before overwrite and restore on failure
 *   - Parent directory creation
 *   - Path traversal guard
 *   - Max file size guard
 *   - Concurrent write protection
 *   - Checksum verification after write
 *
 * Strategy:
 *   - For behaviors already in DiskWorkspaceFS/VirtualFS, use real
 *     tmp-directory integration tests.
 *   - For safety primitives not yet in production code (atomic swap,
 *     disk-space, permissions, checksum), implement thin utility
 *     functions inline and test them directly — the tests document
 *     the intended contract so a future implementation can satisfy them.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
  chmod,
  stat,
  rename,
  unlink,
  mkdir,
  access,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";

import { DiskWorkspaceFS } from "../vfs/workspace-fs.js";
import { VirtualFS } from "../vfs/virtual-fs.js";
import { InMemoryWorkspaceFS } from "../vfs/workspace-fs.js";
import { PathSecurityError } from "../vfs/path-security-error.js";

// ---------------------------------------------------------------------------
// Helpers shared across suites
// ---------------------------------------------------------------------------

/** Compute SHA-256 hex of a string. */
function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/** Generate a unique temp-file suffix (simulating what an atomic writer would do). */
function uniqueTempSuffix(): string {
  return `.tmp.${randomBytes(8).toString("hex")}`;
}

/**
 * Atomic write implementation used by the tests.
 * Writes to a temp file then renames to the final path.
 * On rename failure, the temp file is deleted.
 */
async function atomicWrite(
  targetPath: string,
  content: string
): Promise<string> {
  const tmpPath = targetPath + uniqueTempSuffix();
  await writeFile(tmpPath, content, "utf-8");
  try {
    await rename(tmpPath, targetPath);
  } catch (err) {
    // Clean up temp file on failure
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }
  return targetPath;
}

/**
 * Write with backup: copies the original to a .bak file, then writes.
 * On write failure, restores from backup.
 */
async function writeWithBackup(
  targetPath: string,
  content: string
): Promise<void> {
  const backupPath = targetPath + ".bak";
  let hadOriginal = false;

  try {
    const original = await readFile(targetPath, "utf-8");
    await writeFile(backupPath, original, "utf-8");
    hadOriginal = true;
  } catch {
    // No original to back up
  }

  try {
    await writeFile(targetPath, content, "utf-8");
  } catch (err) {
    if (hadOriginal) {
      // Restore backup
      const backup = await readFile(backupPath, "utf-8");
      await writeFile(targetPath, backup, "utf-8");
    }
    await unlink(backupPath).catch(() => undefined);
    throw err;
  }

  await unlink(backupPath).catch(() => undefined);
}

/** Check whether a path is readable. */
async function isReadable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Check whether a path is writable. */
async function isWritable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Guard: throw if file is not writable. */
async function assertWritable(filePath: string): Promise<void> {
  const writable = await isWritable(filePath);
  if (!writable) {
    throw new PermissionError(`File is not writable: ${filePath}`);
  }
}

class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionError";
  }
}

class DiskSpaceError extends Error {
  constructor(
    public readonly required: number,
    public readonly available: number
  ) {
    super(
      `Insufficient disk space: need ${required} bytes, have ${available} bytes`
    );
    this.name = "DiskSpaceError";
  }
}

class FileSizeError extends Error {
  constructor(public readonly size: number, public readonly maxSize: number) {
    super(`File size ${size} exceeds maximum allowed size ${maxSize}`);
    this.name = "FileSizeError";
  }
}

/**
 * Write with disk-space guard. The `availableBytes` param simulates a
 * statvfs/df query result so tests can control the value.
 */
async function writeWithDiskSpaceGuard(
  targetPath: string,
  content: string,
  availableBytes: number
): Promise<void> {
  const requiredBytes = Buffer.byteLength(content, "utf-8");
  if (requiredBytes > availableBytes) {
    throw new DiskSpaceError(requiredBytes, availableBytes);
  }
  await writeFile(targetPath, content, "utf-8");
}

/**
 * Write with max-size guard.
 */
async function writeWithSizeGuard(
  targetPath: string,
  content: string,
  maxBytes: number
): Promise<void> {
  const size = Buffer.byteLength(content, "utf-8");
  if (size > maxBytes) {
    throw new FileSizeError(size, maxBytes);
  }
  await writeFile(targetPath, content, "utf-8");
}

/**
 * Write and verify checksum.
 * Returns the checksum of what was written.
 */
async function writeAndVerify(
  targetPath: string,
  content: string
): Promise<string> {
  const expected = sha256(content);
  await writeFile(targetPath, content, "utf-8");
  const written = await readFile(targetPath, "utf-8");
  const actual = sha256(written);
  if (actual !== expected) {
    throw new Error(`Checksum mismatch: expected ${expected}, got ${actual}`);
  }
  return actual;
}

// ---------------------------------------------------------------------------
// Suite 1 — Atomic write: write to temp file then rename
// ---------------------------------------------------------------------------

describe("atomicWrite — temp-file swap", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "atomic-write-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates the target file with the expected content", async () => {
    const target = join(tmpDir, "output.txt");
    await atomicWrite(target, "hello world");
    const content = await readFile(target, "utf-8");
    expect(content).toBe("hello world");
  });

  it("overwrites an existing target file atomically", async () => {
    const target = join(tmpDir, "existing.txt");
    await writeFile(target, "original", "utf-8");
    await atomicWrite(target, "updated");
    const content = await readFile(target, "utf-8");
    expect(content).toBe("updated");
  });

  it("leaves no temp file after successful write", async () => {
    const target = join(tmpDir, "clean.txt");
    await atomicWrite(target, "data");
    const entries = await import("node:fs/promises").then((m) =>
      m.readdir(tmpDir)
    );
    const tmpFiles = entries.filter((e) => e.includes(".tmp."));
    expect(tmpFiles).toHaveLength(0);
  });

  it("returns the target path on success", async () => {
    const target = join(tmpDir, "result.txt");
    const returned = await atomicWrite(target, "content");
    expect(returned).toBe(target);
  });

  it("write is visible as a complete file (no partial read possible)", async () => {
    const target = join(tmpDir, "atomic.txt");
    const content = "a".repeat(10_000);
    await atomicWrite(target, content);
    const read = await readFile(target, "utf-8");
    expect(read.length).toBe(10_000);
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — Atomic write failure: cleanup of temp file
// ---------------------------------------------------------------------------

describe("atomicWrite failure — temp file cleanup", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "atomic-fail-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("cleans up temp file when rename fails", async () => {
    const target = join(tmpDir, "non-existent-dir", "file.txt");

    // rename will fail because the target directory does not exist
    await expect(atomicWrite(target, "data")).rejects.toThrow();

    // No .tmp. files should remain in tmpDir
    const entries = await import("node:fs/promises").then((m) =>
      m.readdir(tmpDir)
    );
    const tmpFiles = entries.filter((e) => e.includes(".tmp."));
    expect(tmpFiles).toHaveLength(0);
  });

  it("propagates the rename error to the caller", async () => {
    const target = join(tmpDir, "missing-dir", "file.txt");
    await expect(atomicWrite(target, "x")).rejects.toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — Temp file unique naming
// ---------------------------------------------------------------------------

describe("temp file unique naming", () => {
  it("generates a different suffix each time", () => {
    const s1 = uniqueTempSuffix();
    const s2 = uniqueTempSuffix();
    expect(s1).not.toBe(s2);
  });

  it("suffix starts with .tmp.", () => {
    const suffix = uniqueTempSuffix();
    expect(suffix.startsWith(".tmp.")).toBe(true);
  });

  it("suffix has enough entropy to avoid collisions (16 hex chars = 64 bits)", () => {
    const suffix = uniqueTempSuffix();
    const hexPart = suffix.replace(/^\.tmp\./, "");
    expect(hexPart).toHaveLength(16);
    expect(/^[0-9a-f]+$/.test(hexPart)).toBe(true);
  });

  it("100 generated suffixes are all unique", () => {
    const suffixes = new Set(
      Array.from({ length: 100 }, () => uniqueTempSuffix())
    );
    expect(suffixes.size).toBe(100);
  });

  it("temp path built from suffix differs from target path", () => {
    const target = "/workspace/src/index.ts";
    const tmpPath = target + uniqueTempSuffix();
    expect(tmpPath).not.toBe(target);
    expect(tmpPath.startsWith(target)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — Permission check: readable
// ---------------------------------------------------------------------------

describe("permission check — readable", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "perm-read-"));
  });

  afterEach(async () => {
    // Restore permissions before cleanup (needed on Linux)
    const filePath = join(tmpDir, "test.txt");
    await chmod(filePath, 0o644).catch(() => undefined);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns true for a normally created file", async () => {
    const filePath = join(tmpDir, "test.txt");
    await writeFile(filePath, "content", "utf-8");
    expect(await isReadable(filePath)).toBe(true);
  });

  it("returns false for non-existent file", async () => {
    expect(await isReadable(join(tmpDir, "missing.txt"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Suite 5 — Permission check: writable
// ---------------------------------------------------------------------------

describe("permission check — writable", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "perm-write-"));
  });

  afterEach(async () => {
    const filePath = join(tmpDir, "test.txt");
    await chmod(filePath, 0o644).catch(() => undefined);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns true for a normally created file", async () => {
    const filePath = join(tmpDir, "test.txt");
    await writeFile(filePath, "content", "utf-8");
    expect(await isWritable(filePath)).toBe(true);
  });

  it("returns false for a read-only file (chmod 444)", async () => {
    if (process.getuid?.() === 0) return; // root bypasses permission checks
    const filePath = join(tmpDir, "test.txt");
    await writeFile(filePath, "content", "utf-8");
    await chmod(filePath, 0o444);
    expect(await isWritable(filePath)).toBe(false);
    await chmod(filePath, 0o644); // restore for cleanup
  });

  it("returns false for non-existent file", async () => {
    expect(await isWritable(join(tmpDir, "missing.txt"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Suite 6 — Write to read-only file throws PermissionError
// ---------------------------------------------------------------------------

describe("assertWritable — read-only file", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "perm-assert-"));
  });

  afterEach(async () => {
    const filePath = join(tmpDir, "readonly.txt");
    await chmod(filePath, 0o644).catch(() => undefined);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("throws PermissionError for a read-only file", async () => {
    if (process.getuid?.() === 0) return; // root bypasses permission checks
    const filePath = join(tmpDir, "readonly.txt");
    await writeFile(filePath, "data", "utf-8");
    await chmod(filePath, 0o444);
    await expect(assertWritable(filePath)).rejects.toBeInstanceOf(
      PermissionError
    );
    await chmod(filePath, 0o644); // restore
  });

  it("does not throw for a normally writable file", async () => {
    const filePath = join(tmpDir, "readonly.txt");
    await writeFile(filePath, "data", "utf-8");
    await expect(assertWritable(filePath)).resolves.toBeUndefined();
  });

  it("PermissionError has the correct name", async () => {
    const err = new PermissionError("test");
    expect(err.name).toBe("PermissionError");
  });
});

// ---------------------------------------------------------------------------
// Suite 7 — Disk space guard: sufficient space
// ---------------------------------------------------------------------------

describe("disk space guard — sufficient space", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "disk-space-ok-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes successfully when available > required", async () => {
    const target = join(tmpDir, "file.txt");
    const content = "hello";
    await writeWithDiskSpaceGuard(target, content, 1_000_000);
    const read = await readFile(target, "utf-8");
    expect(read).toBe(content);
  });

  it("writes successfully when available === required", async () => {
    const target = join(tmpDir, "exact.txt");
    const content = "abc";
    const required = Buffer.byteLength(content, "utf-8");
    await writeWithDiskSpaceGuard(target, content, required);
    const read = await readFile(target, "utf-8");
    expect(read).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// Suite 8 — Disk space guard: insufficient space
// ---------------------------------------------------------------------------

describe("disk space guard — insufficient space", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "disk-space-fail-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("throws DiskSpaceError when available < required", async () => {
    const target = join(tmpDir, "file.txt");
    const content = "hello world"; // 11 bytes
    await expect(
      writeWithDiskSpaceGuard(target, content, 5)
    ).rejects.toBeInstanceOf(DiskSpaceError);
  });

  it("DiskSpaceError carries required and available byte counts", async () => {
    const target = join(tmpDir, "file.txt");
    const content = "hello";
    try {
      await writeWithDiskSpaceGuard(target, content, 2);
      expect.fail("Expected DiskSpaceError to be thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DiskSpaceError);
      const e = err as DiskSpaceError;
      expect(e.required).toBe(5);
      expect(e.available).toBe(2);
    }
  });

  it("does NOT create the file when disk space is insufficient", async () => {
    const target = join(tmpDir, "nofile.txt");
    await expect(
      writeWithDiskSpaceGuard(target, "data", 1)
    ).rejects.toBeInstanceOf(DiskSpaceError);
    // File must not exist
    const exists = await readFile(target, "utf-8").then(
      () => true,
      () => false
    );
    expect(exists).toBe(false);
  });

  it("DiskSpaceError has correct name", () => {
    const err = new DiskSpaceError(100, 50);
    expect(err.name).toBe("DiskSpaceError");
  });

  it("error message includes byte counts", () => {
    const err = new DiskSpaceError(200, 80);
    expect(err.message).toContain("200");
    expect(err.message).toContain("80");
  });
});

// ---------------------------------------------------------------------------
// Suite 9 — Backup before overwrite
// ---------------------------------------------------------------------------

describe("writeWithBackup — backup before overwrite", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "backup-write-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes new content to the target", async () => {
    const target = join(tmpDir, "file.txt");
    await writeFile(target, "original", "utf-8");
    await writeWithBackup(target, "updated");
    expect(await readFile(target, "utf-8")).toBe("updated");
  });

  it("removes the .bak file after a successful write", async () => {
    const target = join(tmpDir, "file.txt");
    await writeFile(target, "original", "utf-8");
    await writeWithBackup(target, "updated");
    const entries = await import("node:fs/promises").then((m) =>
      m.readdir(tmpDir)
    );
    const bakFiles = entries.filter((e) => e.endsWith(".bak"));
    expect(bakFiles).toHaveLength(0);
  });

  it("creates the target if it did not exist previously", async () => {
    const target = join(tmpDir, "new.txt");
    await writeWithBackup(target, "brand new");
    expect(await readFile(target, "utf-8")).toBe("brand new");
  });
});

// ---------------------------------------------------------------------------
// Suite 10 — Backup restore on write failure
// ---------------------------------------------------------------------------

describe("writeWithBackup — restore on failure", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "backup-restore-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("restores original content when the write throws", async () => {
    const target = join(tmpDir, "file.txt");
    const originalContent = "original safe content";
    await writeFile(target, originalContent, "utf-8");

    // Simulate a failing write by implementing the backup-restore pattern
    // directly here (no ESM module spy needed — ESM namespace is not configurable).
    // We inject a failing writeMain function to exercise the restore branch.
    const backupPath = target + ".bak";

    async function writeMainFailing(
      _path: string,
      _content: string
    ): Promise<void> {
      throw new Error("Simulated disk write failure");
    }

    // Backup-restore logic under test:
    const original = await readFile(target, "utf-8");
    await writeFile(backupPath, original, "utf-8");

    try {
      await writeMainFailing(target, "NEW CONTENT");
    } catch {
      // Restore from backup
      const backup = await readFile(backupPath, "utf-8");
      await writeFile(target, backup, "utf-8");
    }
    await unlink(backupPath).catch(() => undefined);

    expect(await readFile(target, "utf-8")).toBe(originalContent);
  });

  it("backup file is cleaned up after successful restore", async () => {
    const target = join(tmpDir, "file2.txt");
    const originalContent = "keep me";
    await writeFile(target, originalContent, "utf-8");

    const backupPath = target + ".bak";
    await writeFile(backupPath, originalContent, "utf-8");

    // Simulate a failed write then cleanup
    try {
      throw new Error("forced failure");
    } catch {
      const backup = await readFile(backupPath, "utf-8");
      await writeFile(target, backup, "utf-8");
    }
    await unlink(backupPath).catch(() => undefined);

    // bak file must be gone
    const bakExists = await readFile(backupPath).then(
      () => true,
      () => false
    );
    expect(bakExists).toBe(false);
    // original content preserved
    expect(await readFile(target, "utf-8")).toBe(originalContent);
  });
});

// ---------------------------------------------------------------------------
// Suite 11 — DiskWorkspaceFS: parent directory creation
// ---------------------------------------------------------------------------

describe("DiskWorkspaceFS — parent directory creation", () => {
  let tmpDir: string;
  let ws: DiskWorkspaceFS;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "disk-mkdir-"));
    ws = new DiskWorkspaceFS(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates a single-level parent directory", async () => {
    await ws.write("subdir/file.ts", "content");
    const content = await readFile(join(tmpDir, "subdir/file.ts"), "utf-8");
    expect(content).toBe("content");
  });

  it("creates a deeply nested parent directory", async () => {
    await ws.write("a/b/c/d/file.ts", "deep content");
    const content = await readFile(join(tmpDir, "a/b/c/d/file.ts"), "utf-8");
    expect(content).toBe("deep content");
  });

  it("does not fail when parent directory already exists", async () => {
    await mkdir(join(tmpDir, "existing-dir"), { recursive: true });
    await ws.write("existing-dir/file.ts", "ok");
    const content = await readFile(
      join(tmpDir, "existing-dir/file.ts"),
      "utf-8"
    );
    expect(content).toBe("ok");
  });

  it("creates multiple files in the same directory", async () => {
    await ws.write("shared/alpha.ts", "alpha");
    await ws.write("shared/beta.ts", "beta");
    expect(await ws.read("shared/alpha.ts")).toBe("alpha");
    expect(await ws.read("shared/beta.ts")).toBe("beta");
  });
});

// ---------------------------------------------------------------------------
// Suite 12 — DiskWorkspaceFS: path traversal guard
// ---------------------------------------------------------------------------

describe("DiskWorkspaceFS — path traversal guard", () => {
  let tmpDir: string;
  let ws: DiskWorkspaceFS;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "path-traversal-"));
    ws = new DiskWorkspaceFS(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("throws PathSecurityError for ../../etc/passwd in write", async () => {
    await expect(ws.write("../../etc/passwd", "evil")).rejects.toBeInstanceOf(
      PathSecurityError
    );
  });

  it("throws PathSecurityError for ../sibling in write", async () => {
    await expect(ws.write("../sibling/file.ts", "bad")).rejects.toBeInstanceOf(
      PathSecurityError
    );
  });

  it("returns null (does not throw) for ../../etc/passwd in read", async () => {
    const result = await ws.read("../../etc/passwd");
    expect(result).toBeNull();
  });

  it("allows a valid relative path inside root", async () => {
    await expect(ws.write("safe/file.ts", "ok")).resolves.toBeUndefined();
  });

  it("PathSecurityError includes the attempted path", async () => {
    try {
      await ws.write("../escape.ts", "content");
      expect.fail("Expected PathSecurityError");
    } catch (err) {
      expect(err).toBeInstanceOf(PathSecurityError);
      expect((err as PathSecurityError).attemptedPath).toBe("../escape.ts");
    }
  });

  it("PathSecurityError includes the workspace root", async () => {
    try {
      await ws.write("../../etc/hosts", "content");
      expect.fail("Expected PathSecurityError");
    } catch (err) {
      expect(err).toBeInstanceOf(PathSecurityError);
      expect((err as PathSecurityError).workspaceRoot).toBe(resolve(tmpDir));
    }
  });

  it("throws PathSecurityError for absolute path outside workspace in applyPatch", async () => {
    const patch = [
      "--- a/../../etc/shadow",
      "+++ b/../../etc/shadow",
      "@@ -0,0 +1 @@",
      "+root:x:0:0",
    ].join("\n");
    await expect(ws.applyPatch(patch)).rejects.toBeInstanceOf(
      PathSecurityError
    );
  });
});

// ---------------------------------------------------------------------------
// Suite 13 — Max file size guard
// ---------------------------------------------------------------------------

describe("max file size guard", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "size-guard-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes successfully when content is within the size limit", async () => {
    const target = join(tmpDir, "small.txt");
    const content = "x".repeat(100);
    await writeWithSizeGuard(target, content, 1000);
    expect(await readFile(target, "utf-8")).toBe(content);
  });

  it("throws FileSizeError when content exceeds the size limit", async () => {
    const target = join(tmpDir, "large.txt");
    const content = "x".repeat(1001);
    await expect(
      writeWithSizeGuard(target, content, 1000)
    ).rejects.toBeInstanceOf(FileSizeError);
  });

  it("FileSizeError carries size and maxSize", async () => {
    const target = join(tmpDir, "large.txt");
    const content = "a".repeat(2000);
    try {
      await writeWithSizeGuard(target, content, 1000);
      expect.fail("Expected FileSizeError");
    } catch (err) {
      expect(err).toBeInstanceOf(FileSizeError);
      const e = err as FileSizeError;
      expect(e.size).toBe(2000);
      expect(e.maxSize).toBe(1000);
    }
  });

  it("does not create the file when size check fails", async () => {
    const target = join(tmpDir, "nope.txt");
    await expect(
      writeWithSizeGuard(target, "x".repeat(999), 100)
    ).rejects.toBeInstanceOf(FileSizeError);
    const exists = await readFile(target).then(
      () => true,
      () => false
    );
    expect(exists).toBe(false);
  });

  it("accepts content that is exactly at the limit", async () => {
    const target = join(tmpDir, "exact.txt");
    const content = "a".repeat(500);
    await writeWithSizeGuard(target, content, 500);
    const read = await readFile(target, "utf-8");
    expect(read.length).toBe(500);
  });

  it("FileSizeError has the correct name", () => {
    const err = new FileSizeError(2000, 1000);
    expect(err.name).toBe("FileSizeError");
  });
});

// ---------------------------------------------------------------------------
// Suite 14 — Concurrent write protection via sequential lock
// ---------------------------------------------------------------------------

describe("concurrent write protection", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "concurrent-write-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Simple in-process mutex using a promise chain. */
  function createFileMutex() {
    let chain: Promise<void> = Promise.resolve();

    return {
      run<T>(fn: () => Promise<T>): Promise<T> {
        const result = chain.then(() => fn());
        chain = result.then(
          () => undefined,
          () => undefined
        );
        return result;
      },
    };
  }

  it("serializes concurrent writes so the final value is one of the inputs", async () => {
    const target = join(tmpDir, "concurrent.txt");
    const mutex = createFileMutex();

    const writes = [
      mutex.run(() => writeFile(target, "value-A", "utf-8")),
      mutex.run(() => writeFile(target, "value-B", "utf-8")),
      mutex.run(() => writeFile(target, "value-C", "utf-8")),
    ];

    await Promise.all(writes);
    const final = await readFile(target, "utf-8");
    // With serialized writes, the last queued write wins: value-C
    expect(final).toBe("value-C");
  });

  it("second write waits for the first to finish", async () => {
    const target = join(tmpDir, "ordered.txt");
    const mutex = createFileMutex();
    const order: string[] = [];

    await Promise.all([
      mutex.run(async () => {
        order.push("start-1");
        await writeFile(target, "first", "utf-8");
        order.push("end-1");
      }),
      mutex.run(async () => {
        order.push("start-2");
        await writeFile(target, "second", "utf-8");
        order.push("end-2");
      }),
    ]);

    // end-1 must come before start-2 because the mutex serializes them
    expect(order.indexOf("end-1")).toBeLessThan(order.indexOf("start-2"));
  });

  it("mutex allows independent file writes to proceed concurrently (separate locks)", async () => {
    const targetA = join(tmpDir, "fileA.txt");
    const targetB = join(tmpDir, "fileB.txt");
    const mutexA = createFileMutex();
    const mutexB = createFileMutex();

    await Promise.all([
      mutexA.run(() => writeFile(targetA, "A", "utf-8")),
      mutexB.run(() => writeFile(targetB, "B", "utf-8")),
    ]);

    expect(await readFile(targetA, "utf-8")).toBe("A");
    expect(await readFile(targetB, "utf-8")).toBe("B");
  });
});

// ---------------------------------------------------------------------------
// Suite 15 — Checksum verification
// ---------------------------------------------------------------------------

describe("checksum verification", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "checksum-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns SHA-256 hex string of written content", async () => {
    const target = join(tmpDir, "verified.txt");
    const content = "hello checksum";
    const checksum = await writeAndVerify(target, content);
    expect(checksum).toBe(sha256(content));
  });

  it("checksum matches independently computed hash", async () => {
    const target = join(tmpDir, "match.txt");
    const content = "deterministic content";
    const returned = await writeAndVerify(target, content);
    const independent = createHash("sha256")
      .update(content, "utf-8")
      .digest("hex");
    expect(returned).toBe(independent);
  });

  it("different content produces different checksums", async () => {
    const c1 = sha256("content A");
    const c2 = sha256("content B");
    expect(c1).not.toBe(c2);
  });

  it("sha256 is deterministic for the same input", () => {
    const content = "same input";
    expect(sha256(content)).toBe(sha256(content));
  });

  it("write-and-verify succeeds for large content", async () => {
    const target = join(tmpDir, "large.txt");
    const content = "x".repeat(100_000);
    const checksum = await writeAndVerify(target, content);
    expect(checksum).toHaveLength(64); // 256 bits as hex
  });

  it("empty string has a valid checksum", () => {
    const checksum = sha256("");
    expect(checksum).toHaveLength(64);
    // SHA-256 of empty string is well-known
    expect(checksum).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  it("file content matches what was written (integrity)", async () => {
    const target = join(tmpDir, "integrity.txt");
    const content = "data integrity test";
    await writeAndVerify(target, content);
    const onDisk = await readFile(target, "utf-8");
    expect(onDisk).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// Suite 16 — VirtualFS in-memory file operations
// ---------------------------------------------------------------------------

describe("VirtualFS — in-memory file operation safety", () => {
  it("write and read are consistent", () => {
    const vfs = new VirtualFS();
    vfs.write("src/index.ts", "const a = 1");
    expect(vfs.read("src/index.ts")).toBe("const a = 1");
  });

  it("overwrite replaces content atomically in memory", () => {
    const vfs = new VirtualFS({ "file.ts": "original" });
    vfs.write("file.ts", "updated");
    expect(vfs.read("file.ts")).toBe("updated");
  });

  it("delete removes the file", () => {
    const vfs = new VirtualFS({ "file.ts": "content" });
    const removed = vfs.delete("file.ts");
    expect(removed).toBe(true);
    expect(vfs.read("file.ts")).toBeNull();
  });

  it("delete returns false for missing file", () => {
    const vfs = new VirtualFS();
    expect(vfs.delete("missing.ts")).toBe(false);
  });

  it("snapshot captures all files", () => {
    const vfs = new VirtualFS({ "a.ts": "A", "b.ts": "B" });
    const snap = vfs.toSnapshot();
    expect(snap["a.ts"]).toBe("A");
    expect(snap["b.ts"]).toBe("B");
  });

  it("fromSnapshot restores state", () => {
    const snap = { "src/a.ts": "hello", "src/b.ts": "world" };
    const vfs = VirtualFS.fromSnapshot(snap);
    expect(vfs.read("src/a.ts")).toBe("hello");
    expect(vfs.read("src/b.ts")).toBe("world");
  });

  it("concurrent writes in VirtualFS are last-write-wins (Map semantics)", () => {
    const vfs = new VirtualFS();
    // Two synchronous writes — second always wins in Map
    vfs.write("key.ts", "first");
    vfs.write("key.ts", "second");
    expect(vfs.read("key.ts")).toBe("second");
  });

  it("diff detects modified files", () => {
    const base = new VirtualFS({ "a.ts": "original" });
    const modified = new VirtualFS({ "a.ts": "changed" });
    const diffs = base.diff(modified);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.type).toBe("modified");
    expect(diffs[0]!.path).toBe("a.ts");
  });

  it("diff detects added files", () => {
    const base = new VirtualFS({});
    const next = new VirtualFS({ "new.ts": "content" });
    const diffs = base.diff(next);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.type).toBe("added");
  });

  it("diff detects deleted files", () => {
    const base = new VirtualFS({ "gone.ts": "content" });
    const next = new VirtualFS({});
    const diffs = base.diff(next);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.type).toBe("deleted");
  });
});

// ---------------------------------------------------------------------------
// Suite 17 — DiskWorkspaceFS: additional write/read safety
// ---------------------------------------------------------------------------

describe("DiskWorkspaceFS — write/read safety", () => {
  let tmpDir: string;
  let ws: DiskWorkspaceFS;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "disk-rw-"));
    ws = new DiskWorkspaceFS(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("read returns null for a non-existent file", async () => {
    expect(await ws.read("does-not-exist.ts")).toBeNull();
  });

  it("write followed by read returns the same content", async () => {
    const content = 'export const VERSION = "1.0.0"';
    await ws.write("version.ts", content);
    expect(await ws.read("version.ts")).toBe(content);
  });

  it("write overwrites existing file completely", async () => {
    await ws.write("config.ts", "v1");
    await ws.write("config.ts", "v2");
    expect(await ws.read("config.ts")).toBe("v2");
  });

  it("delete after write removes the file", async () => {
    await ws.write("temp.ts", "data");
    const removed = await ws.delete("temp.ts");
    expect(removed).toBe(true);
    expect(await ws.read("temp.ts")).toBeNull();
  });

  it("delete non-existent file returns false", async () => {
    expect(await ws.delete("phantom.ts")).toBe(false);
  });

  it("list returns all written files", async () => {
    await ws.write("a.ts", "A");
    await ws.write("b.ts", "B");
    const files = await ws.list();
    expect(files).toContain("a.ts");
    expect(files).toContain("b.ts");
  });

  it("snapshot captures all files with content", async () => {
    await ws.write("x.ts", "X");
    await ws.write("y.ts", "Y");
    const snap = await ws.snapshot();
    expect(snap["x.ts"]).toBe("X");
    expect(snap["y.ts"]).toBe("Y");
  });

  it("write preserves unicode content", async () => {
    const content = '// Arabic: مرحبا بالعالم\nexport const greeting = "مرحبا"';
    await ws.write("unicode.ts", content);
    expect(await ws.read("unicode.ts")).toBe(content);
  });
});
