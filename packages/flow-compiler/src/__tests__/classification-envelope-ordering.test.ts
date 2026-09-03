/**
 * Golden corpus for every array order that feeds the
 * classification-envelope digest.
 *
 * `@dzupagent/canonical-json` canonicalizes *key* order (ARCH27-T-01 replaced
 * `localeCompare` with a UTF-16 code-unit comparator there), but it cannot
 * canonicalize *array element* order — that is fixed by whichever comparator
 * the envelope builder used. Six comparators in `classification-envelope.ts`
 * decide it. For v2 envelopes, the validator also re-checks ordered string
 * sets when a host admits a persisted envelope; v1 preserves its recorded
 * order as part of the legacy hash contract.
 *
 * The fixture below is deliberately *discriminating*: for every one of those
 * arrays, UTF-16 code-unit order and ICU locale order disagree. That is what
 * makes this file able to detect a comparator regression at all — the
 * `LOCALE_ORDER`/`CODE_UNIT_ORDER` pairs are pinned as literals and asserted
 * to differ, so a fixture that quietly stopped discriminating fails loudly
 * instead of passing vacuously.
 */

import type { FlowNode, ResolvedTool } from "@dzupagent/flow-ast";
import { defineFlowToolSecurityPolicy } from "@dzupagent/flow-ast";
import {
  BUILT_IN_PRIMITIVE_REGISTRY_V2,
  type PrimitiveDefinitionV2,
  type PrimitiveOutputPortDefinition,
  type PrimitiveRegistryV2,
} from "@dzupagent/flow-dsl";
import { describe, expect, it } from "vitest";

import {
  admitFlowCompiledClassificationEnvelope,
  createFlowCompiledClassificationEnvelope,
  validateFlowCompiledClassificationEnvelope,
} from "../index.js";
import {
  hashFlowCompiledClassificationEnvelopePayload,
  type FlowClassificationEnvelopeSnapshot,
} from "../classification-envelope.js";
import type { FlowPrimitiveBindings } from "../primitive-registry-types.js";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const BASE = BUILT_IN_PRIMITIVE_REGISTRY_V2.resolve(
  "adapter.run",
) as PrimitiveDefinitionV2;

const BASE_PORT = BASE.outputPorts.result as PrimitiveOutputPortDefinition;

/**
 * A stub primitive whose capability list and output ports are mixed-case, so
 * the two comparators inside `primitiveObligations` are observable. The
 * built-in primitives are all lowercase dotted identifiers, for which locale
 * and code-unit order happen to agree, so they cannot discriminate.
 */
const ORDERING_PRIMITIVE: PrimitiveDefinitionV2 = {
  ...BASE,
  ref: "primitive://test.ordering@1",
  name: "ordering",
  requiresCapabilities: [
    "flow.runtime.Beta@1",
    "flow.runtime.alpha@1",
    "flow.runtime.Alpha@1",
  ],
  outputPorts: {
    Result: BASE_PORT,
    result: BASE_PORT,
    Audit: BASE_PORT,
  },
};

const REGISTRY: PrimitiveRegistryV2 = {
  schema: "dzupagent.primitiveRegistry/v2",
  registryHash:
    "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  get: (ref) =>
    ref === ORDERING_PRIMITIVE.ref ? ORDERING_PRIMITIVE : undefined,
  resolve: () => undefined,
  resolveAlias: () => undefined,
  list: () => [ORDERING_PRIMITIVE],
  has: (ref) => ref === ORDERING_PRIMITIVE.ref,
};

/** Bind the `set` kind, which has no built-in V2 contract, to the stub. */
const BINDINGS: FlowPrimitiveBindings = {
  set: {
    ref: ORDERING_PRIMITIVE.ref,
    semanticHash: ORDERING_PRIMITIVE.compatibility.semanticHash,
  },
};

const setNode = (id: string): FlowNode =>
  ({ type: "set", id, assign: { value: "1" } }) as FlowNode;

/**
 * Eleven children so that `root.nodes[10]` coexists with a nested
 * `root.nodes[1].nodes[0]`. Those two paths are the canonical case where
 * locale and code-unit order disagree on punctuation: `']'` (U+005D) sorts
 * after `'0'` (U+0030) by code unit, while ICU treats `']'` as variable and
 * orders the nested path first.
 */
const ROOT: FlowNode = {
  type: "sequence",
  id: "root",
  nodes: [
    setNode("n0"),
    { type: "sequence", id: "nested", nodes: [setNode("deep")] } as FlowNode,
    setNode("n2"),
    setNode("n3"),
    setNode("n4"),
    setNode("n5"),
    setNode("n6"),
    setNode("n7"),
    setNode("n8"),
    setNode("n9"),
    setNode("n10"),
  ],
} as FlowNode;

