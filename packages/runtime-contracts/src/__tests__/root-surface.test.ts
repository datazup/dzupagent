import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as root from "../index.js";
import * as pipelineInteraction from "../pipeline-interaction.js";

/**
 * DZUPAGENT-ARCH-H-11: the root barrel of this layer-0 package used seven
 * `export *` lines, so any symbol added to those modules silently became
 * public API of every dependent package. The root is now enumerated
 * explicitly and capped in config/barrel-budgets.json.
 */
const indexSource = readFileSync(
  fileURLToPath(new URL("../index.ts", import.meta.url)),
  "utf8",
);

describe("@dzupagent/runtime-contracts root surface", () => {
  it("has no export-star statements", () => {
    expect(indexSource).not.toMatch(/^\s*export\s+(?:type\s+)?\*/m);
  });

  it("still re-exports every runtime value of the formerly star-exported modules", () => {
    for (const [name, value] of Object.entries(pipelineInteraction)) {
      expect(root, name).toHaveProperty(name);
      expect((root as Record<string, unknown>)[name], name).toBe(value);
    }
  });

  it("names each formerly star-exported module in an explicit re-export", () => {
    for (const module of [
      "planning",
      "execution",
      "ledger",
      "schedule",
      "script-runs",
      "pipeline",
      "pipeline-interaction",
    ]) {
      expect(indexSource).toMatch(
        new RegExp(`^export (?:type )?\\{[^}]+\\} from "\\./${module}\\.js";$`, "m"),
      );
    }
  });
});
