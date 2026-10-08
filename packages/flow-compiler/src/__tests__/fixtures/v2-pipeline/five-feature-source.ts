import {
  BUILT_IN_PRIMITIVE_REGISTRY_V2,
  definePrimitiveV2,
  type PrimitiveDefinitionV2,
} from "@dzupagent/flow-dsl";

/**
 * Verbatim copies of `multiPortAdapter()` and `source()` from
 * `../../v2-inactive-local-host.test.ts`, which does not export them. Keep the
 * two in sync: the S5 parity tests compare `PipelineRuntime` against the local
 * host on exactly this document.
 */
export function multiPortAdapter(): PrimitiveDefinitionV2 {
  const base = BUILT_IN_PRIMITIVE_REGISTRY_V2.resolve("adapter.run", "1");
  if (base === undefined) throw new Error("missing adapter.run@1");
  const {
    compatibility: { semanticHash: _semanticHash, ...compatibility },
    ...contract
  } = base;
  return definePrimitiveV2({
    ...contract,
    ref: "primitive://adapter.run@2",
    version: "2",
    owner: "test.external",
    outputPorts: {
      result: base.outputPorts.result!,
      receipt: {
        schema: {
          type: "object",
          properties: { digest: { type: "string", minLength: 1 } },
          required: ["digest"],
          additionalProperties: false,
        },
        cardinality: "one",
        classification: "internal",
        persistence: "state",
      },
    },
    compatibility: {
      ...compatibility,
      supersedes: [base.ref],
      deprecatedAliases: [],
    },
  });
}

export function fiveFeatureSource(): string {
  return `
dsl: dzupflow/v2
id: inactive-local-host
version: 2.0.0
inputs:
  ready: boolean
steps:
  - id: draft
    use: adapter.run@2
    when:
      ref: inputs.ready
    with:
      provider: codex
      instructions: Draft.
    policy:
      timeoutMs: 30000
      budgetCents: 100
    retry:
      match:
        - ADAPTER_FAILED
      maxAttempts: 2
      backoff:
        strategy: fixed
        initialMs: 5
        maxMs: 5
        jitter: none
    catch:
      - match:
          - ADAPTER_CANCELLED
        action: continue
    save:
      result: state.draft
      receipt: state.draftReceipt
  - id: review
    use: adapter.run@2
    when:
      ref: inputs.ready
    with:
      provider: codex
      instructions: Review.
    policy:
      timeoutMs: 30000
      budgetCents: 100
    retry:
      match:
        - ADAPTER_FAILED
      maxAttempts: 2
      backoff:
        strategy: fixed
        initialMs: 5
        maxMs: 5
        jitter: none
    catch:
      - match:
          - ADAPTER_CANCELLED
        action: complete
    save:
      result: state.review
      receipt: state.reviewReceipt
`;
}
