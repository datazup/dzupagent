/**
 * Pins WHERE the canonical model-pricing surface is published, not merely THAT
 * it exists.
 *
 * The C3 pricing work (a3a3d2d6, 4824fad3) exported the rate/tariff cluster from
 * BOTH `src/index.ts` and `src/middleware.ts`. The root copy pushed
 * @dzupagent/core past three growth-frozen barrel budgets at once (946/935
 * exports, 145/143 sources, 1342/1327 lines) while `./middleware` already
 * published all ten symbols, and the sole external consumer
 * (@dzupagent/agent-adapters/src/middleware/cost-tracking.ts) imports from the
 * subpath. config/public-api-allowlists.json classifies `./middleware/` as a
 * *transitional* root rule whose migration window states such exports "must move
 * to subpaths", so the root copy also contradicted the package's own governance.
 *
 * Eight of the ten were pure duplicates. `getModelRate` and the `ModelRate` type
 * were reachable ONLY from the root block, so removing it does narrow the root
 * surface — verified safe by grep: zero importers of any of the ten from
 * `"@dzupagent/core"` anywhere in dzupagent/packages or apps/codev-app.
 *
 * Deleting an unadopted duplicate is invisible to a green suite, and a
 * previous relocation in @dzupagent/express was reverted under a
 * "published-consumer compatibility" rationale that did not hold. So this test
 * asserts the direction that regresses: the root barrel must stay clear.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

/** Every symbol the two pricing modules publish, as of the C3 slices. */
const PRICING_VALUES = [
  "MODEL_RATES_AUTHORITY_ID",
  "MODEL_RATES_EFFECTIVE_AT",
  "MODEL_RATES_REVISION",
  "hasKnownModelRate",
  "getModelRate",
  "buildKnownModelTariff",
  "buildModelTariff",
  "centsPer1MToMicrosPerToken",
  "modelRatesProvenance",
  "toAiTokenRates",
] as const;

describe("model-pricing subpath placement", () => {
  it("publishes the whole pricing cluster on the ./middleware subpath", async () => {
    const entry = (await import("../middleware.js")) as Record<string, unknown>;

    for (const name of PRICING_VALUES) {
      expect(entry[name], `${name} missing from ./middleware`).toBeDefined();
    }
    // Spot-check identity, not just presence: a subpath that re-exported a
    // different `getModelRate` would satisfy a presence-only assertion.
    expect(entry.MODEL_RATES_AUTHORITY_ID).toBe("dzupagent.core/model-rates");
    expect(typeof entry.getModelRate).toBe("function");
    expect(typeof entry.buildKnownModelTariff).toBe("function");
  });

  it("maps ./middleware in package.json so the subpath is importable", () => {
    const pkg = JSON.parse(read("../../package.json")) as {
      exports: Record<string, unknown>;
    };

    expect(pkg.exports["./middleware"]).toBeDefined();
  });

  it("keeps the root barrel free of model-rates / model-tariff re-exports", () => {
    // Asserted against source, not the module namespace: a root re-export is
    // exactly what regresses the barrel budget, and importing the barrel would
    // not reveal WHERE a symbol was re-exported from.
    const root = read("../index.ts");

    expect(root).not.toMatch(/from "\.\/middleware\/model-rates\.js"/);
    expect(root).not.toMatch(/from "\.\/middleware\/model-tariff\.js"/);
  });

  it("does not reach the pricing cluster through any other root re-export", () => {
    // The root keeps `calculateCostCents`/`getModelCosts` from cost-tracking.js,
    // which itself re-exports getModelRate/ModelRate from model-rates.js. That
    // makes the *module* graph adjacent to the pricing surface, so the barrel
    // could silently regain it. Assert on the resolved root namespace, which is
    // what a consumer actually sees.
    return import("../index.js").then((root: Record<string, unknown>) => {
      for (const name of PRICING_VALUES) {
        expect(root[name], `${name} leaked back onto the root barrel`).toBeUndefined();
      }
    });
  });
});
