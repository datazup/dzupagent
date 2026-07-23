import type { FlowInputSpec, FlowNode, FlowNodeMetadata } from "./types.js";

export type FlowFragmentDsl = "dzupflow/v1";

export interface FlowFragmentExportSpec {
  expression: string;
  description?: string;
  availability?: "success" | "always";
}

/**
 * A fragment body is authored before normalization and may therefore contain
 * either canonical `{ type }` nodes, single-key DSL wrappers, nested fragment
 * invocations, and type-preserving `FlowReferenceValue` objects.
 */
export type FlowFragmentNode = FlowNode | Record<string, unknown>;

export interface FlowFragmentSequence {
  type: "sequence";
  id?: string;
  name?: string;
  description?: string;
  meta?: FlowNodeMetadata;
  nodes: FlowFragmentNode[];
}

export interface FlowFragmentV1 {
  dsl: FlowFragmentDsl;
  documentType: "fragment";
  id: string;
  version: number;
  title?: string;
  description?: string;
  params?: Record<string, FlowInputSpec>;
  exports?: Record<string, FlowFragmentExportSpec | string>;
  tags?: string[];
  meta?: FlowNodeMetadata;
  root: FlowFragmentSequence;
}

export interface FlowFragmentCatalogEntry {
  id: string;
  version: number;
  namespace: string;
  fragment: FlowFragmentV1;
}

export interface FlowFragmentCatalog {
  namespace: string;
  majorVersion: number;
  fragments: FlowFragmentCatalogEntry[];
}
