import { describe, expect, it } from "vitest";

import {
  defineFlowConnectorSecurityManifest,
  defineFlowToolSecurityPolicy,
  injectFlowHttpCredentialHeader,
  attachConnectorSecurityManifest,
  resolveConnectorSecurityReadiness,
  createHttpConnectorToolkit,
} from "../index.js";

describe("connector security policy", () => {
  it("publishes provider-bound tool policy without executable or secret data", () => {
    const policy = defineFlowToolSecurityPolicy({
      acceptedInputClassifications: ["public", "internal"],
      credential: {
        mode: "handle-only",
        inputPaths: ["input.credential"],
        resolverCapabilityRef: "flow.runtime.credential.resolve@1",
        allowedProviders: ["example-api"],
        requiredScopes: ["records:read"],
      },
      outputClassification: "sensitive",
      effectClasses: ["read"],
      evidence: {
        required: ["request-id"],
        classification: "internal",
        rawContent: "forbidden",
      },
    });
    const manifest = defineFlowConnectorSecurityManifest({
      ref: "connector://example/api@1",
      provider: "example-api",
      tools: [{ toolRef: "example.records.read", policy }],
    });
    expect(JSON.stringify(manifest)).not.toContain("secret-value");
    expect(manifest.tools[0]?.policy).toBe(policy);
  });

  it("binds every published connector tool to a reviewed policy", () => {
    const policy = defineFlowToolSecurityPolicy({
      acceptedInputClassifications: ["public", "internal"],
      credential: {
        mode: "forbidden",
        inputPaths: [],
        allowedProviders: [],
        requiredScopes: [],
      },
      outputClassification: "sensitive",
      effectClasses: ["network_write"],
      evidence: {
        required: ["http-request-outcome"],
        classification: "internal",
        rawContent: "ephemeral",
      },
    });
    const toolkit = createHttpConnectorToolkit({
      baseUrl: "https://api.example.com",
    });
    expect(resolveConnectorSecurityReadiness(toolkit).ready).toBe(false);
    const secured = attachConnectorSecurityManifest(
      toolkit,
      defineFlowConnectorSecurityManifest({
        ref: "connector://dzupagent/http@1",
        provider: "example-api",
        tools: [{ toolRef: "http_request", policy }],
      }),
    );
    expect(resolveConnectorSecurityReadiness(secured)).toEqual({
      ready: true,
      issues: [],
    });
    expect(toolkit.securityManifest).toBeUndefined();
  });

  it("injects credentials only into reviewed headers without caller mutation", () => {
    const original = { Accept: "application/json" };
    const result = injectFlowHttpCredentialHeader(
      original,
      {
        scheme: "bearer",
        credential: "{{ inputs.apiCredential }}",
        provider: "example-api",
        scopes: ["records:read"],
      },
      "secret-value",
    );
    expect(result).toEqual({
      Accept: "application/json",
      Authorization: "Bearer secret-value",
    });
    expect(original).toEqual({ Accept: "application/json" });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("rejects reserved headers, collisions, and header injection", () => {
    expect(() =>
      injectFlowHttpCredentialHeader(
        {},
        {
          scheme: "api-key-header",
          credential: "{{ inputs.apiCredential }}",
          provider: "example-api",
          scopes: [],
          headerName: "Cookie",
        },
        "secret-value",
      ),
    ).toThrow(/non-reserved/);
    expect(() =>
      injectFlowHttpCredentialHeader(
        { authorization: "existing" },
        {
          scheme: "bearer",
          credential: "{{ inputs.apiCredential }}",
          provider: "example-api",
          scopes: [],
        },
        "secret-value",
      ),
    ).toThrow(/already exists/);
    expect(() =>
      injectFlowHttpCredentialHeader(
        {},
        {
          scheme: "bearer",
          credential: "{{ inputs.apiCredential }}",
          provider: "example-api",
          scopes: [],
        },
        "secret\r\nX-Evil: injected",
      ),
    ).toThrow(/header-safe/);
  });
});
