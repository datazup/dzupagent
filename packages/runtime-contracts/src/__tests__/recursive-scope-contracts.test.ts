import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  RECURSIVE_SCOPED_FRAME_SCHEMA_V1,
  RecursiveScopedCommitConflictError,
  deserializeRecursiveScopedCommitV1,
  deserializeRecursiveScopedFrameV1,
  deserializeRecursiveScopedMergeV1,
  materializeRecursiveScopedCommitV1,
  materializeRecursiveScopedFrameV1,
  mergeRecursiveScopedCommitsV1,
  recursiveScopedCommitBindingV1,
  recursiveScopedFrameBindingV1,
  recursiveScopedMergeBindingV1,
  resolveRecursiveAcknowledgementLossV1,
  serializeRecursiveScopedCommitV1,
  serializeRecursiveScopedFrameV1,
  serializeRecursiveScopedMergeV1,
  validateRecursiveScopedCommitV1,
  validateRecursiveScopedFrameV1,
  validateRecursiveScopedMergeV1,
  type RecursiveAcknowledgementEvidenceInputV1,
  type RecursiveIntentKindV1,
  type RecursiveScopedCommitInputV1,
  type RecursiveScopedFrameInputV1,
  type RecursiveScopedFrameV1,
  type RecursiveScopedOwnershipInputV1,
  type RecursiveScopedSha256Digest,
} from "../recursive-scope/index.js";

const sha = (character: string) =>
  `sha256:${character.repeat(64)}` as RecursiveScopedSha256Digest;
const observedAt = "2026-08-18T10:00:00.000Z";

const frameFixtureDigests = {
  branch: {
    bytes: "sha256:135124da6d8ba2e65f7ed8a39e94c2d8e2cd3b9dbb37b76ec75ae39de0b31da0",
    frame: "sha256:963f154ebf4da4269e92dfd72ada1853a4208b9d5e6a084e61c23fd30a22169f",
  },
  "fork-branch": {
    bytes: "sha256:dde064591e144ecaa4719b3a9c3e19f898717fe72a18fa6a54ad82ff0810db96",
    frame: "sha256:6430647d599be146cb08b9268276841b56b461e44af2a1140bd4bfa40a9598c5",
  },
  "for-each-item": {
    bytes: "sha256:2c8da3c384a9a678bb61ee989c887fb09f249ada3cd7005fe38b677155054dc8",
    frame: "sha256:55f6f95a5cf99f8d5f5edb87c1ed23dcf7bd08f43bdff35b99772b19725e8848",
  },
} as const;

const committedAcknowledgement = (
  character: string,
): RecursiveAcknowledgementEvidenceInputV1 => ({
  status: "committed",
  observation: {
    kind: "durable-commit",
    committedIdentity: sha(character),
    evidenceDigest: sha("f"),
  },
  observedAt,
});

const retryableAcknowledgement = (): RecursiveAcknowledgementEvidenceInputV1 => ({
  status: "retryable",
  observation: { kind: "confirmed-absent", evidenceDigest: sha("b") },
  observedAt,
});

const blockedAcknowledgement = (): RecursiveAcknowledgementEvidenceInputV1 => ({
  status: "blocked",
  observation: { kind: "uncertain", evidenceDigest: sha("c") },
  observedAt,
});

function ownership(
  kind: RecursiveScopedFrameInputV1["frameKind"],
  ordinal = 0,
): RecursiveScopedOwnershipInputV1 {
  if (kind === "branch") {
    return {
      kind,
      branchNodeId: "decision",
      branchOrdinal: ordinal,
      branchIdentity: `case-${ordinal}`,
    };
  }
  if (kind === "fork-branch") {
    return {
      kind,
      forkNodeId: "parallel",
      branchOrdinal: ordinal,
      branchIdentity: `parallel-${ordinal}`,
    };
  }
  return {
    kind,
    forEachNodeId: "items",
    itemOrdinal: ordinal,
    itemIdentity: sha(String((ordinal % 10) + 1)),
  };
}

