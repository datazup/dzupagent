import type { FlowDocumentV1 } from "@dzupagent/flow-ast";

import type { PrimitiveRegistryV2 } from "../primitives/types.js";
import type { DslDiagnostic } from "../types.js";
import type { DslV2FrontendMetadata } from "../v2/types.js";
import type { DslV2ExternalImportCatalogs } from "../v2/types.js";
import type { PrimitivePolicyLimits } from "../v2/policy-narrowing.js";

export const DSL_V2_AUTHORING_ID = "dzupagent.dsl-v2-authoring@1" as const;

export interface DslV2AuthoringOptions {
  readonly primitiveRegistryV2?: PrimitiveRegistryV2;
  readonly inheritedPolicy?: PrimitivePolicyLimits;
  readonly importCatalogs?: DslV2ExternalImportCatalogs;
}

export interface DslV2AuthoringSuccess {
  readonly ok: true;
  readonly schema: "dzupagent.dslV2Authoring/v1";
  readonly authoringId: typeof DSL_V2_AUTHORING_ID;
  readonly document: Readonly<Record<string, unknown>>;
  readonly canonicalSource: string;
  readonly canonicalSourceSha256: `sha256:${string}`;
  readonly semanticSha256: `sha256:${string}`;
  readonly resolvedImportLockSha256: `sha256:${string}`;
  readonly canonicalDocument: FlowDocumentV1;
  readonly frontend: DslV2FrontendMetadata;
  readonly diagnostics: readonly [];
  readonly comments: "not-preserved";
  readonly authority: DslV2AuthoringAuthority;
}

export interface DslV2AuthoringFailure {
  readonly ok: false;
  readonly schema: "dzupagent.dslV2Authoring/v1";
  readonly authoringId: typeof DSL_V2_AUTHORING_ID;
  readonly document: Readonly<Record<string, unknown>> | null;
  readonly diagnostics: readonly DslDiagnostic[];
  readonly comments: "not-preserved";
  readonly authority: DslV2AuthoringAuthority;
}

export type DslV2AuthoringResult =
  | DslV2AuthoringSuccess
  | DslV2AuthoringFailure;

export interface DslV2AuthoringAuthority {
  readonly sourceFormatting: true;
  readonly reportOnlyMigration: true;
  readonly documentMutation: false;
  readonly runtimeExecution: false;
  readonly providerDispatch: false;
  readonly deployment: false;
  readonly activation: false;
}

export type DslV1ToV2MigrationClassification =
  | "equivalent"
  | "lossy"
  | "unsupported"
  | "invalid";

export interface DslV1ToV2MigrationItem {
  readonly path: string;
  readonly nodeType: string;
  readonly classification: Exclude<DslV1ToV2MigrationClassification, "invalid">;
  readonly reason: string;
}

export interface DslV1ToV2MigrationReport {
  readonly schema: "dzupagent.dslV1ToV2MigrationReport/v1";
  readonly authoringId: typeof DSL_V2_AUTHORING_ID;
  readonly sourceSha256: `sha256:${string}`;
  readonly classification: DslV1ToV2MigrationClassification;
  readonly items: readonly DslV1ToV2MigrationItem[];
  readonly diagnostics: readonly DslDiagnostic[];
  readonly primitiveImports?: readonly {
    readonly ref: `primitive://${string}@${string}`;
    readonly semanticHash: `sha256:${string}`;
  }[];
  readonly candidateSource?: string;
  readonly candidateSourceSha256?: `sha256:${string}`;
  readonly sourceSemanticSha256?: `sha256:${string}`;
  readonly candidateSemanticSha256?: `sha256:${string}`;
  readonly canonicalEquivalent: boolean;
  readonly reportSha256: `sha256:${string}`;
  readonly authority: DslV2AuthoringAuthority;
}
