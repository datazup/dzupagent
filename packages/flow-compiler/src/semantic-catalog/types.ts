import type { FlowNodeKind } from "@dzupagent/flow-ast";
import type { ExecutionLeafKind } from "@dzupagent/runtime-contracts/orchestration";
import type { PrimitiveDefinitionV2 } from "@dzupagent/flow-dsl";

import type {
  FlowCapabilityOwner,
  FlowNodeLoweringMode,
  FlowNodeSupportStatus,
  RecommendedFlowProfile,
} from "../capability-manifest/types.js";
import type { CompilationTarget } from "../types.js";

export type FlowSemanticNodeClass =
  | "kernel"
  | "primitive"
  | "execution-leaf"
  | "profile-action"
  | "product-action";

export interface FlowSemanticNodeEntry {
  readonly identity: `node:${FlowNodeKind}`;
  readonly kind: FlowNodeKind;
  readonly classification: FlowSemanticNodeClass;
  readonly owner: FlowCapabilityOwner;
  readonly profile: RecommendedFlowProfile;
  readonly status: FlowNodeSupportStatus;
  readonly lowering: FlowNodeLoweringMode;
  readonly currentRoute: CompilationTarget;
  readonly runtimeCapabilities: readonly string[];
  readonly primitiveRefs: readonly string[];
  readonly executionLeaf?: ExecutionLeafKind;
  readonly deprecated: boolean;
  readonly notes?: string;
}

export type PrimitiveSemanticExecutionMode =
  | "macro"
  | "execution-leaf"
  | "host-action";

export interface PrimitiveExpansionTarget {
  readonly authored: string;
  readonly resolvedNodeKind?: FlowNodeKind;
  readonly primitiveRefs: readonly string[];
}

export interface FlowSemanticPrimitiveEntry {
  readonly identity: `primitive:${string}@${string}`;
  readonly kind: string;
  readonly version: string;
  readonly namespace: string;
  readonly category: string;
  readonly description?: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly effectClass?: string;
  readonly idempotency?: string;
  readonly contract: PrimitiveDefinitionV2;
  readonly execution: {
    readonly mode: PrimitiveSemanticExecutionMode;
    readonly target?: string;
  };
  readonly expandsTo: readonly PrimitiveExpansionTarget[];
}

export interface FlowSemanticFragmentEntry {
  readonly identity: `fragment:${string}@${number}`;
  readonly id: string;
  readonly version: number;
  readonly namespace: string;
  readonly catalogRef: string;
  readonly description?: string;
  readonly params: readonly string[];
  readonly exports: readonly string[];
  readonly nodeKinds: readonly FlowNodeKind[];
  readonly fragmentRefs: readonly string[];
}

export interface FlowSemanticExecutionLeafEntry {
  readonly identity: `execution-leaf:${ExecutionLeafKind}`;
  readonly kind: ExecutionLeafKind;
  readonly nodeKind: FlowNodeKind;
  readonly primitiveRefs: readonly string[];
  readonly runtimeCapability: string;
}

export type FlowSemanticCatalogDiagnosticCode =
  | "DUPLICATE_SEMANTIC_IDENTITY"
  | "UNRESOLVED_PRIMITIVE_EXPANSION"
  | "UNRESOLVED_PRIMITIVE_EXECUTOR"
  | "EXECUTION_LEAF_WITHOUT_NODE";

export interface FlowSemanticCatalogDiagnostic {
  readonly code: FlowSemanticCatalogDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface FlowSemanticCatalog {
  readonly schema: "dzupagent.flowSemanticCatalog/v1";
  readonly generatedFrom: readonly [
    "FLOW_NODE_KIND_REGISTRY",
    "FLOW_NODE_CAPABILITY_REGISTRY",
    "BUILT_IN_PRIMITIVE_DEFINITIONS_V2",
    "BUILT_IN_SDL_FRAGMENT_DEFINITIONS",
    "EXECUTION_LEAF_KINDS",
  ];
  readonly status: "valid" | "invalid";
  readonly summary: {
    readonly nodes: number;
    readonly primitives: number;
    readonly fragments: number;
    readonly executionLeaves: number;
  };
  readonly nodes: readonly FlowSemanticNodeEntry[];
  readonly primitives: readonly FlowSemanticPrimitiveEntry[];
  readonly fragments: readonly FlowSemanticFragmentEntry[];
  readonly executionLeaves: readonly FlowSemanticExecutionLeafEntry[];
  readonly diagnostics: readonly FlowSemanticCatalogDiagnostic[];
}
