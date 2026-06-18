import { describe, expect, it } from "vitest";
import { canonicalInputDigest, materializeIdempotencyKey } from "../index.js";

describe("runtime-contracts idempotency (OQ-2)", () => {
  it("produces the same digest regardless of object key insertion order", () => {
    const a = canonicalInputDigest({
      alpha: 1,
      beta: 2,
      gamma: { x: 1, y: 2 },
    });
    const b = canonicalInputDigest({
      gamma: { y: 2, x: 1 },
      beta: 2,
      alpha: 1,
    });
    expect(a).toBe(b);
  });

  it("produces different digests for different values", () => {
    const a = canonicalInputDigest({ value: 1 });
    const b = canonicalInputDigest({ value: 2 });
    const c = canonicalInputDigest("1");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });

  it("handles nested objects, arrays, nulls, and booleans deterministically", () => {
    const input = {
      nested: { b: [3, 2, 1], a: null },
      flag: true,
      list: [{ z: 1, a: 2 }, null, false],
    };
    const first = canonicalInputDigest(input);
    const second = canonicalInputDigest(structuredClone(input));
    // 64 hex chars = SHA-256
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).toBe(second);
    // Array order is significant: reordering elements changes the digest.
    const reordered = canonicalInputDigest({
      ...input,
      nested: { a: null, b: [1, 2, 3] },
    });
    expect(reordered).not.toBe(first);
  });

  it("materializes the canonical dzup:v1 key format", () => {
    const key = materializeIdempotencyKey({
      sourceHash: "src123",
      runId: "run-9",
      nodeId: "node-A",
      attemptPolicy: "exactly-once-required",
      input: { foo: "bar" },
    });
    const digest = canonicalInputDigest({ foo: "bar" });
    expect(key).toBe(
      `dzup:v1:src123:run-9:node-A:exactly-once-required:${digest}`
    );
    expect(key.startsWith("dzup:v1:")).toBe(true);
  });

  it("materializes identical keys for identical params (stability)", () => {
    const params = {
      sourceHash: "srcHash",
      runId: "run-1",
      nodeId: "node-1",
      attemptPolicy: "idempotent",
      input: { b: 2, a: 1 },
    };
    const k1 = materializeIdempotencyKey(params);
    const k2 = materializeIdempotencyKey({
      ...params,
      input: { a: 1, b: 2 },
    });
    expect(k1).toBe(k2);
  });
});