function frameInput(
  kind: RecursiveScopedFrameInputV1["frameKind"] = "fork-branch",
  ordinal = 0,
  overrides: Partial<RecursiveScopedFrameInputV1> = {},
): RecursiveScopedFrameInputV1 {
  return {
    frameKind: kind,
    definition: {
      rootDefinitionId: "root-flow",
      rootDefinitionDigest: sha("a"),
      scopedDefinitionId: "parallel/body",
      scopedDefinitionDigest: sha("b"),
    },
    ownerPath: ["root", "parallel"],
    childScopeId: `parallel/child/${ordinal}`,
    ownership: ownership(kind, ordinal),
    nodeInventory: ["work", "entry"],
    continuation: {
      kind: kind === "for-each-item" ? "for-each-join" : "fork-join",
      nodeId: "join",
      edgeOrdinal: ordinal,
    },
    parentCommitIdentity: sha("c"),
    checkpoint: { cursor: "entry", nested: { z: 1, a: true } },
    ...overrides,
  };
}

function frame(
  kind: RecursiveScopedFrameInputV1["frameKind"] = "fork-branch",
  ordinal = 0,
  overrides: Partial<RecursiveScopedFrameInputV1> = {},
): RecursiveScopedFrameV1 {
  return materializeRecursiveScopedFrameV1(frameInput(kind, ordinal, overrides));
}

function fullCommitInput(
  childFrame: RecursiveScopedFrameV1,
  suffix: string,
): RecursiveScopedCommitInputV1 {
  return {
    frame: childFrame,
    state: { [`state-${suffix}`]: { value: suffix } },
    results: { [`result-${suffix}`]: [suffix] },
    idempotencyKeys: { [`node-${suffix}`]: `idempotency-${suffix}` },
    effects: {
      [`effect-${suffix}`]: {
        idempotencyKey: `effect-key-${suffix}`,
        intentDigest: sha(suffix),
        acknowledgement: committedAcknowledgement(suffix),
      },
    },
    charges: {
      [`charge-${suffix}`]: {
        reservationIdentity: sha(suffix),
        measurementDigest: sha(suffix),
        settledCostMicros: suffix.charCodeAt(0),
        currency: "USD",
        acknowledgement: retryableAcknowledgement(),
      },
    },
    intentClaims: [
      { kind: "interaction", intentKey: `interaction-${suffix}`, nodeId: `node-${suffix}` },
    ],
  };
}

