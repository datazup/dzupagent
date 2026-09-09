import { describe, expect, it } from "vitest";

import {
  DEFAULT_LIFECYCLE_POLICY,
  type LifecyclePolicy,
} from "../runtime/runtime-config.js";

describe("DEFAULT_LIFECYCLE_POLICY", () => {
  it("is frozen against mutation through a mutable alias", () => {
    const mutableAlias = DEFAULT_LIFECYCLE_POLICY as LifecyclePolicy;

    expect(Object.isFrozen(DEFAULT_LIFECYCLE_POLICY)).toBe(true);
    expect(() => {
      mutableAlias.maxConcurrentBackground = 99;
    }).toThrow(TypeError);
    expect(DEFAULT_LIFECYCLE_POLICY.maxConcurrentBackground).toBe(4);
  });

  it("preserves all lifecycle defaults", () => {
    expect(DEFAULT_LIFECYCLE_POLICY).toEqual({
      maxConcurrentBackground: 4,
      maxQueuedTasks: 100,
      defaultTtlMs: 15 * 60 * 1000,
      retentionMs: 60 * 60 * 1000,
      gcIntervalMs: 60 * 1000,
      maxSpawnDepth: 2,
    });
  });

  it("keeps caller-owned LifecyclePolicy copies mutable", () => {
    const callerPolicy: LifecyclePolicy = { ...DEFAULT_LIFECYCLE_POLICY };

    callerPolicy.maxConcurrentBackground = 7;

    expect(callerPolicy.maxConcurrentBackground).toBe(7);
    expect(DEFAULT_LIFECYCLE_POLICY.maxConcurrentBackground).toBe(4);
  });
});
