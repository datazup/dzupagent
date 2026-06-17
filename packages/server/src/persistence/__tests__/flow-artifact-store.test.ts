import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryFlowArtifactStore } from "../flow-artifact-store.js";
import type { FlowArtifact } from "../flow-artifact-store.js";

describe("InMemoryFlowArtifactStore", () => {
  let store: InMemoryFlowArtifactStore;

  beforeEach(() => {
    store = new InMemoryFlowArtifactStore();
  });

  it("put stores and returns artifact with createdAt", async () => {
    const before = new Date();
    const result = await store.put({
      artifactRef: "ref-1",
      contentDigest: "sha256:abc",
      contentType: "application/json",
      storageUri: null,
      schemaRef: null,
    });
    const after = new Date();

    expect(result.artifactRef).toBe("ref-1");
    expect(result.contentDigest).toBe("sha256:abc");
    expect(result.contentType).toBe("application/json");
    expect(result.createdAt).toBeInstanceOf(Date);
    expect(result.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(result.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("get retrieves artifact by artifactRef", async () => {
    await store.put({
      artifactRef: "ref-2",
      contentDigest: "sha256:def",
      contentType: "text/plain",
    });
    const result = await store.get("ref-2");
    expect(result).toBeDefined();
    expect(result?.artifactRef).toBe("ref-2");
  });

  it("get returns undefined for missing ref", async () => {
    const result = await store.get("nonexistent");
    expect(result).toBeUndefined();
  });

  it("findByDigest returns matching artifact", async () => {
    await store.put({
      artifactRef: "ref-3",
      contentDigest: "sha256:ghi",
      contentType: "application/octet-stream",
    });
    const result = await store.findByDigest("sha256:ghi");
    expect(result).toBeDefined();
    expect(result?.artifactRef).toBe("ref-3");
  });

  it("findByDigest returns undefined when no match", async () => {
    await store.put({
      artifactRef: "ref-4",
      contentDigest: "sha256:jkl",
      contentType: "application/json",
    });
    const result = await store.findByDigest("sha256:nomatch");
    expect(result).toBeUndefined();
  });
});
