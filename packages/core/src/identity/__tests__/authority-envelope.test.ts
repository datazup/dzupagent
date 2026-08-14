import { describe, expect, it } from "vitest";

import {
  G01_AUTHORITY_ENVELOPE_SCHEMA,
  readAuthorityEnvelope,
  type AuthorityEnvelope,
} from "../authority-envelope.js";
import type { AuthorityClass } from "../authority-classes.js";
import { resolveWorkspaceSiblingUrl } from "./workspace-sibling.js";

const G01_AUTHORITY_ENVELOPE_URL = resolveWorkspaceSiblingUrl(
  "scripts",
  "flow-prompt-lab",
  "lib",
  "g01-authority-envelope.js",
);

/** A minimally well-formed envelope; individual tests spoil one field. */
function envelopeInput(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    schema: G01_AUTHORITY_ENVELOPE_SCHEMA,
    campaignId: "camp-1",
    gateId: "G01",
    decision: "promote",
    authorityGranted: true,
    authorityClass: "human-approved",
    target: {
      repository: "datazup/scripts",
      baseCommit: "a".repeat(40),
      baseTree: "b".repeat(40),
    },
    issuedAt: "2026-07-26T00:00:00.000Z",
    expiresAt: "2026-07-27T00:00:00.000Z",
    nonce: "nonce-1",
    signer: { signerId: "signer-1", publicKeySha256: "c".repeat(64) },
    ...overrides,
  };
}

