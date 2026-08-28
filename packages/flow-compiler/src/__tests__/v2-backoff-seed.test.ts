// ARCH27-T-02: simulator and host must derive retry jitter from the same
// seed material so a simulation reproduces host retry timing exactly.
import { describe, expect, it } from "vitest";

import {
  backoffSeed,
  seededBackoff,
} from "../v2-inactive-local-target/evidence.js";

const SEMANTIC_HASH = `sha256:${"a".repeat(64)}`;
const AUTHORED_PATH = "root.steps[0]";
const BACKOFF = {
  strategy: "exponential",
  initialMs: 100,
  maxMs: 1000,
  jitter: "full",
} as const;

describe("seeded backoff (ARCH27-T-02)", () => {
  it("pins one seed→delay pair", () => {
    const seed = backoffSeed(SEMANTIC_HASH, AUTHORED_PATH);
    expect(seed).toBe(`${SEMANTIC_HASH}:${AUTHORED_PATH}`);
    expect(seededBackoff(seed, 2, BACKOFF)).toBe(17);
    expect(seededBackoff(seed, 3, BACKOFF)).toBe(80);
  });

  it("is deterministic for identical seed material and diverges across seeds", () => {
    const seed = backoffSeed(SEMANTIC_HASH, AUTHORED_PATH);
    expect(seededBackoff(seed, 2, BACKOFF)).toBe(
      seededBackoff(seed, 2, BACKOFF),
    );
    const otherStep = backoffSeed(SEMANTIC_HASH, "root.steps[1]");
    expect(
      [2, 3, 4].map((attempt) => seededBackoff(otherStep, attempt, BACKOFF)),
    ).not.toEqual(
      [2, 3, 4].map((attempt) => seededBackoff(seed, attempt, BACKOFF)),
    );
  });

  it("honors no-jitter, fixed strategy, and the max cap without seeding", () => {
    const seed = backoffSeed(SEMANTIC_HASH, AUTHORED_PATH);
    expect(seededBackoff(seed, 5, undefined)).toBe(0);
    expect(seededBackoff(seed, 5, { ...BACKOFF, jitter: "none" })).toBe(1000);
    expect(
      seededBackoff(seed, 5, {
        ...BACKOFF,
        jitter: "none",
        strategy: "fixed",
      }),
    ).toBe(100);
  });
});
