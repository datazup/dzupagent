import { describe, it, expect } from "vitest";
import { evictWithOffload, type OffloadSink } from "../context-eviction.js";

function memorySink(): OffloadSink & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async write(path, content) {
      files.set(path, content);
    },
    async append(path, content) {
      files.set(path, (files.get(path) ?? "") + content);
    },
  };
}

const big = Array.from(
  { length: 5000 },
  (_, i) => `line ${i} ${"x".repeat(40)}`,
).join("\n");

describe("evictWithOffload", () => {
  it("writes full content to the sink and points the preview at the offload path", async () => {
    const sink = memorySink();
    const result = await evictWithOffload(big, "tool:run-tests", sink);
    expect(result.evicted).toBe(true);
    expect(result.offloadPath).toBeDefined();
    expect(result.offloadPath).toMatch(/^\.dzup\/evicted\//);
    expect(sink.files.get(result.offloadPath!)).toBe(big);
    expect(result.content).toContain(result.offloadPath!);
    expect(result.content).toContain("read_file");
  });

  it("sanitizes the identifier into the offload filename", async () => {
    const sink = memorySink();
    const result = await evictWithOffload(big, "tool:bash/rm -rf?", sink);
    expect(result.offloadPath).toMatch(/^\.dzup\/evicted\/[a-z0-9._-]+\.txt$/);
  });

  it("returns content unchanged below threshold without touching the sink", async () => {
    const sink = memorySink();
    const result = await evictWithOffload("short", "x", sink);
    expect(result.evicted).toBe(false);
    expect(result.content).toBe("short");
    expect(sink.files.size).toBe(0);
  });

  it("falls back to legacy preview when the sink throws", async () => {
    const sink: OffloadSink = {
      write: async () => {
        throw new Error("disk full");
      },
      append: async () => {
        throw new Error("disk full");
      },
    };
    const result = await evictWithOffload(big, "tool:x", sink);
    expect(result.evicted).toBe(true);
    expect(result.offloadPath).toBeUndefined();
    expect(result.content).toContain("Content truncated");
  });
});