describe("readAuthorityEnvelope", () => {
  describe("accepting a well-formed envelope", () => {
    it("narrows a valid envelope and preserves its fields", () => {
      const result = readAuthorityEnvelope(envelopeInput());

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected a valid envelope");
      expect(result.envelope.campaignId).toBe("camp-1");
      expect(result.envelope.authorityClass).toBe("human-approved");
      expect(result.envelope.target.repository).toBe("datazup/scripts");
    });

    it("accepts every authority-bearing class", () => {
      for (const authorityClass of [
        "autonomous-ai",
        "externally-delegated-ai",
        "human-approved",
      ]) {
        const result = readAuthorityEnvelope(envelopeInput({ authorityClass }));
        expect(result.ok, authorityClass).toBe(true);
      }
    });

    it("returns a frozen envelope", () => {
      const result = readAuthorityEnvelope(envelopeInput());
      if (!result.ok) throw new Error("expected a valid envelope");

      expect(Object.isFrozen(result.envelope)).toBe(true);
      expect(Object.isFrozen(result.envelope.target)).toBe(true);
    });

    it("does not alias the caller-supplied target object", () => {
      const input = envelopeInput();
      const result = readAuthorityEnvelope(input);
      if (!result.ok) throw new Error("expected a valid envelope");
      (input.target as Record<string, unknown>).repository = "mutated";

      expect(result.envelope.target.repository).toBe("datazup/scripts");
    });
  });

  describe("rejecting a malformed envelope", () => {
    it.each([
      ["null", null],
      ["undefined", undefined],
      ["a string", "not-an-envelope"],
      ["an array", []],
    ])("refuses %s", (_label, value) => {
      const result = readAuthorityEnvelope(value);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected refusal");
      expect(result.reason).toBe("not-an-envelope");
    });

    it("refuses a foreign schema rather than trusting the shape", () => {
      const result = readAuthorityEnvelope(
        envelopeInput({ schema: "datazup/some-other-envelope/v1" })
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected refusal");
      expect(result.reason).toBe("unsupported-schema");
    });

    it.each(["campaignId", "gateId", "nonce", "issuedAt", "expiresAt"])(
      "refuses a missing %s",
      (field) => {
        const result = readAuthorityEnvelope(
          envelopeInput({ [field]: undefined })
        );

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("expected refusal");
        expect(result.reason).toBe("malformed-field");
        expect(result.message).toContain(field);
      }
    );

    it("refuses a blank string where an identifier is required", () => {
      const result = readAuthorityEnvelope(
        envelopeInput({ campaignId: "   " })
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected refusal");
      expect(result.reason).toBe("malformed-field");
    });

    it("refuses a malformed target block", () => {
      const result = readAuthorityEnvelope(
        envelopeInput({ target: { repository: "r" } })
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected refusal");
      expect(result.reason).toBe("malformed-field");
      expect(result.message).toContain("target");
    });

    it("refuses a non-boolean authorityGranted rather than coercing it", () => {
      // 'false' is truthy; coercion here would grant authority.
      const result = readAuthorityEnvelope(
        envelopeInput({ authorityGranted: "false" })
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected refusal");
      expect(result.reason).toBe("malformed-field");
    });
  });

  describe("authority-class enforcement", () => {
    it("refuses an unknown authority class", () => {
      const result = readAuthorityEnvelope(
        envelopeInput({ authorityClass: "superuser" })
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected refusal");
      expect(result.reason).toBe("unauthorized-class");
    });

    it("refuses development-unverified, which may never bear authority", () => {
      // The class is real vocabulary but is not eligible for the envelope
      // effect — the exact distinction C3 exists to make.
      const result = readAuthorityEnvelope(
        envelopeInput({ authorityClass: "development-unverified" })
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected refusal");
      expect(result.reason).toBe("unauthorized-class");
      expect(result.message).toContain("development-unverified");
    });

    it("refuses an inherited Object property posing as a class", () => {
      const result = readAuthorityEnvelope(
        envelopeInput({ authorityClass: "constructor" })
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected refusal");
      expect(result.reason).toBe("unauthorized-class");
    });

    it("fails closed on a missing authority class", () => {
      const result = readAuthorityEnvelope(
        envelopeInput({ authorityClass: undefined })
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected refusal");
      expect(result.reason).toBe("unauthorized-class");
    });
  });

  describe("the type it produces", () => {
    it("types authorityClass as the union, not string", () => {
      const result = readAuthorityEnvelope(envelopeInput());
      if (!result.ok) throw new Error("expected a valid envelope");

      // Compiles only because the field is narrowed to AuthorityClass; this is
      // the whole point of the reader.
      const narrowed: AuthorityClass = result.envelope.authorityClass;
      expect(narrowed).toBe("human-approved");
    });

    it("exposes the envelope through the exported type", () => {
      const result = readAuthorityEnvelope(envelopeInput());
      if (!result.ok) throw new Error("expected a valid envelope");

      const typed: AuthorityEnvelope = result.envelope;
      expect(typed.gateId).toBe("G01");
    });
  });

  describe("cross-stack parity with the G01 source of truth", () => {
    it("pins the schema string the lab actually stamps", async () => {
      // If the lab revs its envelope schema, this reader must not keep
      // silently accepting the old one as though nothing changed.
      const lab = await import(
        /* @vite-ignore */
        G01_AUTHORITY_ENVELOPE_URL.href
      ).then(
        (m) => (m.default ?? m) as { G01_AUTHORITY_ENVELOPE_SCHEMA: string }
      );

      expect(G01_AUTHORITY_ENVELOPE_SCHEMA).toBe(
        lab.G01_AUTHORITY_ENVELOPE_SCHEMA
      );
    });

    it("reads every field the lab's builder emits at the envelope top level", async () => {
      // Guards the other drift direction: a field the lab adds and this
      // reader drops would be invisible to a consumer holding the narrowed
      // type. Provenance and receipts are intentionally excluded — they are
      // operator-side adjudication evidence, not framework-read claims.
      const source = await import("node:fs/promises").then((fs) =>
        fs.readFile(G01_AUTHORITY_ENVELOPE_URL, "utf8")
      );

      // Start one line above the first field so the line-anchored match sees
      // `schema:` too, rather than consuming it as the slice boundary.
      const built = source.slice(
        source.lastIndexOf(
          "\n",
          source.indexOf("schema: G01_AUTHORITY_ENVELOPE_SCHEMA")
        ),
        source.indexOf("provenance: {")
      );
      expect(built).not.toBe("");

      const emitted = [...built.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]);
      expect(emitted.length).toBeGreaterThan(0);

      const result = readAuthorityEnvelope(envelopeInput());
      if (!result.ok) throw new Error("expected a valid envelope");
      const read = Object.keys(result.envelope);

      expect([...emitted].sort()).toEqual([...read].sort());
    });
  });
});
