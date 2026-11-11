import { describe, expect, it } from "vitest";

import {
  PROVIDER_QUOTA_SCHEMA,
  PROVIDER_QUOTA_WINDOW_MINUTES,
  assessProviderQuotaObservation,
  assessProviderQuotaReading,
  validateProviderQuotaObservation,
  validateProviderQuotaReading,
  type ProviderQuotaObservation,
  type ProviderQuotaReading,
} from "../index.js";

const FIVE = PROVIDER_QUOTA_WINDOW_MINUTES.fiveHours;
const SEVEN = PROVIDER_QUOTA_WINDOW_MINUTES.sevenDays;
const NOW = "2026-11-11T10:00:00.000Z";

const observation: ProviderQuotaObservation = {
  schema: PROVIDER_QUOTA_SCHEMA,
  provider: "codex",
  poolRef: "pool-a",
  bucketRef: "codex",
  modelScope: null,
  source: "account/rateLimits/read",
  method: "request-response",
  observedAt: "2026-11-11T09:59:00.000Z",
  expiresAt: "2026-11-11T10:04:00.000Z",
  windows: [
    { windowRef: "primary", durationMinutes: FIVE, usedPercent: 0, resetsAt: "2026-11-11T12:00:00.000Z" },
    { windowRef: "secondary", durationMinutes: SEVEN, usedPercent: 40, resetsAt: "2026-11-15T00:00:00.000Z" },
  ],
};

const reading: ProviderQuotaReading = {
  schema: PROVIDER_QUOTA_SCHEMA,
  provider: "codex",
  poolRef: "pool-a",
  completedAt: "2026-11-11T09:59:01.000Z",
  status: "current",
  observations: [observation],
};

const both = { now: NOW, requiredWindowMinutes: [FIVE, SEVEN] };

describe("provider quota contract: validation", () => {
  it("accepts a complete observation and reading", () => {
    expect(validateProviderQuotaObservation(observation)).toEqual([]);
    expect(validateProviderQuotaReading(reading)).toEqual([]);
  });

  it("accepts independently missing duration, percentage and reset", () => {
    const partial = {
      ...observation,
      windows: [
        { windowRef: "primary", durationMinutes: null, usedPercent: 10, resetsAt: null },
        { windowRef: "secondary", durationMinutes: SEVEN, usedPercent: null, resetsAt: null },
      ],
    };
    expect(validateProviderQuotaObservation(partial)).toEqual([]);
  });

  it.each([
    ["schema", { schema: "other/v1" }],
    ["provider", { provider: "" }],
    ["poolRef free text", { poolRef: "user@example.com has spaces" }],
    ["method", { method: "scrape" }],
    ["observedAt", { observedAt: "yesterday" }],
    ["non-canonical instant", { observedAt: "2026-11-11T09:59:00Z" }],
    ["expiry order", { expiresAt: observation.observedAt }],
    ["negative used", { windows: [{ windowRef: "primary", durationMinutes: FIVE, usedPercent: -1, resetsAt: null }] }],
    ["NaN used", { windows: [{ windowRef: "primary", durationMinutes: FIVE, usedPercent: Number.NaN, resetsAt: null }] }],
    ["fractional duration", { windows: [{ windowRef: "primary", durationMinutes: 1.5, usedPercent: 1, resetsAt: null }] }],
    ["duplicate duration", { windows: [observation.windows[0], { ...observation.windows[0], windowRef: "other" }] }],
  ])("rejects %s", (_name, change) => {
    expect(validateProviderQuotaObservation({ ...observation, ...change })).not.toEqual([]);
  });

  it("rejects inconsistent readings", () => {
    expect(validateProviderQuotaReading({ ...reading, observations: [] })).not.toEqual([]);
    expect(validateProviderQuotaReading({ ...reading, status: "failed", reason: "timeout" })).not.toEqual([]);
    expect(validateProviderQuotaReading({ ...reading, status: "failed", reason: "raw provider text", observations: [] })).not.toEqual([]);
    expect(validateProviderQuotaReading({ ...reading, poolRef: "pool-b" })).not.toEqual([]);
    expect(validateProviderQuotaReading({ ...reading, status: "unavailable", reason: "no-observation", observations: [] })).toEqual([]);
  });
});

