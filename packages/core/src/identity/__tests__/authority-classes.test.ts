import { describe, expect, it } from "vitest";

import {
  AUTHORITY_BEARING_CLASSES,
  AUTHORITY_CLASSES,
  AUTHORITY_CLASS_NAMES,
  EFFECT_ELIGIBILITY,
  checkEffectAuthorized,
  isAuthorityBearing,
  isAuthorityClass,
  isGovernedEffect,
  type AuthorityClass,
} from "../authority-classes.js";

describe("authority-classes (ADR-0001 L2)", () => {
  describe("vocabulary", () => {
    it("declares exactly the four G01 classes", () => {
      expect([...AUTHORITY_CLASS_NAMES]).toEqual([
        "autonomous-ai",
        "externally-delegated-ai",
        "human-approved",
        "development-unverified",
      ]);
    });

    it("marks only human-approved as requiring a human", () => {
      const humanRequired = AUTHORITY_CLASS_NAMES.filter(
        (name) => AUTHORITY_CLASSES[name].humanRequired
      );
      expect(humanRequired).toEqual(["human-approved"]);
    });

    it("excludes development-unverified from the authority-bearing set", () => {
      // It never makes a production authority claim, so it may observe but not bear.
      expect(AUTHORITY_BEARING_CLASSES).not.toContain("development-unverified");
      expect([...AUTHORITY_BEARING_CLASSES]).toEqual([
        "autonomous-ai",
        "externally-delegated-ai",
        "human-approved",
      ]);
    });

    it("freezes the vocabulary against mutation", () => {
      expect(Object.isFrozen(AUTHORITY_CLASSES)).toBe(true);
      expect(Object.isFrozen(AUTHORITY_BEARING_CLASSES)).toBe(true);
      expect(Object.isFrozen(EFFECT_ELIGIBILITY)).toBe(true);
    });
  });

  describe("type guards", () => {
    it("narrows a known class name and rejects an unknown one", () => {
      expect(isAuthorityClass("human-approved")).toBe(true);
      expect(isAuthorityClass("root")).toBe(false);
      expect(isAuthorityClass("")).toBe(false);
    });

    it("does not treat inherited Object properties as classes", () => {
      // A plain `name in AUTHORITY_CLASSES` check would wrongly accept these.
      expect(isAuthorityClass("toString")).toBe(false);
      expect(isAuthorityClass("constructor")).toBe(false);
    });

    it("recognises governed effects only", () => {
      expect(isGovernedEffect("deterministic_floor_report_only")).toBe(true);
      expect(isGovernedEffect("arbitrary_effect")).toBe(false);
      expect(isGovernedEffect("constructor")).toBe(false);
    });

    it("reports authority-bearing membership", () => {
      expect(isAuthorityBearing("autonomous-ai")).toBe(true);
      expect(isAuthorityBearing("development-unverified")).toBe(false);
    });
  });

  describe("checkEffectAuthorized", () => {
    it("authorizes an authority-bearing class for a gated effect", () => {
      expect(
        checkEffectAuthorized({
          authorityClass: "human-approved",
          effect: "authority_promotion_gate_envelope_only",
        })
      ).toEqual({
        ok: true,
        authorityClass: "human-approved",
        effect: "authority_promotion_gate_envelope_only",
      });
    });

    it("authorizes development-unverified for report-only effects", () => {
      expect(
        checkEffectAuthorized({
          authorityClass: "development-unverified",
          effect: "deterministic_floor_report_only",
        })
      ).toMatchObject({ ok: true });
    });

    it("refuses development-unverified for an authority-bearing effect", () => {
      const result = checkEffectAuthorized({
        authorityClass: "development-unverified",
        effect: "g01_certified_principals_registry_only",
      });

      expect(result).toMatchObject({ ok: false, reason: "class-not-eligible" });
    });

    it("fails closed on an unknown authority class", () => {
      expect(
        checkEffectAuthorized({
          authorityClass: "root",
          effect: "deterministic_floor_report_only",
        })
      ).toMatchObject({ ok: false, reason: "unknown-authority-class" });
    });

    it("fails closed on an effect outside the mapped vocabulary", () => {
      expect(
        checkEffectAuthorized({
          authorityClass: "human-approved",
          effect: "rm_minus_rf",
        })
      ).toMatchObject({ ok: false, reason: "unmapped-effect" });
    });

    it("fails closed on empty input rather than defaulting to permitted", () => {
      expect(
        checkEffectAuthorized({ authorityClass: "", effect: "" })
      ).toMatchObject({
        ok: false,
      });
    });

    it("is a pure predicate — it never throws", () => {
      // Enforcement (which throws, and holds the Ed25519 machinery) stays in
      // scripts. The framework only answers the eligibility question.
      expect(() =>
        checkEffectAuthorized({ authorityClass: "nope", effect: "nope" })
      ).not.toThrow();
    });
  });

  describe("cross-stack parity with the G01 source of truth", () => {
    it("agrees with scripts/g01-authority-classes.js on every class-effect pair", async () => {
      // The lab module is the source of truth; this contract is a lift of it.
      // Any divergence means the two stacks would disagree about authority.
      const g01 = await import(
        /* @vite-ignore */
        "../../../../../../scripts/flow-prompt-lab/lib/g01-authority-classes.js"
      ).then(
        (m) =>
          (m.default ?? m) as {
            G01_AUTHORITY_CLASSES: Record<string, unknown>;
            G01_EFFECT_ELIGIBILITY: Record<string, readonly string[]>;
            assertEffectAuthorized: (input: {
              authorityClass: string;
              effect: string;
            }) => unknown;
          }
      );

      expect(Object.keys(g01.G01_AUTHORITY_CLASSES).sort()).toEqual(
        [...AUTHORITY_CLASS_NAMES].sort()
      );
      expect(Object.keys(g01.G01_EFFECT_ELIGIBILITY).sort()).toEqual(
        Object.keys(EFFECT_ELIGIBILITY).sort()
      );

      for (const effect of Object.keys(g01.G01_EFFECT_ELIGIBILITY)) {
        for (const authorityClass of AUTHORITY_CLASS_NAMES) {
          let labAllows = true;
          try {
            g01.assertEffectAuthorized({ authorityClass, effect });
          } catch {
            labAllows = false;
          }
          const ours = checkEffectAuthorized({ authorityClass, effect }).ok;
          expect(ours, `divergence for ${authorityClass} x ${effect}`).toBe(
            labAllows
          );
        }
      }
    });
  });
});

// Compile-time check: AuthorityClass is the exact union, not a widened string.
const _typed: AuthorityClass = "autonomous-ai";
void _typed;
