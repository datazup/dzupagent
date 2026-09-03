import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  PROVIDER_SESSION_ATTEMPT_BINDING_SCHEMA,
  PROVIDER_SESSION_ATTEMPT_BINDING_SCHEMA_V1,
  PROVIDER_SESSION_CAPABILITIES,
  PROVIDER_SESSION_CAPABILITIES_V1,
  PROVIDER_SESSION_CAPABILITY_DESCRIPTOR_SCHEMA,
  PROVIDER_SESSION_CAPABILITY_DESCRIPTOR_SCHEMA_V1,
  PROVIDER_SESSION_EFFECTS,
  PROVIDER_SESSION_EFFECTS_V1,
  PROVIDER_SESSION_REFERENCE_SCHEMA,
  type ProviderSessionAttemptBinding,
  type ProviderSessionCapability,
} from "@dzupagent/runtime-contracts/provider-session";
import { describe, expect, it } from "vitest";

import {
  validateProviderSessionAdapter,
  type AdapterCapabilityProfile,
  type ProviderSessionAdapter,
} from "../index.js";

interface FixtureProfile {
  id: string;
  providerId: string;
  backend: ProviderSessionAttemptBinding["descriptor"]["backend"];
  nativeCapabilities: ProviderSessionCapability[];
  requiredCapabilities: ProviderSessionCapability[];
  expectedValid: boolean;
}

const corpus = JSON.parse(
  readFileSync(
    join(
      process.cwd(),
      "..",
      "runtime-contracts",
      "fixtures",
      "provider-session-conformance-v2.json",
    ),
    "utf8",
  ),
) as {
  profiles: FixtureProfile[];
  authority: Omit<
    ProviderSessionAttemptBinding["effectAuthorities"][keyof ProviderSessionAttemptBinding["effectAuthorities"]],
    "effect"
  >;
};

