import { describe, expect, it } from "vitest";

import {
  PROMPT_TEMPLATE_DECLARATION_SCHEMA,
  reconcileTemplateDeclaration,
  templatePlaceholderPaths,
} from "../template-declaration.js";

const DECLARATION = {
  schema: PROMPT_TEMPLATE_DECLARATION_SCHEMA,
  id: "alternating.implementer",
  variables: {
    ROLE_LABEL: { required: true, description: "" },
    "inputs.currentTask": { required: false, description: "Task under work" },
  },
} as const;

const TEMPLATE = "You are {{ ROLE_LABEL }}. Work on {{ inputs.currentTask }}.";

describe("promptTemplateDeclaration", () => {
  describe("templatePlaceholderPaths", () => {
    it("extracts dotted and SCREAMING_CASE placeholders, deduped and sorted", () => {
      expect(templatePlaceholderPaths("{{ B }} {{ a.b_c }} {{ B }}")).toEqual([
        "B",
        "a.b_c",
      ]);
    });

    it("ignores non-placeholder text and tolerates empty input", () => {
      expect(templatePlaceholderPaths("no placeholders here")).toEqual([]);
      expect(templatePlaceholderPaths("")).toEqual([]);
    });

    it("rejects a malformed placeholder rather than silently dropping it", () => {
      // The lab's grammar note: a permissive scan then a strict shape check, so
      // `{{ a-b }}` surfaces as an error instead of vanishing from the contract.
      expect(() => templatePlaceholderPaths("{{ a-b }}")).toThrow(
        /malformed placeholder/iu,
      );
    });
  });

  describe("reconcileTemplateDeclaration", () => {
    it("accepts a declaration matching the template's placeholders", () => {
      const result = reconcileTemplateDeclaration({
        id: "alternating.implementer",
        template: TEMPLATE,
        declaration: DECLARATION,
      });

      expect(result).toMatchObject({
        ok: true,
        status: "consistent",
        referencedPaths: ["ROLE_LABEL", "inputs.currentTask"],
        requiredVariables: ["ROLE_LABEL"],
      });
      if (!result.ok) throw new Error("expected reconciliation to succeed");
      expect(result.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    });

    it("derives a fingerprint that is stable across key order", () => {
      const reordered = {
        ...DECLARATION,
        variables: {
          "inputs.currentTask": DECLARATION.variables["inputs.currentTask"],
          ROLE_LABEL: DECLARATION.variables.ROLE_LABEL,
        },
      };
      const first = reconcileTemplateDeclaration({
        id: DECLARATION.id,
        template: TEMPLATE,
        declaration: DECLARATION,
      });
      const second = reconcileTemplateDeclaration({
        id: DECLARATION.id,
        template: TEMPLATE,
        declaration: reordered,
      });

      if (!first.ok || !second.ok) throw new Error("reconciliation failed");
      expect(first.fingerprint).toBe(second.fingerprint);
    });

    it("changes the fingerprint when a variable's requiredness changes", () => {
      const relaxed = {
        ...DECLARATION,
        variables: {
          ...DECLARATION.variables,
          ROLE_LABEL: { required: false, description: "" },
        },
      };
      const strict = reconcileTemplateDeclaration({
        id: DECLARATION.id,
        template: TEMPLATE,
        declaration: DECLARATION,
      });
      const loose = reconcileTemplateDeclaration({
        id: DECLARATION.id,
        template: TEMPLATE,
        declaration: relaxed,
      });

      if (!strict.ok || !loose.ok) throw new Error("reconciliation failed");
      expect(strict.fingerprint).not.toBe(loose.fingerprint);
    });

    it("rejects an undeclared placeholder (typo)", () => {
      const result = reconcileTemplateDeclaration({
        id: DECLARATION.id,
        template: `${TEMPLATE} {{ ROLE_LABLE }}`,
        declaration: DECLARATION,
      });

      expect(result).toMatchObject({ ok: false });
      if (result.ok) throw new Error("expected undeclared variable rejection");
      expect(result.undeclared).toEqual(["ROLE_LABLE"]);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ code: "TEMPLATE_UNDECLARED_VARIABLE" }),
      );
    });

    it("rejects a declared-but-unreferenced variable (stale contract)", () => {
      const result = reconcileTemplateDeclaration({
        id: DECLARATION.id,
        template: "You are {{ ROLE_LABEL }}.",
        declaration: DECLARATION,
      });

      expect(result).toMatchObject({ ok: false });
      if (result.ok) throw new Error("expected stale variable rejection");
      expect(result.unused).toEqual(["inputs.currentTask"]);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ code: "TEMPLATE_STALE_VARIABLE" }),
      );
    });

    it("rejects a declaration carrying an unsupported schema id", () => {
      const result = reconcileTemplateDeclaration({
        id: DECLARATION.id,
        template: TEMPLATE,
        declaration: { ...DECLARATION, schema: "something/else" },
      });

      expect(result).toMatchObject({ ok: false });
      if (result.ok) throw new Error("expected schema rejection");
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ code: "TEMPLATE_DECLARATION_INVALID" }),
      );
    });

    it("rejects a malformed variable entry", () => {
      const result = reconcileTemplateDeclaration({
        id: DECLARATION.id,
        template: TEMPLATE,
        declaration: {
          ...DECLARATION,
          variables: { ROLE_LABEL: { required: "yes" } },
        },
      });

      expect(result).toMatchObject({ ok: false });
      if (result.ok) throw new Error("expected malformed variable rejection");
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ code: "TEMPLATE_DECLARATION_INVALID" }),
      );
    });

    it("reports every defect at once rather than stopping at the first", () => {
      const result = reconcileTemplateDeclaration({
        id: DECLARATION.id,
        template: "You are {{ TYPO_ONE }} and {{ TYPO_TWO }}.",
        declaration: DECLARATION,
      });

      if (result.ok) throw new Error("expected rejection");
      expect(result.undeclared).toEqual(["TYPO_ONE", "TYPO_TWO"]);
      expect(result.unused).toEqual(["ROLE_LABEL", "inputs.currentTask"]);
    });
  });
});
