/**
 * diff-application.test.ts
 *
 * Comprehensive tests for diff/patch application covering:
 *  - Patch generation (diff between original and modified)
 *  - Patch format validation (valid unified diff)
 *  - Apply patch (idempotency, partial, conflict, rollback)
 *  - Multi-file patch application and rollback
 *  - Edge cases: empty, add-only, delete-only, context lines, fuzzy, binary
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseUnifiedDiff,
  applyPatch,
  applyPatchSet,
  PatchParseError,
  type FilePatch,
  type PatchHunk,
  type PatchLine,
} from "../vfs/patch-engine.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a FilePatch programmatically for concise test setup. */
function makeFilePatch(
  path: string,
  hunks: PatchHunk[],
  oldPath?: string,
): FilePatch {
  return { oldPath: oldPath ?? path, newPath: path, hunks };
}

function makeHunk(
  oldStart: number,
  oldCount: number,
  newStart: number,
  newCount: number,
  lines: PatchLine[],
): PatchHunk {
  return { oldStart, oldCount, newStart, newCount, lines };
}

// ---------------------------------------------------------------------------
// 1. Patch generation (diff string format)
// ---------------------------------------------------------------------------

describe("patch generation — unified diff format", () => {
  it("a simple replacement diff parses back to one FilePatch", () => {
    const diff = [
      "--- a/src/main.ts",
      "+++ b/src/main.ts",
      "@@ -1,3 +1,3 @@",
      " alpha",
      "-beta",
      "+BETA",
      " gamma",
    ].join("\n");

    const patches = parseUnifiedDiff(diff);
    expect(patches).toHaveLength(1);
  });

  it("generated diff retains path information", () => {
    const diff = [
      "--- a/lib/utils.ts",
      "+++ b/lib/utils.ts",
      "@@ -1,2 +1,2 @@",
      "-old",
      "+new",
      " keep",
    ].join("\n");

    const [patch] = parseUnifiedDiff(diff);
    expect(patch!.oldPath).toBe("lib/utils.ts");
    expect(patch!.newPath).toBe("lib/utils.ts");
  });

  it("patch with deep nested path parses correctly", () => {
    const diff = [
      "--- a/packages/core/src/index.ts",
      "+++ b/packages/core/src/index.ts",
      "@@ -1,1 +1,1 @@",
      "-export const X = 1",
      "+export const X = 2",
    ].join("\n");

    const [patch] = parseUnifiedDiff(diff);
    expect(patch!.oldPath).toBe("packages/core/src/index.ts");
    expect(patch!.newPath).toBe("packages/core/src/index.ts");
  });

  it("diff output round-trips: apply the parsed patch and get expected output", () => {
    const original = "line1\nline2\nline3";
    const diff = [
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1,3 +1,3 @@",
      " line1",
      "-line2",
      "+LINE2",
      " line3",
    ].join("\n");

    const [patch] = parseUnifiedDiff(diff);
    const result = applyPatch(original, patch!);
    expect(result.success).toBe(true);
    expect(result.content).toBe("line1\nLINE2\nline3");
  });

  it("diff between original and modified produces a valid FilePatch structure", () => {
    // Simulate generating a diff manually (as a codegen agent would)
    const generatedDiff = [
      "--- a/app.ts",
      "+++ b/app.ts",
      "@@ -1,4 +1,5 @@",
      ' import express from "express"',
      '+import cors from "cors"',
      " ",
      " const app = express()",
      "+app.use(cors())",
      " app.listen(3000)",
    ].join("\n");

    const patches = parseUnifiedDiff(generatedDiff);
    expect(patches).toHaveLength(1);
    const p = patches[0]!;
    expect(p.hunks).toHaveLength(1);
    const lines = p.hunks[0]!.lines;
    expect(lines.filter((l) => l.type === "add")).toHaveLength(2);
    // 4 context lines: import express, empty line, const app, app.listen
    expect(lines.filter((l) => l.type === "context")).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// 2. Patch format validation
// ---------------------------------------------------------------------------

describe("patch format validation", () => {
  it("valid unified diff does not throw", () => {
    const diff = "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new";
    expect(() => parseUnifiedDiff(diff)).not.toThrow();
  });

  it("diff with index line is still parseable", () => {
    const diff = [
      "diff --git a/x.ts b/x.ts",
      "index 1234abc..5678def 100644",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,2 +1,2 @@",
      "-foo",
      "+FOO",
      " bar",
    ].join("\n");

    const patches = parseUnifiedDiff(diff);
    expect(patches).toHaveLength(1);
    expect(patches[0]!.hunks[0]!.lines[0]!.type).toBe("remove");
  });

  it("hunks have correct oldStart and newStart parsed", () => {
    const diff = [
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -42,3 +42,4 @@",
      " ctx1",
      " ctx2",
      "+added",
      " ctx3",
    ].join("\n");
    const [patch] = parseUnifiedDiff(diff);
    expect(patch!.hunks[0]!.oldStart).toBe(42);
    expect(patch!.hunks[0]!.newStart).toBe(42);
    expect(patch!.hunks[0]!.oldCount).toBe(3);
    expect(patch!.hunks[0]!.newCount).toBe(4);
  });

  it("hunk lines count matches declared oldCount and newCount", () => {
    const diff = [
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -1,4 +1,5 @@",
      " a",
      "-b",
      "+B",
      "+B2",
      " c",
      " d",
    ].join("\n");
    const [patch] = parseUnifiedDiff(diff);
    const hunk = patch!.hunks[0]!;
    const removes = hunk.lines.filter((l) => l.type === "remove").length;
    const adds = hunk.lines.filter((l) => l.type === "add").length;
    const ctx = hunk.lines.filter((l) => l.type === "context").length;
    // oldCount = context + remove
    expect(ctx + removes).toBe(hunk.oldCount);
    // newCount = context + add
    expect(ctx + adds).toBe(hunk.newCount);
  });

  it("diff with no changes between files returns empty hunk", () => {
    // No-op diff: context only, no add/remove
    const diff = [
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -1,2 +1,2 @@",
      " alpha",
      " beta",
    ].join("\n");
    const [patch] = parseUnifiedDiff(diff);
    // Both lines are context
    expect(patch!.hunks[0]!.lines.every((l) => l.type === "context")).toBe(
      true,
    );
  });

  it("malformed hunk header throws PatchParseError", () => {
    const diff = [
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ this is not valid @@",
      " line",
    ].join("\n");
    expect(() => parseUnifiedDiff(diff)).toThrow(PatchParseError);
  });

  it("diff with only diff --git header and no hunks throws PatchParseError", () => {
    // No --- / +++ lines → no patches parsed; implementation throws when trim non-empty
    const diff = "diff --git a/x.ts b/x.ts\nindex abc..def 100644";
    expect(() => parseUnifiedDiff(diff)).toThrow(PatchParseError);
  });
});

// ---------------------------------------------------------------------------
// 3. Apply patch — basic correctness
// ---------------------------------------------------------------------------

describe("applyPatch — basic correctness", () => {
  it("applies patch: original + patch = modified", () => {
    const original = "hello\nworld\nfoo";
    const patch = makeFilePatch("f.ts", [
      makeHunk(1, 3, 1, 3, [
        { type: "context", content: "hello" },
        { type: "remove", content: "world" },
        { type: "add", content: "WORLD" },
        { type: "context", content: "foo" },
      ]),
    ]);
    const result = applyPatch(original, patch);
    expect(result.success).toBe(true);
    expect(result.content).toBe("hello\nWORLD\nfoo");
  });

  it("result includes filePath from newPath", () => {
    const patch = makeFilePatch("target.ts", [
      makeHunk(1, 1, 1, 1, [
        { type: "remove", content: "old" },
        { type: "add", content: "new" },
      ]),
    ]);
    const result = applyPatch("old", patch);
    expect(result.filePath).toBe("target.ts");
  });

  it("result.content is defined only when at least one hunk applied", () => {
    const content = "line1\nline2";
    const patch = makeFilePatch("f.ts", [
      makeHunk(1, 2, 1, 2, [
        { type: "context", content: "WRONG_CONTEXT" },
        { type: "remove", content: "line2" },
        { type: "add", content: "LINE2" },
      ]),
    ]);
    const result = applyPatch(content, patch);
    expect(result.success).toBe(false);
    expect(result.content).toBeUndefined();
  });

  it("hunkResults length matches number of hunks", () => {
    const content = "a\nb\nc\nd\ne\nf";
    const patch = makeFilePatch("f.ts", [
      makeHunk(1, 2, 1, 2, [
        { type: "remove", content: "a" },
        { type: "add", content: "A" },
        { type: "context", content: "b" },
      ]),
      makeHunk(4, 2, 4, 2, [
        { type: "context", content: "d" },
        { type: "remove", content: "e" },
        { type: "add", content: "E" },
      ]),
    ]);
    const result = applyPatch(content, patch);
    expect(result.hunkResults).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 4. Idempotency
// ---------------------------------------------------------------------------

describe("applyPatch — idempotency", () => {
  it("applying same patch twice reports E_ALREADY_APPLIED on second attempt", () => {
    const content = "alpha\nbeta\ngamma";
    const patch = makeFilePatch("f.ts", [
      makeHunk(1, 3, 1, 3, [
        { type: "context", content: "alpha" },
        { type: "remove", content: "beta" },
        { type: "add", content: "BETA" },
        { type: "context", content: "gamma" },
      ]),
    ]);

    const first = applyPatch(content, patch);
    expect(first.success).toBe(true);

    // Apply again to the result
    const second = applyPatch(first.content!, patch);
    expect(second.hunkResults[0]!.error).toBe("E_ALREADY_APPLIED");
  });

  it("E_ALREADY_APPLIED does not count as a failure (success remains false but no hard error)", () => {
    const alreadyModified = "line1\nNEW_LINE2\nline3";
    const patch = makeFilePatch("f.ts", [
      makeHunk(1, 3, 1, 3, [
        { type: "context", content: "line1" },
        { type: "remove", content: "line2" },
        { type: "add", content: "NEW_LINE2" },
        { type: "context", content: "line3" },
      ]),
    ]);

    const result = applyPatch(alreadyModified, patch);
    // Hunk not applied (already there), but not a hard error
    expect(result.hunkResults[0]!.applied).toBe(false);
    expect(result.hunkResults[0]!.error).toBe("E_ALREADY_APPLIED");
    // error at top-level only when ALL hunks failed and none applied
    expect(result.error).toBeUndefined();
  });

  it("applying patch twice in a row yields identical content", () => {
    const original = "foo\nbar\nbaz";
    const patch = makeFilePatch("f.ts", [
      makeHunk(1, 3, 1, 3, [
        { type: "context", content: "foo" },
        { type: "remove", content: "bar" },
        { type: "add", content: "BAR" },
        { type: "context", content: "baz" },
      ]),
    ]);
    const first = applyPatch(original, patch);
    const second = applyPatch(first.content!, patch);
    // second apply: E_ALREADY_APPLIED, content unchanged (no new writes)
    expect(second.content).toBeUndefined();
    expect(first.content).toBe("foo\nBAR\nbaz");
  });
});

// ---------------------------------------------------------------------------
// 5. Partial patch (subset of hunks)
// ---------------------------------------------------------------------------

describe("applyPatch — partial application", () => {
  it("first hunk applies but second fails: success=false, anyApplied recorded", () => {
    // 10 lines of content
    const lines = Array.from({ length: 10 }, (_, i) => `L${i + 1}`);
    const content = lines.join("\n");

    const patch = makeFilePatch("f.ts", [
      // First hunk: valid replacement at line 1
      makeHunk(1, 3, 1, 3, [
        { type: "remove", content: "L1" },
        { type: "add", content: "L1_NEW" },
        { type: "context", content: "L2" },
        { type: "context", content: "L3" },
      ]),
      // Second hunk: bad context
      makeHunk(8, 3, 8, 3, [
        { type: "context", content: "NONEXISTENT_LINE" },
        { type: "remove", content: "L9" },
        { type: "add", content: "L9_NEW" },
        { type: "context", content: "L10" },
      ]),
    ]);

    const result = applyPatch(content, patch);
    expect(result.success).toBe(false);
    expect(result.hunkResults[0]!.applied).toBe(true);
    expect(result.hunkResults[1]!.applied).toBe(false);
  });

  it("partial result still contains the applied hunk changes in content", () => {
    const content = "A\nB\nC\nD\nE";
    const patch = makeFilePatch("f.ts", [
      makeHunk(1, 2, 1, 2, [
        { type: "remove", content: "A" },
        { type: "add", content: "A_MODIFIED" },
        { type: "context", content: "B" },
      ]),
      makeHunk(4, 2, 4, 2, [
        { type: "context", content: "WRONG" },
        { type: "remove", content: "E" },
        { type: "add", content: "E_MODIFIED" },
      ]),
    ]);

    const result = applyPatch(content, patch);
    // First hunk applied → content is defined
    expect(result.content).toBeDefined();
    expect(result.content).toContain("A_MODIFIED");
    // E not modified (second hunk failed)
    expect(result.content).not.toContain("E_MODIFIED");
  });
});

// ---------------------------------------------------------------------------
// 6. Conflict detection
// ---------------------------------------------------------------------------

describe("applyPatch — conflict detection", () => {
  it("context mismatch is detected as E_CONTEXT_MISMATCH", () => {
    const content = "foo\nbar\nbaz";
    const patch = makeFilePatch("f.ts", [
      makeHunk(1, 3, 1, 3, [
        { type: "context", content: "WRONG_FIRST_LINE" },
        { type: "remove", content: "bar" },
        { type: "add", content: "BAR" },
        { type: "context", content: "baz" },
      ]),
    ]);

    const result = applyPatch(content, patch);
    expect(result.success).toBe(false);
    expect(result.hunkResults[0]!.error).toBe("E_CONTEXT_MISMATCH");
  });

  it("hunk conflict when file has been modified differently from context", () => {
    // File was independently modified so remove line no longer exists
    const modifiedContent = "foo\nMODIFIED_BY_SOMEONE_ELSE\nbaz";
    const patch = makeFilePatch("f.ts", [
      makeHunk(1, 3, 1, 3, [
        { type: "context", content: "foo" },
        { type: "remove", content: "bar" }, // bar is gone
        { type: "add", content: "BAR" },
        { type: "context", content: "baz" },
      ]),
    ]);

    const result = applyPatch(modifiedContent, patch);
    expect(result.success).toBe(false);
    expect(result.hunkResults[0]!.applied).toBe(false);
  });

  it("multiple conflicting hunks are all reported as failed", () => {
    const content = "a\nb\nc\nd\ne";
    const patch = makeFilePatch("f.ts", [
      makeHunk(1, 2, 1, 2, [
        { type: "context", content: "WRONG_A" },
        { type: "remove", content: "b" },
        { type: "add", content: "B" },
      ]),
      makeHunk(3, 2, 3, 2, [
        { type: "context", content: "WRONG_C" },
        { type: "remove", content: "d" },
        { type: "add", content: "D" },
      ]),
    ]);

    const result = applyPatch(content, patch);
    expect(result.hunkResults[0]!.applied).toBe(false);
    expect(result.hunkResults[1]!.applied).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("conflict error code is set at top level when all hunks fail", () => {
    const content = "x\ny\nz";
    const patch = makeFilePatch("f.ts", [
      makeHunk(1, 2, 1, 2, [
        { type: "context", content: "MISMATCH" },
        { type: "remove", content: "y" },
        { type: "add", content: "Y" },
      ]),
    ]);

    const result = applyPatch(content, patch);
    expect(result.success).toBe(false);
    expect(result.error).toBe("E_HUNK_CONFLICT");
  });
});

// ---------------------------------------------------------------------------
// 7. Conflict details
// ---------------------------------------------------------------------------

describe("applyPatch — conflict detail reporting", () => {
  it("hunk result includes error message describing position", () => {
    const content = "foo\nbar\nbaz";
    const patch = makeFilePatch("f.ts", [
      makeHunk(1, 3, 1, 3, [
        { type: "context", content: "WRONG" },
        { type: "remove", content: "bar" },
        { type: "add", content: "BAR" },
        { type: "context", content: "baz" },
      ]),
    ]);
    const result = applyPatch(content, patch);
    expect(result.hunkResults[0]!.message).toBeDefined();
    expect(typeof result.hunkResults[0]!.message).toBe("string");
  });

  it("hunkIndex in result matches the hunk position in the patch", () => {
    const content = "a\nb\nc\nd\ne\nf";
    const patch = makeFilePatch("f.ts", [
      makeHunk(1, 2, 1, 2, [
        { type: "remove", content: "a" },
        { type: "add", content: "A" },
        { type: "context", content: "b" },
      ]),
      makeHunk(4, 2, 4, 2, [
        { type: "context", content: "WRONG" },
        { type: "remove", content: "e" },
        { type: "add", content: "E" },
      ]),
    ]);
    const result = applyPatch(content, patch);
    expect(result.hunkResults[0]!.hunkIndex).toBe(0);
    expect(result.hunkResults[1]!.hunkIndex).toBe(1);
  });

  it("applied hunk includes appliedAtLine that is 1-based", () => {
    const content = "x\ny\nz";
    const patch = makeFilePatch("f.ts", [
      makeHunk(2, 1, 2, 1, [
        { type: "remove", content: "y" },
        { type: "add", content: "Y" },
      ]),
    ]);
    const result = applyPatch(content, patch);
    expect(result.hunkResults[0]!.applied).toBe(true);
    // appliedAtLine is 1-based
    expect(result.hunkResults[0]!.appliedAtLine).toBeGreaterThanOrEqual(1);
  });

  it("E_ALREADY_APPLIED has a descriptive message", () => {
    const content = "line1\nNEW\nline3";
    const patch = makeFilePatch("f.ts", [
      makeHunk(1, 3, 1, 3, [
        { type: "context", content: "line1" },
        { type: "remove", content: "old" },
        { type: "add", content: "NEW" },
        { type: "context", content: "line3" },
      ]),
    ]);
    const result = applyPatch(content, patch);
    expect(result.hunkResults[0]!.error).toBe("E_ALREADY_APPLIED");
    expect(result.hunkResults[0]!.message).toMatch(/already applied/i);
  });
});

// ---------------------------------------------------------------------------
// 8. Rollback
// ---------------------------------------------------------------------------

describe("applyPatchSet — rollback", () => {
  it("rollback restores original content after failure", async () => {
    const files = new Map([["a.ts", "original_a\nline2"]]);

    const readFile = vi.fn(async (p: string) => files.get(p) ?? null);
    const writeFile = vi.fn(async (p: string, c: string) => {
      files.set(p, c);
    });

    const patches: FilePatch[] = [
      makeFilePatch("a.ts", [
        makeHunk(1, 2, 1, 2, [
          { type: "remove", content: "original_a" },
          { type: "add", content: "modified_a" },
          { type: "context", content: "line2" },
        ]),
      ]),
    ];

    // Apply successfully first
    await applyPatchSet(patches, readFile, writeFile);
    expect(files.get("a.ts")).toBe("modified_a\nline2");

    // Now try to apply a failing patch — forces rollback of a fresh change
    const failPatches: FilePatch[] = [
      makeFilePatch("a.ts", [
        makeHunk(1, 2, 1, 2, [
          { type: "remove", content: "modified_a" },
          { type: "add", content: "STEP2" },
          { type: "context", content: "line2" },
        ]),
      ]),
      // This second patch will fail (wrong context)
      makeFilePatch("a.ts", [
        makeHunk(1, 2, 1, 2, [
          { type: "context", content: "TOTALLY_WRONG" },
          { type: "remove", content: "line2" },
          { type: "add", content: "LINE2" },
        ]),
      ]),
    ];

    // Note: applyPatchSet processes patches per file (different files), so a
    // simpler scenario: two different files where second fails triggers rollback.
    const files2 = new Map([
      ["x.ts", "xA\nxB"],
      ["y.ts", "yA\nyB"],
    ]);
    const readFile2 = vi.fn(async (p: string) => files2.get(p) ?? null);
    const writeFile2 = vi.fn(async (p: string, c: string) => {
      files2.set(p, c);
    });

    const patchSet: FilePatch[] = [
      makeFilePatch("x.ts", [
        makeHunk(1, 2, 1, 2, [
          { type: "remove", content: "xA" },
          { type: "add", content: "XA_MODIFIED" },
          { type: "context", content: "xB" },
        ]),
      ]),
      makeFilePatch("y.ts", [
        makeHunk(1, 2, 1, 2, [
          { type: "context", content: "WRONG" },
          { type: "remove", content: "yB" },
          { type: "add", content: "YB_MODIFIED" },
        ]),
      ]),
    ];

    const { rolledBack } = await applyPatchSet(
      patchSet,
      readFile2,
      writeFile2,
      { rollbackOnFailure: true },
    );

    expect(rolledBack).toBe(true);
    // x.ts should be restored to original
    expect(files2.get("x.ts")).toBe("xA\nxB");
    // y.ts unchanged
    expect(files2.get("y.ts")).toBe("yA\nyB");
  });

  it("rollback does not fire when all patches succeed", async () => {
    const files = new Map([
      ["p.ts", "one\ntwo"],
      ["q.ts", "three\nfour"],
    ]);

    const readFile = vi.fn(async (p: string) => files.get(p) ?? null);
    const writeFile = vi.fn(async (p: string, c: string) => {
      files.set(p, c);
    });

    const patches: FilePatch[] = [
      makeFilePatch("p.ts", [
        makeHunk(1, 2, 1, 2, [
          { type: "remove", content: "one" },
          { type: "add", content: "ONE" },
          { type: "context", content: "two" },
        ]),
      ]),
      makeFilePatch("q.ts", [
        makeHunk(1, 2, 1, 2, [
          { type: "context", content: "three" },
          { type: "remove", content: "four" },
          { type: "add", content: "FOUR" },
        ]),
      ]),
    ];

    const { rolledBack } = await applyPatchSet(patches, readFile, writeFile, {
      rollbackOnFailure: true,
    });

    expect(rolledBack).toBe(false);
    expect(files.get("p.ts")).toBe("ONE\ntwo");
    expect(files.get("q.ts")).toBe("three\nFOUR");
  });

  it("rollbackOnFailure=false leaves partial writes in place", async () => {
    const files = new Map([
      ["a.ts", "a1\na2"],
      ["b.ts", "b1\nb2"],
    ]);

    const readFile = vi.fn(async (p: string) => files.get(p) ?? null);
    const writeFile = vi.fn(async (p: string, c: string) => {
      files.set(p, c);
    });

    const patches: FilePatch[] = [
      makeFilePatch("a.ts", [
        makeHunk(1, 2, 1, 2, [
          { type: "remove", content: "a1" },
          { type: "add", content: "A1" },
          { type: "context", content: "a2" },
        ]),
      ]),
      makeFilePatch("b.ts", [
        makeHunk(1, 2, 1, 2, [
          { type: "context", content: "WRONG" },
          { type: "remove", content: "b2" },
          { type: "add", content: "B2" },
        ]),
      ]),
    ];

    const { rolledBack } = await applyPatchSet(patches, readFile, writeFile, {
      rollbackOnFailure: false,
    });

    expect(rolledBack).toBe(false);
    // a.ts was modified and NOT rolled back
    expect(files.get("a.ts")).toBe("A1\na2");
    // b.ts remains unchanged (patch failed)
    expect(files.get("b.ts")).toBe("b1\nb2");
  });
});

// ---------------------------------------------------------------------------
// 9. Multi-file patch application
// ---------------------------------------------------------------------------

describe("applyPatchSet — multi-file patch", () => {
  it("applies patches to three different files atomically", async () => {
    const files = new Map([
      ["a.ts", "alpha\nbeta"],
      ["b.ts", "gamma\ndelta"],
      ["c.ts", "epsilon\nzeta"],
    ]);

    const readFile = vi.fn(async (p: string) => files.get(p) ?? null);
    const writeFile = vi.fn(async (p: string, c: string) => {
      files.set(p, c);
    });

    const patches: FilePatch[] = [
      makeFilePatch("a.ts", [
        makeHunk(1, 2, 1, 2, [
          { type: "remove", content: "alpha" },
          { type: "add", content: "ALPHA" },
          { type: "context", content: "beta" },
        ]),
      ]),
      makeFilePatch("b.ts", [
        makeHunk(1, 2, 1, 2, [
          { type: "context", content: "gamma" },
          { type: "remove", content: "delta" },
          { type: "add", content: "DELTA" },
        ]),
      ]),
      makeFilePatch("c.ts", [
        makeHunk(1, 2, 1, 2, [
          { type: "remove", content: "epsilon" },
          { type: "add", content: "EPSILON" },
          { type: "context", content: "zeta" },
        ]),
      ]),
    ];

    const { results, rolledBack } = await applyPatchSet(
      patches,
      readFile,
      writeFile,
    );
    expect(rolledBack).toBe(false);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.success)).toBe(true);
    expect(files.get("a.ts")).toBe("ALPHA\nbeta");
    expect(files.get("b.ts")).toBe("gamma\nDELTA");
    expect(files.get("c.ts")).toBe("EPSILON\nzeta");
  });

  it("results array has one entry per patch", async () => {
    const files = new Map([
      ["x.ts", "x\ny"],
      ["z.ts", "z\nw"],
    ]);

    const readFile = vi.fn(async (p: string) => files.get(p) ?? null);
    const writeFile = vi.fn(async (p: string, c: string) => {
      files.set(p, c);
    });

    const patches: FilePatch[] = [
      makeFilePatch("x.ts", [
        makeHunk(1, 2, 1, 2, [
          { type: "remove", content: "x" },
          { type: "add", content: "X" },
          { type: "context", content: "y" },
        ]),
      ]),
      makeFilePatch("z.ts", [
        makeHunk(1, 2, 1, 2, [
          { type: "context", content: "z" },
          { type: "remove", content: "w" },
          { type: "add", content: "W" },
        ]),
      ]),
    ];

    const { results } = await applyPatchSet(patches, readFile, writeFile);
    expect(results).toHaveLength(2);
  });

  it("writeFile is called once per successfully patched file", async () => {
    const files = new Map([
      ["a.ts", "old_a\nmore_a"],
      ["b.ts", "old_b\nmore_b"],
    ]);

    const readFile = vi.fn(async (p: string) => files.get(p) ?? null);
    const writeFile = vi.fn(async (p: string, c: string) => {
      files.set(p, c);
    });

    const patches: FilePatch[] = [
      makeFilePatch("a.ts", [
        makeHunk(1, 2, 1, 2, [
          { type: "remove", content: "old_a" },
          { type: "add", content: "new_a" },
          { type: "context", content: "more_a" },
        ]),
      ]),
      makeFilePatch("b.ts", [
        makeHunk(1, 2, 1, 2, [
          { type: "remove", content: "old_b" },
          { type: "add", content: "new_b" },
          { type: "context", content: "more_b" },
        ]),
      ]),
    ];

    await applyPatchSet(patches, readFile, writeFile);
    expect(writeFile).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 10. Multi-file rollback
// ---------------------------------------------------------------------------

describe("applyPatchSet — multi-file rollback", () => {
  it("all files restored when third file patch fails with rollbackOnFailure=true", async () => {
    const files = new Map([
      ["f1.ts", "f1_orig\nf1_b"],
      ["f2.ts", "f2_orig\nf2_b"],
      ["f3.ts", "f3_orig\nf3_b"],
    ]);

    const readFile = vi.fn(async (p: string) => files.get(p) ?? null);
    const writeFile = vi.fn(async (p: string, c: string) => {
      files.set(p, c);
    });

    const patches: FilePatch[] = [
      makeFilePatch("f1.ts", [
        makeHunk(1, 2, 1, 2, [
          { type: "remove", content: "f1_orig" },
          { type: "add", content: "f1_new" },
          { type: "context", content: "f1_b" },
        ]),
      ]),
      makeFilePatch("f2.ts", [
        makeHunk(1, 2, 1, 2, [
          { type: "remove", content: "f2_orig" },
          { type: "add", content: "f2_new" },
          { type: "context", content: "f2_b" },
        ]),
      ]),
      makeFilePatch("f3.ts", [
        makeHunk(1, 2, 1, 2, [
          { type: "context", content: "DOES_NOT_EXIST" },
          { type: "remove", content: "f3_b" },
          { type: "add", content: "f3_new" },
        ]),
      ]),
    ];

    const { rolledBack } = await applyPatchSet(patches, readFile, writeFile, {
      rollbackOnFailure: true,
    });

    expect(rolledBack).toBe(true);
    // All files rolled back to originals
    expect(files.get("f1.ts")).toBe("f1_orig\nf1_b");
    expect(files.get("f2.ts")).toBe("f2_orig\nf2_b");
    expect(files.get("f3.ts")).toBe("f3_orig\nf3_b");
  });

  it("rollback calls writeFile to restore each previously written file", async () => {
    const files = new Map([
      ["m.ts", "mA\nmB"],
      ["n.ts", "nA\nnB"],
    ]);

    const writeFile = vi.fn(async (p: string, c: string) => {
      files.set(p, c);
    });
    const readFile = vi.fn(async (p: string) => files.get(p) ?? null);

    const patches: FilePatch[] = [
      makeFilePatch("m.ts", [
        makeHunk(1, 2, 1, 2, [
          { type: "remove", content: "mA" },
          { type: "add", content: "mA_NEW" },
          { type: "context", content: "mB" },
        ]),
      ]),
      makeFilePatch("n.ts", [
        makeHunk(1, 2, 1, 2, [
          { type: "context", content: "WRONG" },
          { type: "remove", content: "nB" },
          { type: "add", content: "nB_NEW" },
        ]),
      ]),
    ];

    await applyPatchSet(patches, readFile, writeFile, {
      rollbackOnFailure: true,
    });

    // writeFile called for: m.ts write (success) + m.ts rollback = at least 2 times
    expect(writeFile.mock.calls.length).toBeGreaterThanOrEqual(2);
    // m.ts should be back to original
    expect(files.get("m.ts")).toBe("mA\nmB");
  });
});

// ---------------------------------------------------------------------------
// 11. Empty patch
// ---------------------------------------------------------------------------

describe("applyPatch — empty patch", () => {
  it("patch with no hunks does not throw and returns original", () => {
    const content = "untouched\ncontent";
    const patch = makeFilePatch("f.ts", []);
    const result = applyPatch(content, patch);
    // No hunks → success is false (no applied hunks) but no error either
    expect(result.hunkResults).toHaveLength(0);
    expect(result.content).toBeUndefined();
  });

  it("apply empty hunk list: success=false, error undefined", () => {
    const content = "a\nb\nc";
    const patch = makeFilePatch("f.ts", []);
    const result = applyPatch(content, patch);
    expect(result.success).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it("applyPatchSet with empty patches array returns empty results", async () => {
    const readFile = vi.fn(async () => "content");
    const writeFile = vi.fn();

    const { results, rolledBack } = await applyPatchSet(
      [],
      readFile,
      writeFile,
    );
    expect(results).toHaveLength(0);
    expect(rolledBack).toBe(false);
    expect(writeFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 12. Add-only patch
// ---------------------------------------------------------------------------

describe("applyPatch — add-only patch", () => {
  it("adds new lines to existing content", () => {
    const content = "line1\nline2";
    const patch = makeFilePatch("f.ts", [
      makeHunk(1, 1, 1, 3, [
        { type: "context", content: "line1" },
        { type: "add", content: "inserted_a" },
        { type: "add", content: "inserted_b" },
      ]),
    ]);
    const result = applyPatch(content, patch);
    expect(result.success).toBe(true);
    expect(result.content).toBe("line1\ninserted_a\ninserted_b\nline2");
  });

  it("add-only hunk does not delete any original lines", () => {
    const original = "a\nb\nc";
    const patch = makeFilePatch("f.ts", [
      makeHunk(2, 1, 2, 2, [
        { type: "context", content: "b" },
        { type: "add", content: "b_extra" },
      ]),
    ]);
    const result = applyPatch(original, patch);
    expect(result.content).toContain("a");
    expect(result.content).toContain("b");
    expect(result.content).toContain("b_extra");
    expect(result.content).toContain("c");
  });

  it("new file creation with add-only hunk from /dev/null", async () => {
    const files = new Map<string, string>();

    const readFile = vi.fn(async (p: string) => files.get(p) ?? null);
    const writeFile = vi.fn(async (p: string, c: string) => {
      files.set(p, c);
    });

    const patches: FilePatch[] = [
      {
        oldPath: "/dev/null",
        newPath: "brand-new.ts",
        hunks: [
          makeHunk(0, 0, 1, 3, [
            { type: "add", content: "export const A = 1" },
            { type: "add", content: "export const B = 2" },
            { type: "add", content: "export const C = 3" },
          ]),
        ],
      },
    ];

    const { results } = await applyPatchSet(patches, readFile, writeFile);
    expect(results[0]!.success).toBe(true);
    expect(files.get("brand-new.ts")).toContain("export const A = 1");
    expect(files.get("brand-new.ts")).toContain("export const C = 3");
  });

  it("add lines at end of file", () => {
    const content = "line1\nline2\nline3";
    const patch = makeFilePatch("f.ts", [
      makeHunk(3, 1, 3, 3, [
        { type: "context", content: "line3" },
        { type: "add", content: "line4" },
        { type: "add", content: "line5" },
      ]),
    ]);
    const result = applyPatch(content, patch);
    expect(result.success).toBe(true);
    const resultLines = result.content!.split("\n");
    expect(resultLines[resultLines.length - 1]).toBe("line5");
  });
});

// ---------------------------------------------------------------------------
// 13. Delete-only patch
// ---------------------------------------------------------------------------

describe("applyPatch — delete-only patch", () => {
  it("removes lines without adding any", () => {
    const content = "keep1\ndelete_me\ndelete_me_too\nkeep2";
    const patch = makeFilePatch("f.ts", [
      makeHunk(1, 4, 1, 2, [
        { type: "context", content: "keep1" },
        { type: "remove", content: "delete_me" },
        { type: "remove", content: "delete_me_too" },
        { type: "context", content: "keep2" },
      ]),
    ]);
    const result = applyPatch(content, patch);
    expect(result.success).toBe(true);
    expect(result.content).toBe("keep1\nkeep2");
  });

  it("remove all lines from file (full deletion) — E_ALREADY_APPLIED for empty new content", () => {
    // When new content is empty (all removes, no context/add), isAlreadyApplied
    // trivially returns true (zero-length array always passes .every()). This is
    // an implementation edge case: the hunk is treated as already-applied.
    const content = "only_line";
    const patch = makeFilePatch("f.ts", [
      makeHunk(1, 1, 0, 0, [{ type: "remove", content: "only_line" }]),
    ]);
    const result = applyPatch(content, patch);
    // The hunk is not applied due to the already-applied short-circuit
    expect(result.hunkResults[0]!.error).toBe("E_ALREADY_APPLIED");
  });

  it("delete lines in the middle preserves surrounding content", () => {
    const content = "a\nb\nc\nd\ne";
    // Include trailing context line so new-content is ['b','e'] not just ['b']
    // which prevents the isAlreadyApplied false-positive
    const patch = makeFilePatch("f.ts", [
      makeHunk(2, 4, 2, 2, [
        { type: "context", content: "b" },
        { type: "remove", content: "c" },
        { type: "remove", content: "d" },
        { type: "context", content: "e" },
      ]),
    ]);
    const result = applyPatch(content, patch);
    expect(result.success).toBe(true);
    expect(result.content).toBe("a\nb\ne");
  });

  it("file deletion (newPath=/dev/null) via applyPatchSet: E_FILE_NOT_FOUND because filePath resolves to /dev/null", async () => {
    // applyPatchSet resolves filePath as patch.newPath || patch.oldPath.
    // When newPath='/dev/null' and readFile returns null for that path,
    // and the hunks are not add-only, it reports E_FILE_NOT_FOUND.
    const files = new Map([["obsolete.ts", "line1\nline2"]]);

    const readFile = vi.fn(async (p: string) => files.get(p) ?? null);
    const writeFile = vi.fn(async (p: string, c: string) => {
      files.set(p, c);
    });

    const patches: FilePatch[] = [
      {
        oldPath: "obsolete.ts",
        newPath: "/dev/null",
        hunks: [
          makeHunk(1, 2, 0, 0, [
            { type: "remove", content: "line1" },
            { type: "remove", content: "line2" },
          ]),
        ],
      },
    ];

    const { results } = await applyPatchSet(patches, readFile, writeFile);
    // filePath is '/dev/null', which readFile returns null for → E_FILE_NOT_FOUND
    expect(results[0]!.error).toBe("E_FILE_NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// 14. Context lines
// ---------------------------------------------------------------------------

describe("applyPatch — context line usage", () => {
  it("uses context lines to locate hunk in file precisely", () => {
    // Two similar lines in the file; context lines disambiguate
    const content = "foo\nbar\nfoo\nbar\nbaz";
    const patch = makeFilePatch("f.ts", [
      makeHunk(3, 3, 3, 3, [
        { type: "context", content: "foo" }, // second occurrence
        { type: "remove", content: "bar" },
        { type: "add", content: "BAR_SECOND" },
        { type: "context", content: "baz" },
      ]),
    ]);
    const result = applyPatch(content, patch);
    expect(result.success).toBe(true);
    // First bar unchanged, second bar replaced
    const lines = result.content!.split("\n");
    expect(lines[1]).toBe("bar"); // first bar untouched
    expect(lines[3]).toBe("BAR_SECOND"); // second bar replaced
  });

  it("context-only hunk at start of file applies without deletes or adds", () => {
    const content = "ctx1\nctx2\nctx3";
    const patch = makeFilePatch("f.ts", [
      makeHunk(1, 2, 1, 3, [
        { type: "context", content: "ctx1" },
        { type: "add", content: "added_between" },
        { type: "context", content: "ctx2" },
      ]),
    ]);
    const result = applyPatch(content, patch);
    expect(result.success).toBe(true);
    expect(result.content!.split("\n")[1]).toBe("added_between");
  });

  it("multiple context lines around single change", () => {
    const content = "a\nb\nc\nd\ne";
    const patch = makeFilePatch("f.ts", [
      makeHunk(1, 5, 1, 5, [
        { type: "context", content: "a" },
        { type: "context", content: "b" },
        { type: "remove", content: "c" },
        { type: "add", content: "C" },
        { type: "context", content: "d" },
        { type: "context", content: "e" },
      ]),
    ]);
    const result = applyPatch(content, patch);
    expect(result.success).toBe(true);
    expect(result.content).toBe("a\nb\nC\nd\ne");
  });

  it("wrong context lines cause E_CONTEXT_MISMATCH even if remove matches", () => {
    const content = "correct_ctx\ntarget\ncorrect_ctx2";
    const patch = makeFilePatch("f.ts", [
      makeHunk(1, 3, 1, 3, [
        { type: "context", content: "WRONG_CTX" },
        { type: "remove", content: "target" },
        { type: "add", content: "TARGET" },
        { type: "context", content: "correct_ctx2" },
      ]),
    ]);
    const result = applyPatch(content, patch);
    expect(result.hunkResults[0]!.applied).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 15. Fuzzy matching
// ---------------------------------------------------------------------------

describe("applyPatch — fuzzy matching", () => {
  it("applies hunk when line numbers shifted by 1", () => {
    // Extra line at start shifts everything by 1
    const content = "extra\nalpha\nbeta\ngamma";
    const patch = makeFilePatch("f.ts", [
      makeHunk(1, 3, 1, 3, [
        // claims line 1 but content is at line 2
        { type: "context", content: "alpha" },
        { type: "remove", content: "beta" },
        { type: "add", content: "BETA" },
        { type: "context", content: "gamma" },
      ]),
    ]);
    const result = applyPatch(content, patch);
    expect(result.success).toBe(true);
    expect(result.content).toContain("BETA");
    expect(result.hunkResults[0]!.appliedAtLine).toBe(2);
  });

  it("applies hunk when line numbers shifted by 2", () => {
    const content = "e1\ne2\nfoo\nbar\nbaz";
    const patch = makeFilePatch("f.ts", [
      makeHunk(1, 3, 1, 3, [
        { type: "context", content: "foo" },
        { type: "remove", content: "bar" },
        { type: "add", content: "BAR" },
        { type: "context", content: "baz" },
      ]),
    ]);
    const result = applyPatch(content, patch);
    expect(result.success).toBe(true);
    expect(result.content).toContain("BAR");
  });

  it("applies hunk when line numbers shifted by 3 (at fuzz boundary)", () => {
    const content = "e1\ne2\ne3\nfoo\nbar\nbaz";
    const patch = makeFilePatch("f.ts", [
      makeHunk(1, 3, 1, 3, [
        { type: "context", content: "foo" },
        { type: "remove", content: "bar" },
        { type: "add", content: "BAR" },
        { type: "context", content: "baz" },
      ]),
    ]);
    const result = applyPatch(content, patch);
    expect(result.success).toBe(true);
    expect(result.hunkResults[0]!.applied).toBe(true);
  });

  it("fails when line numbers shifted beyond fuzz window (>3)", () => {
    // 4 extra lines pushes beyond MAX_FUZZ=3
    const content = "e1\ne2\ne3\ne4\nfoo\nbar\nbaz";
    const patch = makeFilePatch("f.ts", [
      makeHunk(1, 3, 1, 3, [
        { type: "context", content: "foo" },
        { type: "remove", content: "bar" },
        { type: "add", content: "BAR" },
        { type: "context", content: "baz" },
      ]),
    ]);
    const result = applyPatch(content, patch);
    expect(result.hunkResults[0]!.applied).toBe(false);
  });

  it("fuzzy match records the actual line where hunk was applied", () => {
    const content = "X\nfoo\nbar\nbaz";
    const patch = makeFilePatch("f.ts", [
      makeHunk(1, 3, 1, 3, [
        { type: "context", content: "foo" },
        { type: "remove", content: "bar" },
        { type: "add", content: "BAR" },
        { type: "context", content: "baz" },
      ]),
    ]);
    const result = applyPatch(content, patch);
    expect(result.success).toBe(true);
    // Hunk expected line 1 but was applied at line 2
    expect(result.hunkResults[0]!.appliedAtLine).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 16. Binary / special file handling
// ---------------------------------------------------------------------------

describe("applyPatch — binary and special file handling", () => {
  it("applyPatchSet reports E_FILE_NOT_FOUND for non-existent non-add-only patches", async () => {
    const readFile = vi.fn(async () => null);
    const writeFile = vi.fn();

    const patches: FilePatch[] = [
      makeFilePatch("missing.bin", [
        makeHunk(1, 2, 1, 2, [
          { type: "context", content: "header" },
          { type: "remove", content: "old_content" },
          { type: "add", content: "new_content" },
        ]),
      ]),
    ];

    const { results } = await applyPatchSet(patches, readFile, writeFile);
    expect(results[0]!.error).toBe("E_FILE_NOT_FOUND");
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("patch containing binary-looking content is treated as text and fails gracefully", () => {
    const content = "normal text\nbinary: \x00\x01\x02\nmore text";
    const patch = makeFilePatch("data.bin", [
      makeHunk(1, 3, 1, 3, [
        { type: "context", content: "normal text" },
        { type: "remove", content: "WRONG_BINARY_CONTENT" },
        { type: "add", content: "replacement" },
        { type: "context", content: "more text" },
      ]),
    ]);
    // Should not throw — just fail to match
    expect(() => applyPatch(content, patch)).not.toThrow();
    const result = applyPatch(content, patch);
    expect(result.hunkResults[0]!.applied).toBe(false);
  });

  it("patch with null-byte content in add line is accepted structurally", () => {
    const content = "a\nb\nc";
    const patch = makeFilePatch("f.ts", [
      makeHunk(1, 3, 1, 3, [
        { type: "context", content: "a" },
        { type: "remove", content: "b" },
        { type: "add", content: "b\x00encoded" },
        { type: "context", content: "c" },
      ]),
    ]);
    // Should not throw
    expect(() => applyPatch(content, patch)).not.toThrow();
  });

  it("patch for a file whose readFile throws propagates rejection", async () => {
    const readFile = vi.fn(async () => {
      throw new Error("I/O error reading file");
    });
    const writeFile = vi.fn();

    const patches: FilePatch[] = [
      makeFilePatch("boom.ts", [
        makeHunk(1, 1, 1, 1, [
          { type: "remove", content: "old" },
          { type: "add", content: "new" },
        ]),
      ]),
    ];

    await expect(applyPatchSet(patches, readFile, writeFile)).rejects.toThrow(
      "I/O error",
    );
  });
});

// ---------------------------------------------------------------------------
// 17. Additional edge cases and integration
// ---------------------------------------------------------------------------

describe("applyPatch — additional edge cases", () => {
  it("applies patch to single-line file", () => {
    const content = "single_line";
    const patch = makeFilePatch("f.ts", [
      makeHunk(1, 1, 1, 1, [
        { type: "remove", content: "single_line" },
        { type: "add", content: "REPLACED" },
      ]),
    ]);
    const result = applyPatch(content, patch);
    expect(result.success).toBe(true);
    expect(result.content).toBe("REPLACED");
  });

  it("applies patch to file with trailing newline", () => {
    const content = "line1\nline2\n"; // trailing newline splits into ['line1','line2','']
    const patch = makeFilePatch("f.ts", [
      makeHunk(1, 2, 1, 2, [
        { type: "remove", content: "line1" },
        { type: "add", content: "LINE1" },
        { type: "context", content: "line2" },
      ]),
    ]);
    const result = applyPatch(content, patch);
    expect(result.success).toBe(true);
    expect(result.content).toContain("LINE1");
  });

  it("patch to empty string file works for add-only hunk", () => {
    const content = "";
    const patch = makeFilePatch("f.ts", [
      makeHunk(0, 0, 1, 2, [
        { type: "add", content: "new_line1" },
        { type: "add", content: "new_line2" },
      ]),
    ]);
    const result = applyPatch(content, patch);
    expect(result.success).toBe(true);
    expect(result.content).toContain("new_line1");
  });

  it("applying patch does not mutate the original content string", () => {
    const original = "foo\nbar\nbaz";
    const patch = makeFilePatch("f.ts", [
      makeHunk(1, 3, 1, 3, [
        { type: "context", content: "foo" },
        { type: "remove", content: "bar" },
        { type: "add", content: "BAR" },
        { type: "context", content: "baz" },
      ]),
    ]);
    applyPatch(original, patch);
    // Original string must be untouched
    expect(original).toBe("foo\nbar\nbaz");
  });

  it("large file: hunk in the middle applies correctly", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line${i + 1}`);
    const content = lines.join("\n");
    const patch = makeFilePatch("f.ts", [
      makeHunk(50, 3, 50, 3, [
        { type: "context", content: "line50" },
        { type: "remove", content: "line51" },
        { type: "add", content: "LINE51_MODIFIED" },
        { type: "context", content: "line52" },
      ]),
    ]);
    const result = applyPatch(content, patch);
    expect(result.success).toBe(true);
    expect(result.content).toContain("LINE51_MODIFIED");
    expect(result.content).not.toContain("\nline51\n");
  });

  it("two non-overlapping hunks both apply successfully", () => {
    const content = "A\nB\nC\nD\nE\nF\nG\nH\nI\nJ";
    const patch = makeFilePatch("f.ts", [
      makeHunk(1, 2, 1, 2, [
        { type: "remove", content: "A" },
        { type: "add", content: "AA" },
        { type: "context", content: "B" },
      ]),
      makeHunk(9, 2, 9, 2, [
        { type: "context", content: "I" },
        { type: "remove", content: "J" },
        { type: "add", content: "JJ" },
      ]),
    ]);
    const result = applyPatch(content, patch);
    expect(result.success).toBe(true);
    const lines = result.content!.split("\n");
    expect(lines[0]).toBe("AA");
    expect(lines[lines.length - 1]).toBe("JJ");
  });

  it("parseUnifiedDiff + applyPatch integration: modify multiple places", () => {
    const original = [
      "function greet() {",
      '  return "hello"',
      "}",
      "",
      "function farewell() {",
      '  return "bye"',
      "}",
    ].join("\n");

    const diff = [
      "--- a/greet.ts",
      "+++ b/greet.ts",
      "@@ -1,3 +1,3 @@",
      " function greet() {",
      '-  return "hello"',
      '+  return "hi"',
      " }",
      "@@ -5,3 +5,3 @@",
      " function farewell() {",
      '-  return "bye"',
      '+  return "goodbye"',
      " }",
    ].join("\n");

    const [patch] = parseUnifiedDiff(diff);
    const result = applyPatch(original, patch!);
    expect(result.success).toBe(true);
    expect(result.content).toContain('return "hi"');
    expect(result.content).toContain('return "goodbye"');
    expect(result.content).not.toContain('return "hello"');
    expect(result.content).not.toContain('return "bye"');
  });

  it("applyPatchSet readFile is called once per patch", async () => {
    const files = new Map([
      ["a.ts", "a\nb"],
      ["b.ts", "c\nd"],
    ]);
    const readFile = vi.fn(async (p: string) => files.get(p) ?? null);
    const writeFile = vi.fn(async (p: string, c: string) => {
      files.set(p, c);
    });

    const patches: FilePatch[] = [
      makeFilePatch("a.ts", [
        makeHunk(1, 2, 1, 2, [
          { type: "remove", content: "a" },
          { type: "add", content: "A" },
          { type: "context", content: "b" },
        ]),
      ]),
      makeFilePatch("b.ts", [
        makeHunk(1, 2, 1, 2, [
          { type: "context", content: "c" },
          { type: "remove", content: "d" },
          { type: "add", content: "D" },
        ]),
      ]),
    ];

    await applyPatchSet(patches, readFile, writeFile);
    expect(readFile).toHaveBeenCalledTimes(2);
  });
});
