import { describe, expect, it } from "vitest";

import {
  defineFlowConnectorSecurityManifest,
  defineFlowToolSecurityPolicy,
  parseFlow,
  validateFlowConnectorSecurityManifest,
  validateFlowToolSecurityPolicy,
} from "../index.js";

function toolPolicy() {
  return defineFlowToolSecurityPolicy({
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
}

describe("integration security contracts", () => {
  it("freezes a closed tool policy and connector/provider binding", () => {
    const policy = toolPolicy();
    const manifest = defineFlowConnectorSecurityManifest({
      ref: "connector://dzupagent/github@1",
      provider: "github",
      tools: [{ toolRef: "github.issue.create", policy }],
    });

    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.credential.allowedProviders)).toBe(true);
    expect(Object.isFrozen(manifest.tools)).toBe(true);
    expect(validateFlowToolSecurityPolicy(policy)).toEqual([]);
    expect(validateFlowConnectorSecurityManifest(manifest)).toEqual([]);
  });

  it("rejects wildcard providers, raw policy keys, and provider drift", () => {
    expect(
      validateFlowToolSecurityPolicy({
        ...toolPolicy(),
        credential: {
          ...toolPolicy().credential,
          allowedProviders: ["*"],
        },
        rawToken: "not allowed",
      }),
    ).toEqual(
      expect.arrayContaining([
        "policy.rawToken is not allowed",
        "credential.allowedProviders cannot contain wildcards",
      ]),
    );
    expect(
      validateFlowConnectorSecurityManifest({
        schema: "dzupagent.flowConnectorSecurityManifest/v1",
        ref: "connector://dzupagent/slack@1",
        provider: "slack",
        tools: [{ toolRef: "github.issue.create", policy: toolPolicy() }],
      }),
    ).toContain(
      "tools[0].policy.credential.allowedProviders must include connector provider",
    );
  });

  it("parses only reviewed HTTP credential slots", () => {
    const valid = parseFlow({
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
    });
    expect(valid.errors).toEqual([]);
    expect(valid.ast).toEqual(
      expect.objectContaining({
        type: "http",
        auth: expect.objectContaining({
          scheme: "api-key-header",
          headerName: "X-Example-Key",
        }),
      }),
    );

    const reserved = parseFlow({
      type: "http",
      url: "https://api.example.com/issues",
      auth: {
        scheme: "api-key-header",
        credential: "{{ inputs.apiCredential }}",
        provider: "example-api",
        scopes: [],
        headerName: "Authorization",
      },
    });
    expect(reserved.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pointer: "/auth/headerName",
        }),
      ]),
    );
  });
});
