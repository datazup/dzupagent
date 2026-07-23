import { generateKeyPairSync } from "node:crypto";

import {
  createFlowCredentialHandle,
  FLOW_CREDENTIAL_HANDLE_SCHEMA,
  FLOW_CREDENTIAL_LEASE_SCHEMA,
  FLOW_REDACTION_RECEIPT_SCHEMA,
  FLOW_REDACTION_RESULT_SCHEMA,
  type FlowCredentialHandleResolver,
  type FlowNode,
  type FlowRedactionResult,
} from "@dzupagent/flow-ast";
import { describe, expect, it, vi } from "vitest";

import {
  InMemoryFlowRedactionReceiptCustodyStore,
  admitFlowCompiledClassificationEnvelope,
  attestFlowRedactionReceipt,
  canonicalizeFlowSecurityJson,
  commitFlowRedactionResult,
  createFlowCompiledClassificationEnvelope,
  digestFlowSecurityJson,
  resolveFlowCredentialLeaseForEnvelope,
  verifyFlowRedactionReceiptAttestation,
  type FlowCompiledClassificationEnvelope,
  type FlowUnsignedRedactionReceipt,
} from "../index.js";

const SEMANTIC_HASH = "semantic-host-security";
const TRANSFORM_DIGEST = `sha256:${"a".repeat(64)}` as const;

function credentialEnvelope(): FlowCompiledClassificationEnvelope {
  const node = {
    type: "adapter.run",
    id: "call",
    provider: "codex",
    instructions: "Perform the bounded task",
    input: { credential: "{{ inputs.providerCredential }}" },
    output: "result",
  } as FlowNode;
  return createFlowCompiledClassificationEnvelope(
    node,
    "compile-host-security",
    SEMANTIC_HASH,
    {
      referenceBindings: {},
      referenceTypeBindings: {},
      referencePortBindings: {},
      referenceClassificationBindings: {},
      referencePortClassificationBindings: {},
    },
  );
}

function unsignedAppliedReceipt(
  outputDigest: `sha256:${string}`,
): FlowUnsignedRedactionReceipt {
  return {
    schema: FLOW_REDACTION_RECEIPT_SCHEMA,
    receiptId: "receipt-applied",
    operationId: "operation-1",
    status: "applied",
    transform: {
      ref: "transform://dzupagent/evidence-redaction@1",
      version: "1",
      semanticHash: TRANSFORM_DIGEST,
    },
    policy: {
      ref: "policy://dzupagent/evidence-redaction@1",
      authority: "workspace-policy",
    },
    hostCapabilityRef: "flow.runtime.evidence.redact@1",
    input: {
      classification: "secret",
      digest: TRANSFORM_DIGEST,
    },
    requestedOutputClassification: "internal",
    output: {
      classification: "internal",
      digest: outputDigest,
    },
    issuedAt: "2026-07-23T22:00:00.000Z",
  };
}

describe("strict classification-envelope host admission", () => {
  it("binds semantic and classification identity and fails closed on capabilities", () => {
    const envelope = credentialEnvelope();
    const required = [
      "flow.runtime.adapter.run@1",
      "flow.runtime.credential.resolve@1",
    ];
    expect(
      admitFlowCompiledClassificationEnvelope({
        envelope,
        expectedSemanticHash: SEMANTIC_HASH,
        expectedClassificationHash: envelope.classificationHash,
        expectedCompileId: envelope.compileId,
        availableCapabilities: required,
      }),
    ).toEqual(
      expect.objectContaining({
        admitted: true,
        issues: [],
        requiredCapabilities: required,
        missingCapabilities: [],
        envelope,
      }),
    );
    expect(
      admitFlowCompiledClassificationEnvelope({
        envelope,
        expectedSemanticHash: SEMANTIC_HASH,
        availableCapabilities: ["flow.runtime.adapter.run@1"],
      }),
    ).toEqual(
      expect.objectContaining({
        admitted: false,
        missingCapabilities: ["flow.runtime.credential.resolve@1"],
        issues: [
          "required host capability is unavailable: flow.runtime.credential.resolve@1",
        ],
      }),
    );
    expect(
      admitFlowCompiledClassificationEnvelope({
        envelope: { ...envelope, semanticHash: "tampered" },
        expectedSemanticHash: SEMANTIC_HASH,
        availableCapabilities: required,
      }).issues,
    ).toContain("classificationHash does not match envelope contents");
    expect(
      admitFlowCompiledClassificationEnvelope({
        envelope,
        expectedSemanticHash: SEMANTIC_HASH,
        expectedClassificationHash: `sha256:${"f".repeat(64)}`,
        availableCapabilities: required,
      }).issues,
    ).toContain("classificationHash does not match the admitted artifact");
    const incomplete = createFlowCompiledClassificationEnvelope(
      {
        type: "adapter.run",
        id: "call",
        provider: "codex",
        instructions: "Perform the bounded task",
        input: {},
        output: "result",
      } as FlowNode,
      "compile-incomplete",
      SEMANTIC_HASH,
      {
        referenceBindings: { context: ["tenantLabel"] },
        referenceTypeBindings: { context: { tenantLabel: "string" } },
        referencePortBindings: {},
        referenceClassificationBindings: {},
        referencePortClassificationBindings: {},
      },
    );
    expect(
      admitFlowCompiledClassificationEnvelope({
        envelope: incomplete,
        expectedSemanticHash: SEMANTIC_HASH,
        availableCapabilities: required,
      }).issues,
    ).toContain(
      "classification coverage is incomplete: context.tenantLabel",
    );
  });
});

