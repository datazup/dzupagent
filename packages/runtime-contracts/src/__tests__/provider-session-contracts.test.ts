import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PROVIDER_SESSION_ATTEMPT_BINDING_SCHEMA,
  PROVIDER_SESSION_CAPABILITIES,
  PROVIDER_SESSION_CAPABILITY_DESCRIPTOR_SCHEMA,
  PROVIDER_SESSION_EFFECTS,
  PROVIDER_SESSION_REFERENCE_SCHEMA,
  validateProviderSessionAttemptBinding,
  type ProviderSessionAttemptBinding,
  type ProviderSessionCapability,
  type ProviderSessionRef,
  type ProviderTurnRef,
} from "../provider-session.js";

interface FixtureProfile {
  id: string;
  providerId: string;
  backend: ProviderSessionAttemptBinding["descriptor"]["backend"];
  nativeCapabilities: ProviderSessionCapability[];
  requiredCapabilities: ProviderSessionCapability[];
  expectedValid: boolean;
}

interface FixtureCorpus {
  schema: string;
  profiles: FixtureProfile[];
  authority: Omit<
    ProviderSessionAttemptBinding["effectAuthorities"][keyof ProviderSessionAttemptBinding["effectAuthorities"]],
    "effect"
  >;
}

const corpus = JSON.parse(
  readFileSync(join(process.cwd(), "fixtures", "provider-session-conformance-v1.json"), "utf8"),
) as FixtureCorpus;

function binding(profile: FixtureProfile = corpus.profiles[0]!): ProviderSessionAttemptBinding {
  const native = new Set(profile.nativeCapabilities);
  return {
    schema: PROVIDER_SESSION_ATTEMPT_BINDING_SCHEMA,
    bindingId: `binding-${profile.id}`,
    executionAttemptId: `attempt-${profile.id}`,
    authSourceRef: `auth-source://fixture/${profile.id}`,
    descriptor: {
      schema: PROVIDER_SESSION_CAPABILITY_DESCRIPTOR_SCHEMA,
      descriptorId: `descriptor-${profile.id}`,
      providerId: profile.providerId,
      backend: profile.backend,
      capabilities: Object.fromEntries(
        PROVIDER_SESSION_CAPABILITIES.map((capability) => [
          capability,
          native.has(capability)
            ? { status: "native", emulation: "forbidden" }
            : {
                status: "unsupported",
                emulation: "forbidden",
                reason: "Fixture backend does not expose this capability.",
              },
        ]),
      ) as ProviderSessionAttemptBinding["descriptor"]["capabilities"],
      observedAt: "2026-08-09T00:00:00.000Z",
      evidenceRef: `evidence://provider-session/${profile.id}`,
    },
    effectAuthorities: Object.fromEntries(
      PROVIDER_SESSION_EFFECTS.map((effect) => [
        effect,
        { effect, ...corpus.authority },
      ]),
    ) as ProviderSessionAttemptBinding["effectAuthorities"],
    boundAt: "2026-08-09T00:00:00.000Z",
  };
}

describe("provider-session capability contracts", () => {
  it("validates SDK, CLI, mock App Server, and unsupported fixtures", () => {
    expect(corpus.schema).toBe("dzupagent.providerSessionConformanceCorpus/v1");
    expect(corpus.profiles.map(({ id }) => id)).toEqual([
      "sdk-default",
      "cli-default",
      "mock-app-server",
      "unsupported",
    ]);
    for (const profile of corpus.profiles) {
      expect(
        validateProviderSessionAttemptBinding(
          JSON.parse(JSON.stringify(binding(profile))),
          profile.requiredCapabilities,
        ).valid,
        profile.id,
      ).toBe(profile.expectedValid);
    }
  });

  it("fails required unsupported controls before dispatch", () => {
    const result = validateProviderSessionAttemptBinding(binding(), ["fork-session"]);
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "CAPABILITY_REQUIRED_UNSUPPORTED",
        path: "descriptor.capabilities.fork-session",
      }),
    );
  });

  it("rejects raw credentials, protocol objects, and incomplete effect authority", () => {
    const unsafe = {
      ...binding(),
      credentials: { apiKey: "must-not-enter-durable-state" },
      protocolObject: { method: "thread/start" },
      effectAuthorities: { ...binding().effectAuthorities, steer: undefined },
    };
    const result = validateProviderSessionAttemptBinding(unsafe);
    expect(result.valid).toBe(false);
    expect(result.diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "SERIALIZABLE_STATE_FORBIDDEN",
        "EFFECT_AUTHORITY_INVALID",
      ]),
    );
  });

  it("keeps session and turn identities opaque and JSON-safe", () => {
    const session: ProviderSessionRef = {
      schema: PROVIDER_SESSION_REFERENCE_SCHEMA,
      kind: "session",
      opaqueId: "provider-owned-session-id",
    };
    const turn: ProviderTurnRef = {
      schema: PROVIDER_SESSION_REFERENCE_SCHEMA,
      kind: "turn",
      opaqueId: "provider-owned-turn-id",
    };
    expect(JSON.parse(JSON.stringify({ session, turn }))).toEqual({ session, turn });
    expect(session).not.toHaveProperty("providerProtocol");
  });
});
