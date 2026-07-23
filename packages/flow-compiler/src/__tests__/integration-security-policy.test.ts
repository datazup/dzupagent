import {
  createFlowCredentialHandle,
  defineFlowToolSecurityPolicy,
  FLOW_CREDENTIAL_HANDLE_SCHEMA,
  FLOW_CREDENTIAL_LEASE_SCHEMA,
  type FlowCredentialHandleResolver,
  type HostToolRegistryEntry,
  type ToolResolver,
} from "@dzupagent/flow-ast";
import { describe, expect, it, vi } from "vitest";

import {
  admitFlowCompiledClassificationEnvelope,
  createFlowCompiler,
  createFlowCompiledClassificationEnvelope,
  createToolResolverFromRegistry,
  resolveFlowToolCredentialLeaseForEnvelope,
  resolveFlowCredentialLeaseForEnvelope,
  resolveToolSecurityReadiness,
  hashFlowToolSecurityPolicy,
  semanticResolve,
  validateHostToolRegistry,
  validateFlowCompiledClassificationEnvelope,
} from "../index.js";

const TOOL_POLICY = defineFlowToolSecurityPolicy({
  acceptedInputClassifications: ["public", "internal", "sensitive"],
  credential: {
    mode: "handle-only",
    inputPaths: ["input.credential"],
    resolverCapabilityRef: "flow.runtime.credential.resolve@1",
    allowedProviders: ["github"],
    requiredScopes: ["issues:write"],
  },
  outputClassification: "sensitive",
  effectClasses: ["network_write"],
  evidence: {
    required: ["provider-request-id"],
    classification: "internal",
    rawContent: "forbidden",
  },
});

const TOOL_ENTRY: HostToolRegistryEntry = {
  ref: "github.issue.create",
  kind: "mcp-tool",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  securityPolicy: TOOL_POLICY,
};

function resolver(entries: readonly HostToolRegistryEntry[] = [TOOL_ENTRY]) {
  return createToolResolverFromRegistry(entries);
}