describe("provider quota contract: assessment", () => {
  it("reports both windows by duration, with zero usage staying zero", () => {
    const [five, seven] = assessProviderQuotaReading(reading, both);
    expect(five).toMatchObject({ durationMinutes: FIVE, state: "available", usedPercent: 0, reason: null, observedAt: observation.observedAt });
    expect(seven).toMatchObject({ durationMinutes: SEVEN, state: "available", usedPercent: 40, bucketRef: "codex" });
  });

  it("identifies windows by duration, not position", () => {
    const swapped = { ...observation, windows: [observation.windows[1]!, observation.windows[0]!] };
    const [five] = assessProviderQuotaObservation(swapped, { now: NOW, requiredWindowMinutes: [FIVE] });
    expect(five).toMatchObject({ state: "available", usedPercent: 0 });
  });

  it("never reports exhausted capacity as available", () => {
    const exhausted = { ...observation, windows: [{ ...observation.windows[0]!, usedPercent: 100 }, observation.windows[1]!] };
    expect(assessProviderQuotaObservation(exhausted, both)[0]).toMatchObject({ state: "exhausted", usedPercent: 100, reason: null });
  });

  it.each([
    ["stale", { ...observation, expiresAt: NOW }, "stale"],
    ["future", { ...observation, observedAt: "2026-11-11T10:05:00.000Z", expiresAt: "2026-11-11T10:10:00.000Z" }, "future-observation"],
    ["malformed", { ...observation, windows: [{ windowRef: "primary", durationMinutes: FIVE, usedPercent: "5", resetsAt: null }] }, "malformed"],
  ])("treats a %s observation as unknown", (_name, value, reason) => {
    const results = assessProviderQuotaObservation(value as ProviderQuotaObservation, both);
    expect(results.map((result) => [result.state, result.reason])).toEqual([["unknown", reason], ["unknown", reason]]);
  });

  it("allows bounded clock skew but no more", () => {
    const ahead = { ...observation, observedAt: "2026-11-11T10:01:00.000Z", expiresAt: "2026-11-11T10:06:00.000Z" };
    expect(assessProviderQuotaObservation(ahead, both)[0]!.state).toBe("available");
    expect(assessProviderQuotaObservation(ahead, { ...both, maxClockSkewMs: 0 })[0]!.reason).toBe("future-observation");
  });

  it("needs re-observation once a reset time has passed", () => {
    const passed = { ...observation, windows: [{ ...observation.windows[0]!, usedPercent: 100, resetsAt: "2026-11-11T09:59:30.000Z" }] };
    expect(assessProviderQuotaObservation(passed, { now: NOW, requiredWindowMinutes: [FIVE] })[0]).toMatchObject({ state: "unknown", reason: "reset-passed" });
  });

  it("does not let one known window establish an unknown required window", () => {
    const fiveOnly = { ...observation, windows: [observation.windows[0]!] };
    const [five, seven] = assessProviderQuotaObservation(fiveOnly, both);
    expect(five!.state).toBe("available");
    expect(seven).toMatchObject({ state: "unknown", reason: "window-missing" });
    const noDuration = { ...observation, windows: [{ ...observation.windows[1]!, durationMinutes: null }] };
    expect(assessProviderQuotaObservation(noDuration, { now: NOW, requiredWindowMinutes: [SEVEN] })[0]!.reason).toBe("window-missing");
    const noPercent = { ...observation, windows: [{ ...observation.windows[1]!, usedPercent: null }] };
    expect(assessProviderQuotaObservation(noPercent, { now: NOW, requiredWindowMinutes: [SEVEN] })[0]!.reason).toBe("used-percent-missing");
  });

  it("carries the reason of an unavailable or failed reading", () => {
    const failed: ProviderQuotaReading = { schema: PROVIDER_QUOTA_SCHEMA, provider: "codex", poolRef: null, completedAt: NOW, status: "failed", reason: "timeout", observations: [] };
    expect(assessProviderQuotaReading(failed, both)).toEqual([
      expect.objectContaining({ durationMinutes: FIVE, state: "unknown", reason: "timeout" }),
      expect.objectContaining({ durationMinutes: SEVEN, state: "unknown", reason: "timeout" }),
    ]);
    expect(assessProviderQuotaReading({ ...failed, reason: "nonsense" } as unknown as ProviderQuotaReading, both)[0]!.reason).toBe("malformed");
  });

  it("does not trust a reading labelled stale", () => {
    const stale: ProviderQuotaReading = { ...reading, status: "stale", reason: "stale", observations: [{ ...observation, expiresAt: "2026-11-11T09:59:30.000Z" }] };
    expect(assessProviderQuotaReading(stale, both).map((result) => [result.state, result.reason])).toEqual([["unknown", "stale"], ["unknown", "stale"]]);
  });
});