describe("recursive scoped-frame v1", () => {
  it.each(["branch", "fork-branch", "for-each-item"] as const)(
    "round-trips stable canonical bytes and digest for %s",
    (kind) => {
      const value = frame(kind);
      const bytes = serializeRecursiveScopedFrameV1(value);
      const restored = deserializeRecursiveScopedFrameV1(
        bytes,
        recursiveScopedFrameBindingV1(value),
      );

      expect(restored).toEqual(value);
      expect(serializeRecursiveScopedFrameV1(restored)).toBe(bytes);
      expect(restored.frameIdentity).toBe(frameFixtureDigests[kind].frame);
      expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(
        frameFixtureDigests[kind].bytes,
      );
      expect(restored.nodeInventory).toEqual(["entry", "work"]);
      expect(restored.ownership.ordinalIdentity).toMatch(/^sha256:[a-f0-9]{64}$/);
    },
  );

  it("pins the canonical fork-frame bytes and digest", () => {
    const value = frame();
    expect(serializeRecursiveScopedFrameV1(value)).toBe(
      '{"canonicalization":"dzupagent.sorted-json/v1","checkpoint":{"cursor":"entry","nested":{"a":true,"z":1}},"childScopeId":"parallel/child/0","childScopeIdentity":"sha256:d16e918367c2c5eb4e4696849a10f0518d12a0bc44d0bfed7df34cdf67789942","continuation":{"edgeOrdinal":0,"kind":"fork-join","nodeId":"join"},"definition":{"rootDefinitionDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","rootDefinitionId":"root-flow","scopedDefinitionDigest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","scopedDefinitionId":"parallel/body"},"frameIdentity":"sha256:6430647d599be146cb08b9268276841b56b461e44af2a1140bd4bfa40a9598c5","frameKind":"fork-branch","nodeInventory":["entry","work"],"nodeInventoryDigest":"sha256:8b3b6cac9fc129e209a60bfd584c3b5c3ce5046f48ecb161308aef4bc7289ac1","ownerPath":["root","parallel"],"ownership":{"branchIdentity":"parallel-0","branchOrdinal":0,"forkNodeId":"parallel","kind":"fork-branch","ordinalIdentity":"sha256:37f7b130e82356930498a1fa2689bd36024c830d8b8169fe0dde689da9b56f85"},"parentCommitIdentity":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","schema":"dzupagent.recursiveScopedFrame/v1"}',
    );
    expect(value.frameIdentity).toBe(
      "sha256:6430647d599be146cb08b9268276841b56b461e44af2a1140bd4bfa40a9598c5",
    );
  });

  it("rejects version, unknown-field, digest, and cyclic corruption", () => {
    const value = frame();
    expect(validateRecursiveScopedFrameV1({
      ...value,
      schema: "dzupagent.recursiveScopedFrame/v2",
    }).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "UNKNOWN_VERSION", path: "$.schema" }),
    ]));
    expect(validateRecursiveScopedFrameV1({ ...value, surprise: true }).issues)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "UNKNOWN_FIELD", path: "$.surprise" }),
      ]));
    expect(validateRecursiveScopedFrameV1({
      ...value,
      ownership: { ...value.ownership, ordinalIdentity: sha("f") },
    }).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "DIGEST_MISMATCH", path: "$.ownership.ordinalIdentity" }),
    ]));
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => validateRecursiveScopedFrameV1({ ...value, checkpoint: cyclic }))
      .not.toThrow();
    expect(validateRecursiveScopedFrameV1({ ...value, checkpoint: cyclic }).valid)
      .toBe(false);
    expect(validateRecursiveScopedFrameV1({ ...value, checkpoint: new Date() }).valid)
      .toBe(false);
  });

  it("makes the unsupported-version boundary explicit during deserialization", () => {
    const value = frame();
    const oldVersion = JSON.stringify({
      ...value,
      schema: "dzupagent.recursiveScopedFrame/v0",
    });
    expect(() => deserializeRecursiveScopedFrameV1(
      oldVersion,
      recursiveScopedFrameBindingV1(value),
    )).toThrow(/Unsupported recursive scoped-frame version/);
    expect(RECURSIVE_SCOPED_FRAME_SCHEMA_V1).toBe("dzupagent.recursiveScopedFrame/v1");
  });

  it.each([
    ["definition", { definition: { ...frameInput().definition, rootDefinitionDigest: sha("d") } }],
    ["root definition ID", { definition: { ...frameInput().definition, rootDefinitionId: "other-root" } }],
    ["scoped definition ID", { definition: { ...frameInput().definition, scopedDefinitionId: "other-scope" } }],
    ["scoped definition digest", { definition: { ...frameInput().definition, scopedDefinitionDigest: sha("d") } }],
    ["owner path", { ownerPath: ["root", "other"] }],
    ["child scope", { childScopeId: "parallel/child/other" }],
    ["inventory", { nodeInventory: ["entry", "other"] }],
    ["continuation", { continuation: { kind: "fork-join" as const, nodeId: "other", edgeOrdinal: 0 } }],
    ["parent commit", { parentCommitIdentity: sha("d") }],
  ] as const)("rejects %s drift against the definition-owned binding", (_label, overrides) => {
    const expectedFrame = frame();
    const drifted = frame("fork-branch", 0, overrides);
    expect(() => deserializeRecursiveScopedFrameV1(
      serializeRecursiveScopedFrameV1(drifted),
      recursiveScopedFrameBindingV1(expectedFrame),
    )).toThrow(/binding failed/);
  });

  it("rejects branch/item ordinal drift after recomputing valid identities", () => {
    for (const kind of ["branch", "fork-branch", "for-each-item"] as const) {
      const expectedFrame = frame(kind, 0);
      const drifted = frame(kind, 1);
      expect(() => deserializeRecursiveScopedFrameV1(
        serializeRecursiveScopedFrameV1(drifted),
        recursiveScopedFrameBindingV1(expectedFrame),
      )).toThrow(/ownership does not match/);
    }
  });

  it("fails closed when a caller supplies an incomplete expected binding", () => {
    const value = frame();
    const { definition: _definition, ...incomplete } = recursiveScopedFrameBindingV1(value);
    expect(() => deserializeRecursiveScopedFrameV1(
      serializeRecursiveScopedFrameV1(value),
      incomplete as ReturnType<typeof recursiveScopedFrameBindingV1>,
    )).toThrow(/definition does not match/);
  });
});

