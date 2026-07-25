import type { PrimitiveDefinitionV2 } from "../primitives/types.js";
import type { DslDiagnostic } from "../types.js";

export interface DslV2StepLineage {
  readonly authoredPath: string;
  readonly loweredPath: string;
  readonly use: string;
  readonly primitiveRef?: PrimitiveDefinitionV2["ref"];
  readonly primitiveSemanticHash?: `sha256:${string}`;
}

export interface DslV2FrontendMetadata {
  readonly schema: "dzupagent.dslV2Frontend/v1";
  readonly authoredDsl: "dzupflow/v2";
  readonly authoredVersion: "2.0.0";
  readonly canonicalDsl: "dzupflow/v1";
  readonly canonicalVersion: 1;
  readonly stepLineage: readonly DslV2StepLineage[];
  readonly primitiveBindings: readonly {
    readonly ref: PrimitiveDefinitionV2["ref"];
    readonly semanticHash: `sha256:${string}`;
  }[];
}

export type LowerDslV2Result =
  | {
      readonly ok: true;
      readonly raw: Readonly<Record<string, unknown>>;
      readonly metadata: DslV2FrontendMetadata;
      readonly diagnostics: readonly [];
    }
  | {
      readonly ok: false;
      readonly raw: null;
      readonly metadata: null;
      readonly diagnostics: readonly DslDiagnostic[];
    };