function binding(profile: FixtureProfile): ProviderSessionAttemptBinding {
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

function mockRichAdapter(
  attemptBinding: ProviderSessionAttemptBinding,
): ProviderSessionAdapter {
  const session = {
    schema: PROVIDER_SESSION_REFERENCE_SCHEMA,
    kind: "session",
    opaqueId: "mock-session",
  } as const;
  return {
    attemptBinding,
    async steer() {
      return { kind: "steer", accepted: true };
    },
    async interruptTurn() {
      return { kind: "interrupt-turn", accepted: true };
    },
    async forkSession() {
      return { kind: "fork-session", session };
    },
    async startReview() {
      return {
        kind: "start-review",
        review: {
          schema: PROVIDER_SESSION_REFERENCE_SCHEMA,
          kind: "review",
          opaqueId: "mock-review",
        },
      };
    },
    async readHistory() {
      return { kind: "history-read", items: [], hasMore: false };
    },
    async compact() {
      return { kind: "compact", session };
    },
    async getGoal() {
      return { kind: "goal-get", goal: null };
    },
    async setGoal(request) {
      return {
        kind: "goal-set",
        goal: {
          thread: request.thread,
          objectiveDigest:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          status: request.status ?? "active",
          tokenBudget: request.tokenBudget ?? null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
        },
      };
    },
    async clearGoal() {
      return { kind: "goal-clear", cleared: true };
    },
  };
}

describe("provider-session adapter companion contract", () => {
  it("keeps current SDK and CLI profiles source compatible without rich controls", () => {
    for (const id of ["sdk-default", "cli-default"]) {
      const profile = corpus.profiles.find((candidate) => candidate.id === id)!;
      const adapter: ProviderSessionAdapter = {
        attemptBinding: binding(profile),
      };
      expect(validateProviderSessionAdapter(adapter).valid).toBe(true);
      expect(
        validateProviderSessionAdapter(adapter, ["fork-session"]).diagnostics,
      ).toContainEqual(
        expect.objectContaining({ code: "CAPABILITY_REQUIRED_UNSUPPORTED" }),
      );
    }
  });

  it("accepts a retained v1 adapter without requiring v2 goal methods", () => {
    const profile = corpus.profiles.find(({ id }) => id === "sdk-default")!;
    const current = binding(profile);
    const legacy = {
      ...current,
      schema: PROVIDER_SESSION_ATTEMPT_BINDING_SCHEMA_V1,
      descriptor: {
        ...current.descriptor,
        schema: PROVIDER_SESSION_CAPABILITY_DESCRIPTOR_SCHEMA_V1,
        capabilities: Object.fromEntries(
          PROVIDER_SESSION_CAPABILITIES_V1.map((capability) => [
            capability,
            current.descriptor.capabilities[capability],
          ]),
        ),
      },
      effectAuthorities: Object.fromEntries(
        PROVIDER_SESSION_EFFECTS_V1.map((effect) => [
          effect,
          current.effectAuthorities[effect],
        ]),
      ),
    } as unknown as ProviderSessionAttemptBinding;
    expect(
      validateProviderSessionAdapter({ attemptBinding: legacy }).valid,
    ).toBe(true);
    expect(
      validateProviderSessionAdapter({ attemptBinding: legacy }, [
        "goal-control",
      ]).valid,
    ).toBe(false);
  });

  it("requires every method advertised by a native rich-control backend", () => {
    const profile = corpus.profiles.find(({ id }) => id === "mock-app-server")!;
    const complete = mockRichAdapter(binding(profile));
    expect(
      validateProviderSessionAdapter(complete, profile.requiredCapabilities),
    ).toEqual({
      valid: true,
      diagnostics: [],
    });

    const { forkSession: _omitted, ...incomplete } = complete;
    expect(
      validateProviderSessionAdapter(incomplete).diagnostics,
    ).toContainEqual(
      expect.objectContaining({
        code: "NATIVE_CAPABILITY_METHOD_MISSING",
        path: "forkSession",
      }),
    );

    const { clearGoal: _clearGoal, ...incompleteGoalControl } = complete;
    expect(
      validateProviderSessionAdapter(incompleteGoalControl).diagnostics,
    ).toContainEqual(
      expect.objectContaining({
        code: "NATIVE_CAPABILITY_METHOD_MISSING",
        path: "clearGoal",
      }),
    );
  });

  it("does not promote legacy supportsFork into a provider-session capability", () => {
    const legacy: AdapterCapabilityProfile = {
      supportsResume: true,
      supportsFork: false,
      supportsToolCalls: true,
      supportsStreaming: true,
      supportsCostUsage: true,
    };
    const sdk = corpus.profiles.find(({ id }) => id === "sdk-default")!;
    expect(legacy.supportsFork).toBe(false);
    expect(binding(sdk).descriptor.capabilities["fork-session"].status).toBe(
      "unsupported",
    );
  });

  it("publishes provider-session subpaths without provider SDK dependencies", () => {
    const adapterPackage = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8"),
    ) as {
      exports: Record<string, unknown>;
      dependencies?: Record<string, string>;
    };
    const runtimePackage = JSON.parse(
      readFileSync(
        join(process.cwd(), "..", "runtime-contracts", "package.json"),
        "utf8",
      ),
    ) as {
      exports: Record<string, unknown>;
      dependencies?: Record<string, string>;
    };

    expect(adapterPackage.exports["./provider-session"]).toBeDefined();
    expect(runtimePackage.exports["./provider-session"]).toBeDefined();
    expect(Object.keys(adapterPackage.dependencies ?? {})).toEqual([
      "@dzupagent/runtime-contracts",
    ]);
    // runtime-contracts carries zod for its pipeline-artifact schemas
    // (ARCH27-T-07) and @dzupagent/canonical-json for its idempotency digest
    // engine (ARCH27-T-13, vendored zero-dep leaf); the point of this pin is
    // that no provider SDK sneaks in.
    expect(Object.keys(runtimePackage.dependencies ?? {})).toEqual([
      "@dzupagent/canonical-json",
      "zod",
    ]);
  });

  it("loads the built runtime and adapter subpaths through their export maps", async () => {
    const runtime =
      await import("@dzupagent/runtime-contracts/provider-session");
    const adapter = await import("@dzupagent/adapter-types/provider-session");

    expect(runtime.PROVIDER_SESSION_CAPABILITY_DESCRIPTOR_SCHEMA).toBe(
      "dzupagent.providerSessionCapabilityDescriptor/v2",
    );
    expect(adapter.validateProviderSessionAdapter).toBeTypeOf("function");
  });
});