describe("recursive scoped-commit v1", () => {
  it("round-trips a strict commit bound to its child frame and parent commit", () => {
    const value = materializeRecursiveScopedCommitV1(fullCommitInput(frame(), "d"));
    const bytes = serializeRecursiveScopedCommitV1(value);
    const restored = deserializeRecursiveScopedCommitV1(
      bytes,
      recursiveScopedCommitBindingV1(value),
    );

    expect(restored).toEqual(value);
    expect(serializeRecursiveScopedCommitV1(restored)).toBe(bytes);
    expect(value.commitIdentity).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(value.effects["effect-d"]?.acknowledgement.ownerFrameIdentity)
      .toBe(value.frameIdentity);
    expect(value.charges["charge-d"]?.acknowledgement.ownerFrameIdentity)
      .toBe(value.frameIdentity);
  });

  it("rejects commit version, exact-key, owner, and content corruption", () => {
    const value = materializeRecursiveScopedCommitV1(fullCommitInput(frame(), "d"));
    expect(validateRecursiveScopedCommitV1({ ...value, schema: "v2" }).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: "UNKNOWN_VERSION" })]));
    expect(validateRecursiveScopedCommitV1({ ...value, extra: "no" }).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: "UNKNOWN_FIELD" })]));
    expect(validateRecursiveScopedCommitV1({
      ...value,
      intentClaims: value.intentClaims.map((claim) => ({
        ...claim,
        ownerFrameIdentity: sha("f"),
      })),
    }).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "BINDING_MISMATCH" }),
    ]));
    expect(validateRecursiveScopedCommitV1({
      ...value,
      state: { bad: Number.POSITIVE_INFINITY },
    }).valid).toBe(false);
    const cyclicAcknowledgement: Record<string, unknown> = {
      ...value.effects["effect-d"]!.acknowledgement,
    };
    cyclicAcknowledgement.self = cyclicAcknowledgement;
    const cyclicCommit = {
      ...value,
      effects: {
        ...value.effects,
        "effect-d": {
          ...value.effects["effect-d"]!,
          acknowledgement: cyclicAcknowledgement,
        },
      },
    };
    expect(() => validateRecursiveScopedCommitV1(cyclicCommit)).not.toThrow();
    expect(validateRecursiveScopedCommitV1(cyclicCommit).valid).toBe(false);
  });

  it("rejects every definition-owned commit binding drift", () => {
    const value = materializeRecursiveScopedCommitV1(fullCommitInput(frame(), "d"));
    const binding = recursiveScopedCommitBindingV1(value);
    const mutations = [
      { ...binding, rootDefinitionDigest: sha("f") },
      { ...binding, ownerPath: ["root", "other"] },
      { ...binding, childScopeId: "other" },
      { ...binding, childScopeIdentity: sha("f") },
      { ...binding, frameKind: "branch" as const },
      { ...binding, ownership: frame("fork-branch", 1).ownership },
      { ...binding, frameIdentity: sha("f") },
      { ...binding, parentCommitIdentity: sha("f") },
    ];
    for (const expected of mutations) {
      expect(() => deserializeRecursiveScopedCommitV1(
        serializeRecursiveScopedCommitV1(value),
        expected,
      )).toThrow(/binding failed/);
    }
  });

  it("resolves acknowledgement loss only from matching evidence", () => {
    const committed = materializeRecursiveScopedCommitV1(fullCommitInput(frame(), "d"));
    const effect = committed.effects["effect-d"]!;
    const retryableCharge = committed.charges["charge-d"]!;
    const blocked = materializeRecursiveScopedCommitV1({
      frame: frame("branch"),
      effects: {
        blocked: {
          idempotencyKey: "blocked",
          intentDigest: sha("e"),
          acknowledgement: blockedAcknowledgement(),
        },
      },
    }).effects.blocked!;

    expect(resolveRecursiveAcknowledgementLossV1(effect.acknowledgement))
      .toEqual(expect.objectContaining({ status: "committed" }));
    expect(resolveRecursiveAcknowledgementLossV1(retryableCharge.acknowledgement))
      .toEqual(expect.objectContaining({ status: "retryable" }));
    expect(resolveRecursiveAcknowledgementLossV1(blocked.acknowledgement))
      .toEqual(expect.objectContaining({ status: "blocked", reason: "uncertain" }));
    expect(resolveRecursiveAcknowledgementLossV1({
      ...effect.acknowledgement,
      observation: { kind: "uncertain", evidenceDigest: sha("f") },
    })).toEqual({ status: "blocked", reason: "invalid-evidence" });
    expect(resolveRecursiveAcknowledgementLossV1({ status: "unknown" }))
      .toEqual({ status: "blocked", reason: "invalid-evidence" });
  });
});