const POLICY = defineFlowToolSecurityPolicy({
  acceptedInputClassifications: ["public", "internal"],
  credential: {
    mode: "handle-only",
    inputPaths: ["input.Token", "input.token"],
    resolverCapabilityRef: "flow.runtime.credential.resolve@1",
    allowedProviders: ["Zeta", "alpha"],
    requiredScopes: ["Read", "read"],
  },
  outputClassification: "internal",
  effectClasses: ["read"],
  evidence: {
    required: [],
    classification: "internal",
    rawContent: "forbidden",
  },
});

const tool = (ref: string): ResolvedTool => ({
  ref,
  kind: "skill",
  inputSchema: { type: "object" },
  handle: {
    name: ref,
    description: "ordering corpus tool",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    permissionLevel: "read",
    sideEffects: [],
    namespace: "corpus",
  },
  securityPolicy: POLICY,
});

const RESOLVED_TOOLS = new Map<string, ResolvedTool>([
  ["root.nodes[10]", tool("corpus.ten")],
  ["root.nodes[1].nodes[0]", tool("corpus.deep")],
  ["root.nodes[2]", tool("corpus.two")],
]);

const SNAPSHOT = {
  referenceBindings: {
    state: ["Alpha", "alpha", "beta", "Gamma", "gamma"],
    inputs: ["Zeta", "zeta"],
  },
  referenceTypeBindings: {
    state: { Alpha: "string", alpha: "string", beta: "string" },
    inputs: { Zeta: "string", zeta: "credential" },
  },
  referencePortBindings: {
    Step: { Result: "object", result: "object" },
    step: { out: "object" },
  },
  referenceClassificationBindings: {
    state: { Alpha: "internal", alpha: "secret", beta: "public" },
    inputs: { Zeta: "public", zeta: "secret" },
  },
  referencePortClassificationBindings: {
    Step: { Result: "internal", result: "public" },
    step: { out: "public" },
  },
} as unknown as FlowClassificationEnvelopeSnapshot;

const buildEnvelope = () =>
  createFlowCompiledClassificationEnvelope(
    ROOT,
    "compile-ordering",
    "semantic-ordering",
    SNAPSHOT,
    RESOLVED_TOOLS,
    REGISTRY,
    BINDINGS,
  );

// ---------------------------------------------------------------------------
// The two orders, pinned as literals
// ---------------------------------------------------------------------------

/** What ICU en-US collation produces — the order this package emitted before. */
const LOCALE_ORDER = {
  unclassifiedReferences: ["state.gamma", "state.Gamma"],
  values: [
    "inputs.zeta",
    "inputs.Zeta",
    "state.alpha",
    "state.Alpha",
    "state.beta",
  ],
  ports: ["steps.step.out", "steps.Step.result", "steps.Step.Result"],
  primitives: [
    "root.nodes[0]",
    "root.nodes[1].nodes[0]",
    "root.nodes[10]",
    "root.nodes[2]",
    "root.nodes[3]",
    "root.nodes[4]",
    "root.nodes[5]",
    "root.nodes[6]",
    "root.nodes[7]",
    "root.nodes[8]",
    "root.nodes[9]",
  ],
  requiredCapabilities: [
    "flow.runtime.alpha@1",
    "flow.runtime.Alpha@1",
    "flow.runtime.Beta@1",
  ],
  outputs: ["Audit", "result", "Result"],
  integrations: ["root.nodes[1].nodes[0]", "root.nodes[10]", "root.nodes[2]"],
} as const;

/** What UTF-16 code-unit order produces — host-independent. */
const CODE_UNIT_ORDER = {
  unclassifiedReferences: ["state.Gamma", "state.gamma"],
  values: [
    "inputs.Zeta",
    "inputs.zeta",
    "state.Alpha",
    "state.alpha",
    "state.beta",
  ],
  ports: ["steps.Step.Result", "steps.Step.result", "steps.step.out"],
  primitives: [
    "root.nodes[0]",
    "root.nodes[10]",
    "root.nodes[1].nodes[0]",
    "root.nodes[2]",
    "root.nodes[3]",
    "root.nodes[4]",
    "root.nodes[5]",
    "root.nodes[6]",
    "root.nodes[7]",
    "root.nodes[8]",
    "root.nodes[9]",
  ],
  requiredCapabilities: [
    "flow.runtime.Alpha@1",
    "flow.runtime.Beta@1",
    "flow.runtime.alpha@1",
  ],
  outputs: ["Audit", "Result", "result"],
  integrations: ["root.nodes[10]", "root.nodes[1].nodes[0]", "root.nodes[2]"],
} as const;

/**
 * The digest this package produced for the corpus above while the six
 * comparators were `localeCompare`, measured under ICU en-US. Kept as the
 * explicit record of what the migration moved: it was never stable across
 * hosts, which is why it is not the pinned value any more.
 */
