import { describe, expect, it } from "vitest";

import {
  FLOW_NODE_CAPABILITY_REGISTRY,
  FLOW_PROFILE_LOCK_JSON_SCHEMA,
  FLOW_PROFILE_MANIFEST_JSON_SCHEMA,
  FLOW_PROFILE_MANIFESTS,
  createFlowProfileLock,
  hashFlowProfileManifest,
  validateFlowProfileLock,
  validateFlowProfileManifest,
  type FlowProfileManifest,
} from "../index.js";

describe("flow profile manifest foundation", () => {
  it("publishes versioned JSON schemas for manifests and locks", () => {
    expect(FLOW_PROFILE_MANIFEST_JSON_SCHEMA.$id).toBe(
      "dzupagent.flowProfileManifest/v1",
    );
    expect(FLOW_PROFILE_LOCK_JSON_SCHEMA.$id).toBe(
      "dzupagent.flowProfileLock/v1",
    );
  });

  it("allocates every registered node to exactly one built-in profile", () => {
    const allocated = Object.values(FLOW_PROFILE_MANIFESTS).flatMap(
      (manifest) => manifest.nodeKinds,
    );

    expect([...allocated].sort()).toEqual(
      Object.keys(FLOW_NODE_CAPABILITY_REGISTRY).sort(),
    );
    expect(new Set(allocated).size).toBe(allocated.length);
    for (const [kind, descriptor] of Object.entries(
      FLOW_NODE_CAPABILITY_REGISTRY,
    )) {
      expect(FLOW_PROFILE_MANIFESTS[descriptor.recommendedProfile].nodeKinds).toContain(
        kind,
      );
    }
  });

  it("publishes one stable kernel and extension profiles that depend on it", () => {
    expect(FLOW_PROFILE_MANIFESTS["dzup.core@1"]).toMatchObject({
      kind: "kernel",
      lowering: "core-ir",
      portable: true,
      dependencies: [],
    });
    for (const manifest of Object.values(FLOW_PROFILE_MANIFESTS)) {
      expect(validateFlowProfileManifest(manifest)).toEqual({
        valid: true,
        diagnostics: [],
      });
      if (manifest.ref !== "dzup.core@1") {
        expect(manifest).toMatchObject({
          kind: "extension",
          dependencies: ["dzup.core@1"],
        });
      }
    }
  });

  it("enforces reserved namespaces and exact major-compatible versions", () => {
    const invalid = {
      ...FLOW_PROFILE_MANIFESTS["dzup.llm@1"],
      owner: "host",
      version: "2.0.0",
    } as FlowProfileManifest;

    expect(
      validateFlowProfileManifest(invalid).diagnostics.map(
        (diagnostic) => diagnostic.code,
      ),
    ).toEqual([
      "PROFILE_MAJOR_MISMATCH",
      "RESERVED_NAMESPACE_OWNER_MISMATCH",
    ]);
  });

  it("rejects duplicate and unknown profile contents", () => {
    const invalid = {
      ...FLOW_PROFILE_MANIFESTS["dzup.core@1"],
      nodeKinds: ["action", "action", "not-a-node"],
      capabilities: ["flow.runtime.test@1", "flow.runtime.test@1"],
      dependencies: ["dzup.core@1"],
    } as unknown as FlowProfileManifest;

    expect(
      validateFlowProfileManifest(invalid).diagnostics.map(
        (diagnostic) => diagnostic.code,
      ),
    ).toEqual([
      "DUPLICATE_NODE_KIND",
      "UNKNOWN_NODE_KIND",
      "DUPLICATE_CAPABILITY",
      "SELF_DEPENDENCY",
      "INVALID_KERNEL_PROFILE",
    ]);
  });

  it("enforces the core dependency and capability value contract", () => {
    const invalid = {
      ...FLOW_PROFILE_MANIFESTS["dzup.llm@1"],
      capabilities: [""],
      dependencies: [],
    } as FlowProfileManifest;

    expect(
      validateFlowProfileManifest(invalid).diagnostics.map(
        (diagnostic) => diagnostic.code,
      ),
    ).toEqual(["INVALID_SCHEMA", "MISSING_CORE_DEPENDENCY"]);
  });

  it("creates deterministic sorted locks with verified manifest hashes", () => {
    const first = createFlowProfileLock();
    const second = createFlowProfileLock(
      Object.values(FLOW_PROFILE_MANIFESTS).reverse(),
    );

    expect(second).toEqual(first);
    expect(first.profiles.map((entry) => entry.ref)).toEqual(
      [...first.profiles.map((entry) => entry.ref)].sort(),
    );
    expect(first.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ref: "dzup.core@1",
          version: "1.0.0",
          manifestHash: hashFlowProfileManifest(
            FLOW_PROFILE_MANIFESTS["dzup.core@1"],
          ),
        }),
      ]),
    );
    expect(validateFlowProfileLock(first)).toEqual({
      valid: true,
      diagnostics: [],
    });
    const core = FLOW_PROFILE_MANIFESTS["dzup.core@1"];
    expect(
      hashFlowProfileManifest({
        ...core,
        nodeKinds: [...core.nodeKinds].reverse(),
        capabilities: [...core.capabilities].reverse(),
      }),
    ).toBe(hashFlowProfileManifest(core));
  });

  it("fails closed for duplicate, drifted, and unknown lock entries", () => {
    const lock = createFlowProfileLock();
    const core = lock.profiles.find((entry) => entry.ref === "dzup.core@1");
    if (!core) throw new Error("missing core lock entry");

    const invalid = {
      ...lock,
      profiles: [
        core,
        { ...core, version: "1.0.1", manifestHash: `sha256:${"0".repeat(64)}` },
        {
          ref: "acme.unknown@1",
          version: "1.0.0",
          manifestHash: `sha256:${"1".repeat(64)}`,
        },
      ],
    };

    expect(
      validateFlowProfileLock(invalid).diagnostics.map(
        (diagnostic) => diagnostic.code,
      ),
    ).toEqual([
      "DUPLICATE_LOCK_ENTRY",
      "LOCK_VERSION_MISMATCH",
      "MANIFEST_HASH_MISMATCH",
      "UNKNOWN_LOCK_PROFILE",
    ]);
  });
});
