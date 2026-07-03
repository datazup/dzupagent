import type {
  FlowFragmentCatalogEntry,
  FlowFragmentV1,
} from "@dzupagent/flow-ast";

export interface FragmentRegistry {
  get(id: string, version?: number): FlowFragmentCatalogEntry | undefined;
  list(namespace?: string): FlowFragmentCatalogEntry[];
  has(id: string, version?: number): boolean;
}

export interface FragmentInvocationExpansion {
  steps: Array<Record<string, unknown>>;
  exports: Record<string, string>;
  sourceMap: Array<{ parentPath: string; expandedPath: string }>;
  metadata: FragmentExpansionMetadata;
  fragmentExpansions: FragmentExpansionMetadata[];
}

export interface FragmentExpansionMetadata {
  id: string;
  version: number;
  namespace: string;
  catalogRef: string;
  instanceId: string;
  invocationPath: string;
  expandedPaths: string[];
  exports: Record<string, string>;
}

export interface FragmentInvocationInput {
  registry: FragmentRegistry;
  kind: string;
  raw: unknown;
  path: string;
}

export type FragmentDefinitionInput = FlowFragmentCatalogEntry | FlowFragmentV1;