describe("tool integration security policy", () => {
  it("validates registry readiness and preserves the policy in resolution", () => {
    expect(validateHostToolRegistry([TOOL_ENTRY])).toEqual({
      valid: true,
      diagnostics: [],
    });
    expect(resolveToolSecurityReadiness([TOOL_ENTRY])).toEqual({
      ready: true,
      diagnostics: [],
    });
    expect(
      resolveToolSecurityReadiness([
        {
          ...TOOL_ENTRY,
          ref: "legacy.tool",
          securityPolicy: undefined,
        },
      ]),
    ).toEqual(
      expect.objectContaining({
        ready: false,
        diagnostics: [
          expect.objectContaining({ code: "TOOL_SECURITY_POLICY_MISSING" }),
        ],
      }),
    );
    expect(resolver().resolve(TOOL_ENTRY.ref)?.securityPolicy).toBe(TOOL_POLICY);
  });

  it("projects tool policy identity and admits classified and credential input", async () => {
    const result = await createFlowCompiler({
      toolResolver: resolver(),
      referencePolicy: "strict",
    }).compileDocument({
      dsl: "dzupflow/v1",
      id: "classified_tool_policy",
      version: 1,
      inputs: {
        issue: {
          type: "object",
          required: true,
          classification: "sensitive",
        },
        githubCredential: {
          type: "credential",
          required: true,
        },
      },
      root: {
        type: "sequence",
        id: "root",
        nodes: [{
          type: "action",
          id: "create_issue",
          toolRef: "github.issue.create",
          input: {
            issue: "{{ inputs.issue }}",
            credential: "{{ inputs.githubCredential }}",
          },
        }],
      },
    });
    expect("errors" in result).toBe(false);
    if ("errors" in result) throw new Error(JSON.stringify(result.errors));
    const envelope = result.classificationEnvelope;
    if (envelope === undefined) throw new Error("missing classification envelope");
    expect(envelope.integrations).toEqual([
      expect.objectContaining({
        nodePath: "root.nodes[0]",
        nodeId: "create_issue",
        toolRef: "github.issue.create",
        policyHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        credential: {
          mode: "handle-only",
          inputPaths: ["input.credential"],
          resolverCapabilityRef: "flow.runtime.credential.resolve@1",
          allowedProviders: ["github"],
          requiredScopes: ["issues:write"],
        },
        outputClassification: "sensitive",
        effectClasses: ["network_write"],
      }),
    ]);
    expect(
      validateFlowCompiledClassificationEnvelope(
        envelope,
      ),
    ).toEqual({ valid: true, issues: [] });
    expect(
      admitFlowCompiledClassificationEnvelope({
        envelope,
        expectedSemanticHash: result.requirements.semanticHash,
        availableCapabilities: ["flow.runtime.credential.resolve@1"],
        availableIntegrationPolicyHashes: {
          "github.issue.create": hashFlowToolSecurityPolicy(TOOL_POLICY),
        },
      }).admitted,
    ).toBe(true);
    expect(
      admitFlowCompiledClassificationEnvelope({
        envelope,
        expectedSemanticHash: result.requirements.semanticHash,
        availableCapabilities: ["flow.runtime.credential.resolve@1"],
      }).issues,
    ).toContain(
      "integration security policy is unavailable: github.issue.create",
    );
  });

  it("rejects raw secret material and missing unattended tool policy", async () => {
    const rawSecret = await createFlowCompiler({
      toolResolver: resolver(),
      referencePolicy: "strict",
      referenceBindings: { secrets: ["githubToken"] },
      referenceTypeBindings: { secrets: { githubToken: "string" } },
    }).compile({
      type: "action",
      id: "create_issue",
      toolRef: "github.issue.create",
      input: {
        credential: "{{ secrets.githubToken }}",
      },
    });
    expect("errors" in rawSecret).toBe(true);
    if (!("errors" in rawSecret)) throw new Error("expected raw secret denial");
    expect(rawSecret.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "CREDENTIAL_HANDLE_NOT_ALLOWED",
          nodePath: "root.input.credential",
        }),
      ]),
    );

    const legacyResolver: ToolResolver = {
      resolve: (ref) =>
        ref === "legacy.tool"
          ? {
              ref,
              kind: "skill",
              inputSchema: {},
              handle: { ref },
            }
          : null,
      listAvailable: () => ["legacy.tool"],
    };
    const unattended = await createFlowCompiler({
      toolResolver: legacyResolver,
      referencePolicy: "strict",
      admissionProfile: "unattended",
    }).compileDocument({
      dsl: "dzupflow/v1",
      id: "unattended_tool_policy",
      version: 1,
      inputs: {
        task: {
          type: "string",
          required: true,
          classification: "internal",
        },
      },
      root: {
        type: "sequence",
        id: "root",
        nodes: [{
          type: "action",
          id: "legacy_action",
          toolRef: "legacy.tool",
          input: { task: "{{ inputs.task }}" },
        }],
      },
    });
    expect("errors" in unattended).toBe(true);
    if (!("errors" in unattended)) {
      throw new Error("expected unattended policy denial");
    }
    expect(unattended.errors).toContainEqual(
      expect.objectContaining({ code: "TOOL_SECURITY_POLICY_REQUIRED" }),
    );
  });

  it("enforces tool provider and scope before resolving a lease", async () => {
    const compiled = await createFlowCompiler({
      toolResolver: resolver(),
      referencePolicy: "strict",
    }).compileDocument({
      dsl: "dzupflow/v1",
      id: "tool_lease_policy",
      version: 1,
      inputs: {
        githubCredential: { type: "credential", required: true },
      },
      root: {
        type: "sequence",
        id: "root",
        nodes: [{
          type: "action",
          id: "create_issue",
          toolRef: "github.issue.create",
          input: {
            credential: "{{ inputs.githubCredential }}",
          },
        }],
      },
    });
    if ("errors" in compiled) throw new Error(JSON.stringify(compiled.errors));
    const envelope = compiled.classificationEnvelope;
    if (envelope === undefined) throw new Error("missing classification envelope");
    const resolve = vi.fn<FlowCredentialHandleResolver["resolve"]>(
      async (handle, use) => ({
        status: "resolved",
        lease: {
          schema: FLOW_CREDENTIAL_LEASE_SCHEMA,
          leaseId: "lease-tool",
          handleId: handle.handleId,
          capabilityRef: use.capabilityRef,
        },
      }),
    );
    const credentialResolver: FlowCredentialHandleResolver = { resolve };
    const expectedPolicyHash = hashFlowToolSecurityPolicy(TOOL_POLICY);
    const handle = createFlowCredentialHandle({
      schema: FLOW_CREDENTIAL_HANDLE_SCHEMA,
      handleId: "credential-tool",
      bindingRef: "binding://tenant/github",
      capabilityRef: "flow.runtime.credential.resolve@1",
      provider: "github",
      scopes: ["issues:write", "repo:read"],
    });
    expect(
      await resolveFlowToolCredentialLeaseForEnvelope({
        envelope,
        nodePath: "root.nodes[0]",
        inputPath: "input.credential",
        handle,
        resolver: credentialResolver,
        expectedPolicyHash: `sha256:${"0".repeat(64)}`,
      }),
    ).toEqual({
      status: "denied",
      code: "TOOL_SECURITY_POLICY_HASH_MISMATCH",
    });
    expect(
      await resolveFlowToolCredentialLeaseForEnvelope({
        envelope,
        nodePath: "root.nodes[0]",
        inputPath: "input.credential",
        handle,
        resolver: credentialResolver,
        expectedPolicyHash,
      }),
    ).toEqual({
      status: "resolved",
      lease: expect.objectContaining({ leaseId: "lease-tool" }),
    });
    expect(resolve).toHaveBeenCalledWith(
      handle,
      expect.objectContaining({
        toolRef: "github.issue.create",
        inputPath: "input.credential",
      }),
    );

    for (const deniedHandle of [
      createFlowCredentialHandle({
        schema: FLOW_CREDENTIAL_HANDLE_SCHEMA,
        handleId: "wrong-provider",
        bindingRef: "binding://tenant/slack",
        capabilityRef: "flow.runtime.credential.resolve@1",
        provider: "slack",
        scopes: ["issues:write"],
      }),
      createFlowCredentialHandle({
        schema: FLOW_CREDENTIAL_HANDLE_SCHEMA,
        handleId: "missing-scope",
        bindingRef: "binding://tenant/github-read",
        capabilityRef: "flow.runtime.credential.resolve@1",
        provider: "github",
        scopes: ["repo:read"],
      }),
    ]) {
      const denied = await resolveFlowToolCredentialLeaseForEnvelope({
        envelope,
        nodePath: "root.nodes[0]",
        inputPath: "input.credential",
        handle: deniedHandle,
        resolver: credentialResolver,
        expectedPolicyHash,
      });
      expect(denied.status).toBe("denied");
    }
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});

