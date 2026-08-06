import { describe, expect, it } from "vitest";

import {
  FLOW_CREDENTIAL_HANDLE_REF_SCHEMA,
  validateFlowRuntimeInput,
} from "../index.js";

describe("validateFlowRuntimeInput", () => {
  it("applies defaults, maps inputs under the runtime namespace, and produces stable digests", () => {
    const contract = {
      count: { type: "number" as const, default: 2, classification: "public" as const },
      payload: { type: "object" as const, required: true, classification: "sensitive" as const },
    };
    const first = validateFlowRuntimeInput({
      inputContract: contract,
      input: { payload: { z: true, a: [1, 2] } },
    });
    const second = validateFlowRuntimeInput({
      inputContract: contract,
      input: { payload: { a: [1, 2], z: true } },
    });

    expect(first.valid).toBe(true);
    expect(second.valid).toBe(true);
    if (!first.valid || !second.valid) return;
    expect(first.value.inputs).toEqual({ count: 2, payload: { a: [1, 2], z: true } });
    expect(first.value.runtimeState).toEqual({ inputs: first.value.inputs });
    expect(first.value.classifications).toEqual({ count: "public", payload: "sensitive" });
    expect(first.value.payloadDigest).toBe(second.value.payloadDigest);
    expect(first.value.classificationMapDigest).toBe(second.value.classificationMapDigest);
  });

  it("denies missing, unknown, wrong-type, deep, and oversized input", () => {
    const result = validateFlowRuntimeInput({
      inputContract: {
        requiredName: { type: "string", required: true },
        count: { type: "number" },
        nested: { type: "object" },
        note: { type: "string" },
      },
      input: {
        count: "not-a-number",
        unknown: true,
        nested: { a: { b: { c: true } } },
        note: "too long",
      },
      limits: { maxDepth: 2, maxStringBytes: 4 },
    });

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.issues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "FLOW_INPUT_REQUIRED",
        "FLOW_INPUT_UNKNOWN_KEY",
        "FLOW_INPUT_TYPE_MISMATCH",
        "FLOW_INPUT_MAX_DEPTH",
        "FLOW_INPUT_MAX_STRING_BYTES",
      ]),
    );
  });

  it("keeps credential handles separate and rejects inline or raw credential-shaped input", () => {
    const handle = {
      schema: FLOW_CREDENTIAL_HANDLE_REF_SCHEMA,
      handleId: "cred_123",
      bindingRef: "binding://tenant/provider/default",
      capabilityRef: "provider.generate",
      provider: "fixture",
      scopes: ["generate"],
    };
    const accepted = validateFlowRuntimeInput({
      inputContract: { credential: { type: "credential", required: true } },
      input: {},
      credentialHandleRefs: { credential: handle },
    });
    expect(accepted.valid).toBe(true);
    if (accepted.valid) {
      expect(accepted.value.inputs).toEqual({});
      expect(accepted.value.credentialHandleRefs).toEqual({ credential: handle });
      expect(accepted.value.classifications).toEqual({ credential: "secret" });
      expect(accepted.value.credentialHandleDigests.credential).toMatch(/^sha256:[a-f0-9]{64}$/);
    }

    const denied = validateFlowRuntimeInput({
      inputContract: { credential: { type: "credential", required: true } },
      input: { credential: "raw-secret" },
    });
    expect(denied.valid).toBe(false);
    if (!denied.valid) {
      expect(denied.issues.map((entry) => entry.code)).toEqual(
        expect.arrayContaining([
          "FLOW_INPUT_CREDENTIAL_INLINE_DENIED",
          "FLOW_INPUT_CREDENTIAL_HANDLE_REQUIRED",
        ]),
      );
    }
  });

  it("rejects extra credential fields so secret material cannot ride the handle envelope", () => {
    const result = validateFlowRuntimeInput({
      inputContract: { credential: { type: "credential", required: true } },
      credentialHandleRefs: {
        credential: {
          schema: FLOW_CREDENTIAL_HANDLE_REF_SCHEMA,
          handleId: "cred_123",
          bindingRef: "binding://tenant/provider/default",
          capabilityRef: "provider.generate",
          scopes: [],
          token: "must-not-pass",
        },
      },
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues[0]?.code).toBe("FLOW_INPUT_CREDENTIAL_HANDLE_INVALID");
      expect(result.issues[0]?.message).toContain("unsupported fields: token");
    }
  });

  it("binds the total canonical payload to a hard byte limit", () => {
    const result = validateFlowRuntimeInput({
      inputContract: { value: { type: "string", required: true } },
      input: { value: "0123456789" },
      limits: { maxCanonicalBytes: 16 },
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues).toEqual([
        expect.objectContaining({ code: "FLOW_INPUT_MAX_CANONICAL_BYTES" }),
      ]);
    }
  });

  it("rejects prototype-sensitive and malformed durable input keys", () => {
    const input = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    const contract = Object.create(null) as Record<string, { type: "object" }>;
    contract.__proto__ = { type: "object" };

    const result = validateFlowRuntimeInput({ inputContract: contract, input });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.map((entry) => entry.code)).toContain("FLOW_INPUT_KEY_INVALID");
    }
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("requires credential expiry to use an explicit RFC 3339 offset", () => {
    const result = validateFlowRuntimeInput({
      inputContract: { credential: { type: "credential", required: true } },
      credentialHandleRefs: {
        credential: {
          schema: FLOW_CREDENTIAL_HANDLE_REF_SCHEMA,
          handleId: "cred_123",
          bindingRef: "binding://tenant/provider/default",
          capabilityRef: "provider.generate",
          scopes: [],
          expiresAt: "2026-08-06",
        },
      },
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues).toEqual([
        expect.objectContaining({ code: "FLOW_INPUT_CREDENTIAL_HANDLE_INVALID" }),
      ]);
    }
  });

  it("distinguishes omitted input maps from explicit null and canonicalizes scope order", () => {
    const denied = validateFlowRuntimeInput({ input: null });
    expect(denied.valid).toBe(false);
    if (!denied.valid) {
      expect(denied.issues.map((entry) => entry.code)).toContain(
        "FLOW_INPUT_NOT_OBJECT",
      );
    }

    const contract = {
      credential: { type: "credential" as const, required: true },
    };
    const handle = {
      schema: FLOW_CREDENTIAL_HANDLE_REF_SCHEMA,
      handleId: "cred_123",
      bindingRef: "binding://tenant/provider/default",
      capabilityRef: "provider.generate",
      scopes: ["write", "read"],
    };
    const first = validateFlowRuntimeInput({
      inputContract: contract,
      credentialHandleRefs: { credential: handle },
    });
    const second = validateFlowRuntimeInput({
      inputContract: contract,
      credentialHandleRefs: {
        credential: { ...handle, scopes: ["read", "write"] },
      },
    });
    expect(first.valid).toBe(true);
    expect(second.valid).toBe(true);
    if (first.valid && second.valid) {
      expect(first.value.credentialHandleRefs.credential?.scopes).toEqual([
        "read",
        "write",
      ]);
      expect(first.value.payloadDigest).toBe(second.value.payloadDigest);
    }
  });

  it("rejects calendar-invalid RFC 3339 timestamps", () => {
    const result = validateFlowRuntimeInput({
      inputContract: { credential: { type: "credential", required: true } },
      credentialHandleRefs: {
        credential: {
          schema: FLOW_CREDENTIAL_HANDLE_REF_SCHEMA,
          handleId: "cred_123",
          bindingRef: "binding://tenant/provider/default",
          capabilityRef: "provider.generate",
          scopes: [],
          expiresAt: "2026-02-30T10:00:00Z",
        },
      },
    });

    expect(result.valid).toBe(false);
  });
});
