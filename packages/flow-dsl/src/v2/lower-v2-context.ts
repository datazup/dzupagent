import type { PrimitiveDefinitionV2, PrimitiveRegistryV2 } from "../primitives/types.js";
import type { DslDiagnostic } from "../types.js";
import type {
  DslV2PolicyNarrowingBinding,
  DslV2RetryPolicyBinding,
  DslV2TerminalCatchBinding,
  DslV2MultiPortSaveBinding,
  DslV2StepLineage,
} from "./types.js";
import type { PrimitivePolicyLimits } from "./policy-narrowing.js";

export interface V2LoweringContext {
  readonly diagnostics: DslDiagnostic[];
  readonly registry: PrimitiveRegistryV2;
  readonly lineage: DslV2StepLineage[];
  readonly bindings: Map<
    PrimitiveDefinitionV2["ref"],
    `sha256:${string}`
  >;
  readonly namespaceVersions: Map<string, string>;
  readonly authoredStepIds: ReadonlySet<string>;
  readonly generatedGuardIds: Set<string>;
  readonly inheritedPolicy: PrimitivePolicyLimits;
  readonly policyNarrowings: DslV2PolicyNarrowingBinding[];
  readonly retryPolicies: DslV2RetryPolicyBinding[];
  readonly terminalCatches: DslV2TerminalCatchBinding[];
  readonly multiPortSaves: DslV2MultiPortSaveBinding[];
}
