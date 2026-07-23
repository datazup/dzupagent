import { describe, expect, it } from "vitest";

import {
  createFlowCredentialHandle,
  FLOW_CREDENTIAL_HANDLE_SCHEMA,
  FLOW_REDACTION_RECEIPT_SCHEMA,
  FLOW_REDACTION_RESULT_SCHEMA,
  isFlowCredentialHandle,
  validateFlowRedactionReceipt,
  validateFlowRedactionResult,
  type FlowAppliedRedactionReceipt,
} from "../types.js";

const DIGEST = `sha256:${"a".repeat(64)}` as const;
const OUTPUT_DIGEST = `sha256:${"b".repeat(64)}` as const;

function appliedReceipt(): FlowAppliedRedactionReceipt {
  return {
    schema: FLOW_REDACTION_RECEIPT_SCHEMA,
    receiptId: "receipt-1",
    operationId: "operation-1",
    status: "applied",
    transform: {
      ref: "transform://dzupagent/evidence-redaction@1",
      version: "1",
      semanticHash: DIGEST,
    },
    policy: {
      ref: "policy://dzupagent/evidence-redaction@1",
      authority: "workspace-policy",
    },
    hostCapabilityRef: "flow.runtime.evidence.redact@1",
    input: {
      classification: "secret",
      digest: DIGEST,
    },
    requestedOutputClassification: "internal",
    output: {
      classification: "internal",
      digest: OUTPUT_DIGEST,
    },
    issuedAt: "2026-07-23T20:00:00.000Z",
    attestation: {
      algorithm: "ed25519",
      keyRef: "key://workspace/redaction-receipts@1",
      payloadDigest: DIGEST,
      signature: "YWJjZA==",
    },
  };
}

describe("credential handle contracts", () => {
  it("creates a frozen nominal handle without copying secret material", () => {
    const handle = createFlowCredentialHandle({
      schema: FLOW_CREDENTIAL_HANDLE_SCHEMA,
      handleId: "credential-1",
      bindingRef: "binding://workspace/provider",
      capabilityRef: "credential.resolve@1",
      provider: "codex",
      scopes: ["provider.invoke"],
      rawSecret: "must-not-cross-contract",
    } as Parameters<typeof createFlowCredentialHandle>[0] & {
      rawSecret: string;
    });

    expect(isFlowCredentialHandle(handle)).toBe(true);
    expect(
      isFlowCredentialHandle({
        ...handle,
      }),
    ).toBe(false);
    expect(Object.isFrozen(handle)).toBe(true);
    expect(JSON.stringify(handle)).not.toContain("must-not-cross-contract");
  });

  it("rejects invalid handle expiration metadata", () => {
    expect(() =>
      createFlowCredentialHandle({
        schema: FLOW_CREDENTIAL_HANDLE_SCHEMA,
        handleId: "credential-1",
        bindingRef: "binding://workspace/provider",
        capabilityRef: "credential.resolve@1",
        scopes: [],
        expiresAt: "tomorrow",
      }),
    ).toThrow(/expiresAt/);
    expect(() =>
      createFlowCredentialHandle({
        schema: FLOW_CREDENTIAL_HANDLE_SCHEMA,
        handleId: "credential-1",
        bindingRef: "binding://workspace/provider",
        capabilityRef: "credential.resolve@1",
        scopes: ["provider.invoke", "provider.invoke"],
      }),
    ).toThrow(/duplicates/);
  });
});

describe("redaction receipt contracts", () => {
  it("accepts an applied, signed, classification-monotonic result", () => {
    const receipt = appliedReceipt();
    expect(validateFlowRedactionReceipt(receipt)).toEqual({
      valid: true,
      issues: [],
    });
    expect(
      validateFlowRedactionResult({
        schema: FLOW_REDACTION_RESULT_SCHEMA,
        status: "applied",
        output: {
          value: { summary: "redacted" },
          classification: "internal",
          digest: OUTPUT_DIGEST,
        },
        receipt,
      }),
    ).toEqual({ valid: true, issues: [] });
  });

  it("rejects an output above the reviewed classification and result drift", () => {
    const receipt = {
      ...appliedReceipt(),
      rawContent: "must-never-enter-a-receipt",
      output: {
        classification: "sensitive",
        digest: OUTPUT_DIGEST,
      },
    } as const;
    const receiptValidation = validateFlowRedactionReceipt(receipt);
    expect(receiptValidation.valid).toBe(false);
    expect(receiptValidation.issues).toContain(
      "output classification cannot exceed requested output classification",
    );
    expect(receiptValidation.issues).toContain(
      "receipt.rawContent is not allowed",
    );
    expect(
      validateFlowRedactionReceipt({
        ...appliedReceipt(),
        input: {
          classification: "internal",
          digest: DIGEST,
        },
        requestedOutputClassification: "sensitive",
      }).issues,
    ).toContain(
      "requested output classification cannot exceed input classification",
    );

    const resultValidation = validateFlowRedactionResult({
      schema: FLOW_REDACTION_RESULT_SCHEMA,
      status: "applied",
      output: {
        value: "redacted",
        classification: "internal",
        digest: DIGEST,
      },
      receipt,
    });
    expect(resultValidation.valid).toBe(false);
    expect(resultValidation.issues).toContain(
      "result output metadata must match receipt output",
    );
  });
});