describe("credential lease admission", () => {
  it("resolves only exact envelope-authorized use and rejects bad leases", async () => {
    const envelope = credentialEnvelope();
    const handle = createFlowCredentialHandle({
      schema: FLOW_CREDENTIAL_HANDLE_SCHEMA,
      handleId: "credential-1",
      bindingRef: "binding://workspace/codex",
      capabilityRef: "flow.runtime.credential.resolve@1",
      scopes: ["provider.invoke"],
    });
    const release = vi.fn();
    const resolve = vi.fn<FlowCredentialHandleResolver["resolve"]>(
      async (_handle, use) => ({
        status: "resolved",
        lease: {
          schema: FLOW_CREDENTIAL_LEASE_SCHEMA,
          leaseId: "lease-1",
          handleId: "credential-1",
          capabilityRef: use.capabilityRef,
          expiresAt: "2026-07-24T01:00:00.000Z",
        },
      }),
    );
    const resolver: FlowCredentialHandleResolver = { resolve, release };
    const admitted = await resolveFlowCredentialLeaseForEnvelope({
      envelope,
      nodePath: "root",
      inputPath: "input.credential",
      handle,
      resolver,
      runId: "run-1",
      attemptId: "attempt-1",
      now: new Date("2026-07-23T23:00:00.000Z"),
    });
    expect(admitted).toEqual({
      status: "resolved",
      lease: expect.objectContaining({
        leaseId: "lease-1",
        handleId: "credential-1",
      }),
    });
    expect(resolve).toHaveBeenCalledWith(
      handle,
      expect.objectContaining({
        primitiveRef: "primitive://adapter.run@1",
        inputPath: "input.credential",
        capabilityRef: "flow.runtime.credential.resolve@1",
        runId: "run-1",
        attemptId: "attempt-1",
      }),
    );

    expect(
      await resolveFlowCredentialLeaseForEnvelope({
        envelope,
        nodePath: "root",
        inputPath: "input.rawToken",
        handle,
        resolver,
      }),
    ).toEqual({
      status: "denied",
      code: "CREDENTIAL_PATH_NOT_ADMITTED",
    });
    expect(resolve).toHaveBeenCalledTimes(1);

    resolve.mockResolvedValueOnce({
      status: "resolved",
      lease: {
        schema: FLOW_CREDENTIAL_LEASE_SCHEMA,
        leaseId: "lease-bad",
        handleId: "another-handle",
        capabilityRef: "flow.runtime.credential.resolve@1",
      },
    });
    expect(
      await resolveFlowCredentialLeaseForEnvelope({
        envelope,
        nodePath: "root",
        inputPath: "input.credential",
        handle,
        resolver,
      }),
    ).toEqual({
      status: "denied",
      code: "CREDENTIAL_LEASE_HANDLE_MISMATCH",
    });
    expect(release).toHaveBeenCalledWith(
      expect.objectContaining({ leaseId: "lease-bad" }),
    );
  });
});