describe("recursive scoped-commit algebra", () => {
  it("is independent of sibling arrival order and pins aggregate bytes", () => {
    const left = materializeRecursiveScopedCommitV1(fullCommitInput(frame("fork-branch", 0), "d"));
    const right = materializeRecursiveScopedCommitV1(fullCommitInput(frame("fork-branch", 1), "e"));
    const forward = mergeRecursiveScopedCommitsV1([left, right]);
    const reverse = mergeRecursiveScopedCommitsV1([right, left]);

    expect(reverse).toEqual(forward);
    expect(serializeRecursiveScopedMergeV1(reverse)).toBe(
      serializeRecursiveScopedMergeV1(forward),
    );
    expect(deserializeRecursiveScopedMergeV1(
      serializeRecursiveScopedMergeV1(forward),
      recursiveScopedMergeBindingV1(forward),
    )).toEqual(forward);
    expect(forward.childCommitIdentities).toEqual(
      [...forward.childCommitIdentities].sort(),
    );
    expect(forward.mergeIdentity).toBe(
      "sha256:72b7366c5c47a33dc00c905c7c8bf6564310d22def0bf2273af98e1fcc32d4eb",
    );
  });

  it("strictly rejects merge version, owner-set, ordering, and binding drift", () => {
    const left = materializeRecursiveScopedCommitV1(fullCommitInput(frame("fork-branch", 0), "d"));
    const right = materializeRecursiveScopedCommitV1(fullCommitInput(frame("fork-branch", 1), "e"));
    const aggregate = mergeRecursiveScopedCommitsV1([left, right]);
    expect(validateRecursiveScopedMergeV1({ ...aggregate, schema: "v2" }).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: "UNKNOWN_VERSION" })]));
    expect(validateRecursiveScopedMergeV1({
      ...aggregate,
      childFrameIdentities: [aggregate.childFrameIdentities[0]],
    }).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "BINDING_MISMATCH" }),
      expect.objectContaining({ code: "BINDING_MISMATCH", path: expect.stringContaining("ownerFrameIdentity") }),
    ]));
    expect(validateRecursiveScopedMergeV1({
      ...aggregate,
      childCommitIdentities: [...aggregate.childCommitIdentities].reverse(),
    }).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "INVALID_VALUE", path: "$.childCommitIdentities" }),
    ]));
    expect(() => deserializeRecursiveScopedMergeV1(
      serializeRecursiveScopedMergeV1(aggregate),
      { ...recursiveScopedMergeBindingV1(aggregate), parentCommitIdentity: sha("f") },
    )).toThrow(/merge binding failed/);
  });

  it.each([
    ["state", { state: { shared: 1 } }],
    ["result", { results: { shared: 1 } }],
    ["idempotency", { idempotencyKeys: { shared: "key" } }],
    ["effect", {
      effects: {
        shared: {
          idempotencyKey: "shared-effect",
          intentDigest: sha("e"),
          acknowledgement: committedAcknowledgement("e"),
        },
      },
    }],
    ["charge", {
      charges: {
        shared: {
          reservationIdentity: sha("d"),
          measurementDigest: sha("e"),
          settledCostMicros: 1,
          currency: "USD",
          acknowledgement: retryableAcknowledgement(),
        },
      },
    }],
  ] as const)("rejects same-key %s commits across siblings", (_label, delta) => {
    const left = materializeRecursiveScopedCommitV1({
      frame: frame("fork-branch", 0),
      ...delta,
    });
    const right = materializeRecursiveScopedCommitV1({
      frame: frame("fork-branch", 1),
      ...delta,
    });
    expect(() => mergeRecursiveScopedCommitsV1([left, right]))
      .toThrow(RecursiveScopedCommitConflictError);
  });

  it.each(["interaction", "suspension", "error"] as readonly RecursiveIntentKindV1[])(
    "rejects duplicate %s intent ownership across siblings",
    (kind) => {
      const claim = { kind, intentKey: "same-intent", nodeId: "owner-node" };
      const left = materializeRecursiveScopedCommitV1({
        frame: frame("fork-branch", 0),
        intentClaims: [claim],
      });
      const right = materializeRecursiveScopedCommitV1({
        frame: frame("fork-branch", 1),
        intentClaims: [claim],
      });
      expect(() => mergeRecursiveScopedCommitsV1([left, right]))
        .toThrow(/Intent ownership is owned by more than one sibling/);
    },
  );

  it("permits only one terminal owner even when sibling terminal keys differ", () => {
    const left = materializeRecursiveScopedCommitV1({
      frame: frame("fork-branch", 0),
      intentClaims: [{ kind: "terminal", intentKey: "stop-a", nodeId: "stop-a" }],
    });
    const right = materializeRecursiveScopedCommitV1({
      frame: frame("fork-branch", 1),
      intentClaims: [{ kind: "terminal", intentKey: "stop-b", nodeId: "stop-b" }],
    });
    expect(() => mergeRecursiveScopedCommitsV1([left, right]))
      .toThrow(/Terminal ownership is already held/);
  });

  it("rejects two terminal claims within one child commit", () => {
    expect(() => materializeRecursiveScopedCommitV1({
      frame: frame("branch"),
      intentClaims: [
        { kind: "terminal", intentKey: "stop-a", nodeId: "stop-a" },
        { kind: "terminal", intentKey: "stop-b", nodeId: "stop-b" },
      ],
    })).toThrow(/only one terminal intent/);
  });

  it("preserves prototype-shaped JSON keys as merge data", () => {
    const state = Object.fromEntries([["__proto__", { retained: true }]]);
    const commit = materializeRecursiveScopedCommitV1({
      frame: frame("branch"),
      state,
    });
    const aggregate = mergeRecursiveScopedCommitsV1([commit]);
    expect(Object.hasOwn(aggregate.state, "__proto__")).toBe(true);
    expect(aggregate.state.__proto__).toEqual({ retained: true });
  });

  it("rejects duplicate effect identity and charge reservation under different map keys", () => {
    const left = materializeRecursiveScopedCommitV1({
      frame: frame("fork-branch", 0),
      effects: {
        effectA: {
          idempotencyKey: "same-effect",
          intentDigest: sha("d"),
          acknowledgement: committedAcknowledgement("d"),
        },
      },
      charges: {
        chargeA: {
          reservationIdentity: sha("e"),
          measurementDigest: sha("f"),
          settledCostMicros: 1,
          currency: "USD",
          acknowledgement: retryableAcknowledgement(),
        },
      },
    });
    const rightInput = {
      frame: frame("fork-branch", 1),
      effects: { effectB: fullCommitInput(frame(), "d").effects!["effect-d"]! },
      charges: { chargeB: fullCommitInput(frame(), "f").charges!["charge-f"]! },
    };
    const right = materializeRecursiveScopedCommitV1({
      ...rightInput,
      effects: {
        effectB: {
          idempotencyKey: "same-effect",
          intentDigest: sha("d"),
          acknowledgement: committedAcknowledgement("d"),
        },
      },
      charges: {
        chargeB: {
          ...rightInput.charges.chargeB,
          reservationIdentity: sha("e"),
        },
      },
    });
    expect(() => mergeRecursiveScopedCommitsV1([left, right]))
      .toThrow(RecursiveScopedCommitConflictError);
  });
});