const PRE_MIGRATION_LOCALE_HASH =
  "sha256:d873fca458cfe0517fac369a40cd03e5013856ef950aef42b97883c098542097";

/**
 * The digest the code-unit comparators produce. Unlike the value above this
 * one does not depend on the host ICU locale, so it is reproducible on any
 * machine and is the value hosts persist.
 */
const CLASSIFICATION_HASH =
  "sha256:c712ccf59b4c11675fa120af60b777049cfef01b109f7e0766b70eb340eda43f";

const LEGACY_SCHEMA = "dzupagent.flowCompiledClassificationEnvelope/v1";
const CODE_UNIT_SCHEMA = "dzupagent.flowCompiledClassificationEnvelope/v2";
const HOST_REQUIRED_CAPABILITIES = [
  ...CODE_UNIT_ORDER.requiredCapabilities,
  "flow.runtime.credential.resolve@1",
] as const;

function reorderBy<T>(
  entries: readonly T[],
  order: readonly string[],
  key: (entry: T) => string,
): T[] {
  return order.map((expected) => {
    const entry = entries.find((candidate) => key(candidate) === expected);
    if (entry === undefined) {
      throw new Error(`missing ordering fixture entry: ${expected}`);
    }
    return entry;
  });
}

function withRecomputedClassificationHash<T extends {
  readonly schema: string;
  readonly semanticHash: string;
  readonly classificationComplete: boolean;
  readonly unclassifiedReferences: readonly string[];
  readonly values: readonly unknown[];
  readonly ports: readonly unknown[];
  readonly primitives: readonly unknown[];
  readonly integrations: readonly unknown[];
}>(envelope: T): T & { readonly classificationHash: `sha256:${string}` } {
  return {
    ...envelope,
    classificationHash: hashFlowCompiledClassificationEnvelopePayload({
      schema: envelope.schema,
      semanticHash: envelope.semanticHash,
      classificationComplete: envelope.classificationComplete,
      unclassifiedReferences: envelope.unclassifiedReferences,
      values: envelope.values,
      ports: envelope.ports,
      primitives: envelope.primitives,
      integrations: envelope.integrations,
    }),
  };
}

/** A persisted envelope produced by the former locale-sensitive v1 writer. */
const buildPersistedLegacyEnvelope = () => {
  const envelope = buildEnvelope();
  return withRecomputedClassificationHash({
    ...envelope,
    schema: LEGACY_SCHEMA,
    unclassifiedReferences: [...LOCALE_ORDER.unclassifiedReferences],
    values: reorderBy(envelope.values, LOCALE_ORDER.values, (value) => value.reference),
    ports: reorderBy(envelope.ports, LOCALE_ORDER.ports, (port) => port.reference),
    primitives: reorderBy(
      envelope.primitives,
      LOCALE_ORDER.primitives,
      (primitive) => primitive.nodePath,
    ).map((primitive) => ({
      ...primitive,
      requiredCapabilities: [...LOCALE_ORDER.requiredCapabilities],
      outputs: reorderBy(
        primitive.outputs,
        LOCALE_ORDER.outputs,
        (output) => output.port,
      ),
    })),
    integrations: reorderBy(
      envelope.integrations,
      LOCALE_ORDER.integrations,
      (integration) => integration.nodePath,
    ),
  });
};

/** A complete v1 envelope with mixed-case legacy capability ordering. */
const buildLegacyHostEnvelope = () => {
  const envelope = createFlowCompiledClassificationEnvelope(
    ROOT,
    "compile-legacy-host",
    "semantic-legacy-host",
    {
      referenceBindings: {},
      referenceTypeBindings: {},
      referencePortBindings: {},
      referenceClassificationBindings: {},
      referencePortClassificationBindings: {},
    },
    new Map(),
    REGISTRY,
    BINDINGS,
  );
  return withRecomputedClassificationHash({
    ...envelope,
    schema: LEGACY_SCHEMA,
    primitives: envelope.primitives.map((primitive) => ({
      ...primitive,
      requiredCapabilities: [...LOCALE_ORDER.requiredCapabilities],
    })),
  });
};

/** Reorder the first primitive's credential input paths, leaving all else. */
const withCredentialInputPaths = (inputPaths: readonly string[]): unknown => {
  const envelope = buildEnvelope();
  return {
    ...envelope,
    primitives: envelope.primitives.map((primitive, index) =>
      index === 0
        ? {
            ...primitive,
            credential: { ...primitive.credential, inputPaths },
          }
        : primitive,
    ),
  };
};