describe("HTTP credential policy", () => {
  const noTools: ToolResolver = {
    resolve: () => null,
    listAvailable: () => [],
  };

  it("admits an opaque handle only at auth.credential", async () => {
    const valid = await semanticResolve(
      {
        type: "http",
        id: "request",
        url: "https://api.example.com/issues",
        method: "POST",
        auth: {
          scheme: "bearer",
          credential: "{{ inputs.apiCredential }}",
          provider: "example-api",
          scopes: ["issues:write"],
        },
      },
      {
        toolResolver: noTools,
        referencePolicy: "strict",
        referenceBindings: { inputs: ["apiCredential"] },
        referenceAvailabilityBindings: { inputs: ["apiCredential"] },
        referenceTypeBindings: {
          inputs: { apiCredential: "credential" },
        },
        referenceClassificationBindings: {
          inputs: { apiCredential: "secret" },
        },
      },
    );
    expect(valid.errors).toEqual([]);

    const invalid = await semanticResolve(
      {
        type: "http",
        id: "request",
        url: "https://api.example.com/issues",
        headers: {
          Authorization: "Bearer {{ inputs.apiCredential }}",
        },
      },
      {
        toolResolver: noTools,
        referencePolicy: "strict",
        referenceBindings: { inputs: ["apiCredential"] },
        referenceAvailabilityBindings: { inputs: ["apiCredential"] },
        referenceTypeBindings: {
          inputs: { apiCredential: "credential" },
        },
        referenceClassificationBindings: {
          inputs: { apiCredential: "secret" },
        },
      },
    );
    expect(invalid.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "CREDENTIAL_HANDLE_INTERPOLATION",
          nodePath: "root.headers.Authorization",
        }),
        expect.objectContaining({
          code: "CREDENTIAL_HANDLE_NOT_ALLOWED",
        }),
      ]),
    );
  });

  it("projects HTTP provider, scope, and reviewed header obligations", async () => {
    const envelope = createFlowCompiledClassificationEnvelope(
      {
        type: "http",
        id: "request",
        url: "https://api.example.com/issues",
        method: "POST",
        auth: {
          scheme: "api-key-header",
          credential: "{{ inputs.apiCredential }}",
          provider: "example-api",
          scopes: ["issues:write"],
          headerName: "X-Example-Key",
        },
      },
      "compile-http-policy",
      "semantic-http-policy",
      {
        referenceBindings: { inputs: ["apiCredential"] },
        referenceTypeBindings: {
          inputs: { apiCredential: "credential" },
        },
        referencePortBindings: {},
        referenceClassificationBindings: {
          inputs: { apiCredential: "secret" },
        },
        referencePortClassificationBindings: {},
      },
    );
    expect(envelope.primitives[0]?.credential).toEqual(
      expect.objectContaining({
        inputPaths: ["auth.credential"],
        allowedProviders: ["example-api"],
        requiredScopes: ["issues:write"],
        httpAuth: {
          scheme: "api-key-header",
          headerName: "X-Example-Key",
        },
      }),
    );
    const handle = createFlowCredentialHandle({
      schema: FLOW_CREDENTIAL_HANDLE_SCHEMA,
      handleId: "http-credential",
      bindingRef: "binding://tenant/example-api",
      capabilityRef: "flow.runtime.credential.resolve@1",
      provider: "example-api",
      scopes: ["issues:write"],
    });
    const resolve = vi.fn<FlowCredentialHandleResolver["resolve"]>(
      async (resolvedHandle, use) => ({
        status: "resolved",
        lease: {
          schema: FLOW_CREDENTIAL_LEASE_SCHEMA,
          leaseId: "http-lease",
          handleId: resolvedHandle.handleId,
          capabilityRef: use.capabilityRef,
        },
      }),
    );
    expect(
      await resolveFlowCredentialLeaseForEnvelope({
        envelope,
        nodePath: "root",
        inputPath: "auth.credential",
        handle,
        resolver: { resolve },
      }),
    ).toEqual({
      status: "resolved",
      lease: expect.objectContaining({ leaseId: "http-lease" }),
    });
    expect(
      await resolveFlowCredentialLeaseForEnvelope({
        envelope,
        nodePath: "root",
        inputPath: "auth.credential",
        handle: createFlowCredentialHandle({
          schema: FLOW_CREDENTIAL_HANDLE_SCHEMA,
          handleId: "http-wrong-provider",
          bindingRef: "binding://tenant/other",
          capabilityRef: "flow.runtime.credential.resolve@1",
          provider: "other-api",
          scopes: ["issues:write"],
        }),
        resolver: { resolve },
      }),
    ).toEqual({
      status: "denied",
      code: "CREDENTIAL_PROVIDER_NOT_ADMITTED",
    });
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
