import {
  BUILT_IN_PRIMITIVE_REGISTRY_V2,
  definePrimitiveV2,
  extendPrimitiveRegistryV2,
  type PrimitiveDefinitionV2,
} from "@dzupagent/flow-dsl";
import { describe, expect, it } from "vitest";

import { compareCodeUnits } from "../canonical-order.js";
import {
  qualifyV2InactiveLocalTarget,
  V2_INACTIVE_LOCAL_TARGET_CAPABILITIES,
} from "../v2-inactive-local-target.js";

/**
 * Ordering contract for `qualificationSha256`.
 *
 * `collectPrimitiveContractEvidence` sorts the primitive-contract evidence by
 * `${authoredPath}:${capability}`, and that ordered array is embedded in
 * `receiptCore`, which is digested into the receipt's `qualificationSha256`.
 * The digest is not decorative: `v2-inactive-local-target/host.ts` compares
 * `checkpoint.qualificationSha256 === context.qualificationSha256` to decide
 * whether a checkpoint may resume against the current qualification. A
 * host-dependent digest therefore refuses a legitimate resume whenever the
 * qualifying and resuming processes disagree on collation.
 *
 * That is exactly what `localeCompare` does — it collates through the host
 * ICU's default locale. `canonical-order.ts` carries the rule and the reason;
 * this suite is the `qualificationSha256` half of it, after the
 * classification-envelope half landed.
 *
 * The divergence needs no unusual authoring, only ELEVEN steps: authored paths
 * are structural, and `root.steps[10]` sorts before `root.steps[1]…` by code
 * unit (`'0'` < `']'`) and after it under ICU collation, which weights
 * punctuation below digits.
 *
 * The digest pinned below MOVED in this migration, deliberately and once:
 * `sha256:221e1b42…` (locale-ordered) -> `sha256:916e29c7…` (code-unit).
 * Receipts persisted before it must be re-qualified rather than compared.
 */

const STEP_COUNT = 11;

/** The authored paths this fixture produces, in the order the sort sees them. */
const AUTHORED_PATHS = Array.from(
  { length: STEP_COUNT },
  (_, index) => `root.steps[${index}]`,
);

function localeOrderDisagrees(values: readonly string[]): boolean {
  const byLocale = [...values].sort((left, right) => left.localeCompare(right));
  const byCodeUnit = [...values].sort(compareCodeUnits);
  return JSON.stringify(byLocale) !== JSON.stringify(byCodeUnit);
}

function multiPortAdapter(): PrimitiveDefinitionV2 {
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
          properties: { digest: { type: "string" } },
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

/** Eleven steps, each carrying a retry policy and a terminal catch. */
function elevenStepSource(): string {
  const steps = Array.from({ length: STEP_COUNT }, (_, index) =>
    [
      `  - id: run_${index}`,
      "    use: adapter.run@2",
      "    when:",
      "      ref: inputs.ready",
      "    with:",
      "      provider: codex",
      `      instructions: Draft ${index}.`,
      "    policy:",
      "      timeoutMs: 30000",
      "    retry:",
      "      match:",
      "        - ADAPTER_FAILED",
      "      maxAttempts: 2",
      "    catch:",
      "      - match:",
      "          - ADAPTER_CANCELLED",
      "        action: continue",
      "    save:",
      `      result: state.result_${index}`,
      `      receipt: state.receipt_${index}`,
    ].join("\n"),
  ).join("\n");
  return [
    "dsl: dzupflow/v2",
    "id: inactive-local-target-order",
    "version: 2.0.0",
    "inputs:",
    "  ready: boolean",
    "steps:",
    steps,
    "",
  ].join("\n");
}

async function qualify() {
  const primitive = multiPortAdapter();
  const registry = extendPrimitiveRegistryV2(BUILT_IN_PRIMITIVE_REGISTRY_V2, [
    primitive,
  ]);
  const result = await qualifyV2InactiveLocalTarget({
    source: elevenStepSource(),
    compilerOptions: {
      toolResolver: { resolve: () => null, listAvailable: () => [] },
      referencePolicy: "strict" as const,
      primitiveRegistry: registry,
      primitiveBindings: {
        "adapter.run": {
          ref: primitive.ref,
          semanticHash: primitive.compatibility.semanticHash,
        },
      },
    },
    hostCapabilities: V2_INACTIVE_LOCAL_TARGET_CAPABILITIES,
    conditionBindings: { inputs: { ready: true } },
  });
  if (!result.ok) {
    throw new Error(
      `expected a qualification receipt, got ${JSON.stringify(result).slice(0, 400)}`,
    );
  }
  return result.receipt;
}

describe("v2 qualification contract-evidence order", () => {
  it("reports its own vacuity if ICU collation ever matches code-unit order", () => {
    expect(localeOrderDisagrees(AUTHORED_PATHS)).toBe(true);
  });

  it("orders primitive contract evidence by code unit, not host collation", async () => {
    const receipt = await qualify();
    const keys = receipt.primitiveContracts.map(
      (entry) => `${entry.authoredPath}:${entry.capability}`,
    );
    // A sortedness assertion passes vacuously on an empty array, so pin the
    // count: 11 steps x 4 primitive capabilities each.
    expect(keys).toHaveLength(STEP_COUNT * 4);
    expect(keys).toEqual([...keys].sort(compareCodeUnits));
    // The migration, stated as an assertion: the emitted order is now the
    // host-independent one, which on this host is NOT the collated one.
    expect(keys).not.toEqual(
      [...keys].sort((left, right) => left.localeCompare(right)),
    );
  });

  it("pins the qualification digest", async () => {
    const receipt = await qualify();
    expect(receipt.qualificationSha256).toBe(
      "sha256:916e29c7bb46afe64a1f8c2c052aff037794b960b8042d6db88b185e569f94f8",
    );
  });
});