const CREDENTIAL_PATH_ISSUE =
  "primitives[0].credential.inputPaths must be sorted and unique";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("classification envelope ordering corpus", () => {
  it("versions code-unit envelopes separately from persisted legacy v1", () => {
    expect(buildEnvelope().schema).toBe(CODE_UNIT_SCHEMA);
  });

  it("uses a fixture where locale order and code-unit order disagree", () => {
    // Guards against the corpus silently becoming vacuous: if these ever
    // coincide the ordering assertions below stop proving anything.
    for (const key of Object.keys(LOCALE_ORDER) as Array<
      keyof typeof LOCALE_ORDER
    >) {
      expect(
        LOCALE_ORDER[key],
        `${key} must discriminate between the two comparators`,
      ).not.toEqual(CODE_UNIT_ORDER[key]);
    }
    // Both orders must be permutations of one another, or the pins are
    // recording a membership change rather than an ordering change.
    for (const key of Object.keys(LOCALE_ORDER) as Array<
      keyof typeof LOCALE_ORDER
    >) {
      expect([...LOCALE_ORDER[key]].sort()).toEqual(
        [...CODE_UNIT_ORDER[key]].sort(),
      );
    }
  });

  it("orders every digest-feeding array by UTF-16 code unit", () => {
    const envelope = buildEnvelope();

    expect(envelope.unclassifiedReferences).toEqual(
      CODE_UNIT_ORDER.unclassifiedReferences,
    );
    expect(envelope.values.map((value) => value.reference)).toEqual(
      CODE_UNIT_ORDER.values,
    );
    expect(envelope.ports.map((port) => port.reference)).toEqual(
      CODE_UNIT_ORDER.ports,
    );
    expect(envelope.primitives.map((primitive) => primitive.nodePath)).toEqual(
      CODE_UNIT_ORDER.primitives,
    );
    expect(envelope.primitives[0]?.requiredCapabilities).toEqual(
      CODE_UNIT_ORDER.requiredCapabilities,
    );
    expect(
      envelope.primitives[0]?.outputs.map((output) => output.port),
    ).toEqual(CODE_UNIT_ORDER.outputs);
    expect(
      envelope.integrations.map((integration) => integration.nodePath),
    ).toEqual(CODE_UNIT_ORDER.integrations);
  });

  it("pins the host-independent digest and records the one it replaced", () => {
    expect(buildEnvelope().classificationHash).toBe(CLASSIFICATION_HASH);
    // The migration really moved persisted digests; this is not a no-op
    // refactor. A stored v1 hash remains admissible as a v1 identity, but it
    // must not be compared directly with a newly compiled v2 identity.
    expect(CLASSIFICATION_HASH).not.toBe(PRE_MIGRATION_LOCALE_HASH);
  });

  it("admits the envelope it just built", () => {
    // The builder sorts `requiredCapabilities` and the validator re-checks
    // that the persisted array is sorted. The two therefore have to share one
    // comparator: change either side alone and the compiler stops admitting
    // its own output. This invariant must survive the migration unchanged.
    expect(validateFlowCompiledClassificationEnvelope(buildEnvelope())).toEqual(
      { valid: true, issues: [] },
    );
  });

  it("admits a persisted locale-ordered v1 envelope with its original hash", () => {
    const envelope = buildPersistedLegacyEnvelope();

    expect(envelope.classificationHash).toBe(PRE_MIGRATION_LOCALE_HASH);
    expect(validateFlowCompiledClassificationEnvelope(envelope)).toEqual({
      valid: true,
      issues: [],
    });
  });

  it("directly admits mixed-case capabilities from a persisted v1 envelope", () => {
    const envelope = buildLegacyHostEnvelope();

    expect(
      admitFlowCompiledClassificationEnvelope({
        envelope,
        expectedSemanticHash: envelope.semanticHash,
        expectedClassificationHash: envelope.classificationHash,
        expectedCompileId: envelope.compileId,
        availableCapabilities: [...HOST_REQUIRED_CAPABILITIES],
      }),
    ).toEqual(
      expect.objectContaining({
        admitted: true,
        issues: [],
        requiredCapabilities: [...HOST_REQUIRED_CAPABILITIES],
        missingCapabilities: [],
      }),
    );
  });

  it("accepts code-unit-ordered credential paths and rejects locale ones", () => {
    // Admission of a *persisted* envelope must not depend on the admitting
    // host's collation. `["input.Token", "input.token"]` is sorted by code
    // unit and unsorted by locale; before the migration a host rejected it,
    // which is precisely how cross-machine admission failed.
    expect(
      validateFlowCompiledClassificationEnvelope(
        withCredentialInputPaths(["input.Token", "input.token"]),
      ).issues,
    ).not.toContain(CREDENTIAL_PATH_ISSUE);
    expect(
      validateFlowCompiledClassificationEnvelope(
        withCredentialInputPaths(["input.token", "input.Token"]),
      ).issues,
    ).toContain(CREDENTIAL_PATH_ISSUE);
  });
});