describe("redaction receipt authority and custody", () => {
  it("canonicalizes, signs, and verifies an Ed25519 receipt", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const outputDigest = digestFlowSecurityJson({ summary: "redacted" });
    const unsigned = unsignedAppliedReceipt(outputDigest);
    const receipt = attestFlowRedactionReceipt(
      unsigned,
      "key://workspace/redaction@1",
      privateKey,
    );
    if (receipt.status !== "applied") {
      throw new Error("expected applied receipt");
    }
    expect(Object.isFrozen(unsigned.transform)).toBe(false);
    expect(Object.isFrozen(receipt.transform)).toBe(true);
    expect(canonicalizeFlowSecurityJson({ z: 1, a: 2 })).toBe(
      '{"a":2,"z":1}',
    );
    expect(() => canonicalizeFlowSecurityJson("\ud800")).toThrow(
      /unpaired Unicode surrogate/,
    );
    expect(
      await verifyFlowRedactionReceiptAttestation(
        receipt,
        async (keyRef) =>
          keyRef === "key://workspace/redaction@1" ? publicKey : null,
      ),
    ).toEqual({ valid: true, issues: [] });
    expect(
      (
        await verifyFlowRedactionReceiptAttestation(
          {
            ...receipt,
            output: {
              ...receipt.output,
              digest: TRANSFORM_DIGEST,
            },
          },
          async () => publicKey,
        )
      ).issues,
    ).toContain(
      "attestation.payloadDigest does not match receipt payload",
    );
    const anotherKey = generateKeyPairSync("ed25519").publicKey;
    expect(
      (
        await verifyFlowRedactionReceiptAttestation(
          receipt,
          async () => anotherKey,
        )
      ).issues,
    ).toContain("attestation signature is invalid");
  });

  it("atomically stores the first verified terminal result", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const output = { summary: "redacted" };
    const outputDigest = digestFlowSecurityJson(output);
    const receipt = attestFlowRedactionReceipt(
      unsignedAppliedReceipt(outputDigest),
      "key://workspace/redaction@1",
      privateKey,
    );
    const result: FlowRedactionResult<typeof output> = {
      schema: FLOW_REDACTION_RESULT_SCHEMA,
      status: "applied",
      output: {
        value: output,
        classification: "internal",
        digest: outputDigest,
      },
      receipt: receipt.status === "applied"
        ? receipt
        : (() => {
            throw new Error("expected applied receipt");
          })(),
    };
    const store = new InMemoryFlowRedactionReceiptCustodyStore<typeof output>();
    const request = {
      result,
      store,
      resolvePublicKey: async () => publicKey,
      committedAt: "2026-07-23T23:00:00.000Z",
    };
    const first = await commitFlowRedactionResult(request);
    const duplicate = await commitFlowRedactionResult(request);
    expect(first.status).toBe("stored");
    expect(duplicate.status).toBe("duplicate");
    expect(store.get("operation-1")).toEqual(
      expect.objectContaining({
        operationId: "operation-1",
        result: expect.objectContaining({ status: "applied" }),
      }),
    );

    const concurrentStore =
      new InMemoryFlowRedactionReceiptCustodyStore<typeof output>();
    const concurrent = await Promise.all([
      commitFlowRedactionResult({ ...request, store: concurrentStore }),
      commitFlowRedactionResult({ ...request, store: concurrentStore }),
    ]);
    expect(concurrent.map((entry) => entry.status).sort()).toEqual([
      "duplicate",
      "stored",
    ]);

    const changedOutput = { summary: "different" };
    const changedDigest = digestFlowSecurityJson(changedOutput);
    const conflictingReceipt = attestFlowRedactionReceipt(
      {
        ...unsignedAppliedReceipt(changedDigest),
        receiptId: "receipt-conflict",
      },
      "key://workspace/redaction@1",
      privateKey,
    );
    if (conflictingReceipt.status !== "applied") {
      throw new Error("expected applied receipt");
    }
    const conflict = await commitFlowRedactionResult({
      ...request,
      result: {
        schema: FLOW_REDACTION_RESULT_SCHEMA,
        status: "applied",
        output: {
          value: changedOutput,
          classification: "internal",
          digest: changedDigest,
        },
        receipt: conflictingReceipt,
      },
    });
    expect(conflict.status).toBe("conflict");

    expect(
      await commitFlowRedactionResult({
        ...request,
        result: {
          ...result,
          output: { ...result.output, value: { summary: "tampered" } },
        },
      }),
    ).toEqual({
      status: "rejected",
      issues: ["result output digest does not match output value"],
    });
  });
});
