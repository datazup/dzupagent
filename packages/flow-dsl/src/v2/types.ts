import type { PrimitiveDefinitionV2 } from "../primitives/types.js";
import type { DslDiagnostic } from "../diagnostic-types.js";
import type { PrimitivePolicyNarrowing } from "./policy-narrowing.js";
import type { PrimitiveRetryPolicy } from "./retry-policy.js";
import type { PrimitiveTerminalCatchContract } from "./terminal-catch.js";
import type { PrimitiveMultiPortSaveContract } from "./multi-port-save.js";
import type { DslV2ImportLockChainEntry } from "./import-lock-chain.js";

export interface DslV2StepLineage {
  readonly authoredPath: string;
  readonly loweredPath: string;
  readonly use: string;
  readonly guardId?: string;
  readonly guardLoweredPath?: string;
  readonly primitiveRef?: PrimitiveDefinitionV2["ref"];
  readonly primitiveSemanticHash?: `sha256:${string}`;
}

export interface DslV2FrontendMetadata {
  readonly schema: "dzupagent.dslV2Frontend/v1";
  readonly authoredDsl: "dzupflow/v2";
  readonly authoredVersion: "2.0.0";
  readonly canonicalDsl: "dzupflow/v1";
  readonly canonicalVersion: 1;
  readonly primitiveImportMode: "derived" | "explicit";
  readonly primitiveImports: readonly DslV2PrimitiveImport[];
  readonly resolvedImportLock: DslV2ResolvedImportLock;
  /**
   * Revision-chain lineage for the lock above (ADR-0001 C2). Roots at
   * `revision: 0` unless the caller supplies a prior entry, so lineage is
   * always produced — the lock records *what* was imported, this records
   * *what it replaced*.
   */
  readonly importLockChainEntry: DslV2ImportLockChainEntry;
  readonly stepLineage: readonly DslV2StepLineage[];
  readonly primitiveBindings: readonly {
    readonly ref: PrimitiveDefinitionV2["ref"];
    readonly semanticHash: `sha256:${string}`;
  }[];
  readonly policyNarrowings: readonly DslV2PolicyNarrowingBinding[];
  readonly retryPolicies: readonly DslV2RetryPolicyBinding[];
  readonly terminalCatches: readonly DslV2TerminalCatchBinding[];
  readonly multiPortSaves: readonly DslV2MultiPortSaveBinding[];
}

export interface DslV2PrimitiveImport {
  readonly ref: PrimitiveDefinitionV2["ref"];
  readonly semanticHash: `sha256:${string}`;
}

export const DSL_V2_EXTERNAL_IMPORT_CATALOGS = [
  "profiles",
  "schemas",
  "fragments",
  "connectors",
  "roles",
  "flows",
] as const;

export type DslV2ExternalImportCatalog =
  (typeof DSL_V2_EXTERNAL_IMPORT_CATALOGS)[number];

export interface DslV2ContentAddressedImport {
  readonly ref: string;
  readonly semanticHash: `sha256:${string}`;
}

export type DslV2ExternalImportCatalogs = Readonly<
  Partial<
    Record<DslV2ExternalImportCatalog, readonly DslV2ContentAddressedImport[]>
  >
>;

export interface DslV2ResolvedImportLock {
  readonly schema: "dzupagent.dslV2ResolvedImportLock/v1";
  readonly catalogs: Readonly<
    Record<
      "primitives" | DslV2ExternalImportCatalog,
      readonly DslV2ContentAddressedImport[]
    >
  >;
  readonly lockSha256: `sha256:${string}`;
}

export interface DslV2PolicyNarrowingBinding {
  readonly authoredPath: string;
  readonly primitiveRef: PrimitiveDefinitionV2["ref"];
  readonly primitiveSemanticHash: `sha256:${string}`;
  readonly narrowing: PrimitivePolicyNarrowing;
}

export interface DslV2RetryPolicyBinding {
  readonly authoredPath: string;
  readonly primitiveRef: PrimitiveDefinitionV2["ref"];
  readonly primitiveSemanticHash: `sha256:${string}`;
  readonly retry: PrimitiveRetryPolicy;
}

export interface DslV2TerminalCatchBinding {
  readonly authoredPath: string;
  readonly primitiveRef: PrimitiveDefinitionV2["ref"];
  readonly primitiveSemanticHash: `sha256:${string}`;
  readonly catch: PrimitiveTerminalCatchContract;
}

export interface DslV2MultiPortSaveBinding {
  readonly authoredPath: string;
  readonly primitiveRef: PrimitiveDefinitionV2["ref"];
  readonly primitiveSemanticHash: `sha256:${string}`;
  readonly save: PrimitiveMultiPortSaveContract;
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
