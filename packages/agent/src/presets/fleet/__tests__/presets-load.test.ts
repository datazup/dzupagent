import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import { FLEET_PRESETS } from "../index.js";

describe("fleet presets", () => {
  it("all four presets resolve to existing YAML files", async () => {
    expect(Object.keys(FLEET_PRESETS).sort()).toEqual([
      "audit-fanout",
      "continuous-fleet",
      "coordinated-feature",
      "independent-tasks",
    ]);
    for (const p of Object.values(FLEET_PRESETS)) {
      const buf = await fs.readFile(p, "utf8");
      expect(buf).toContain("dzupflow/v1");
    }
  });
});
