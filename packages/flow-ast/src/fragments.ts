import type { FlowInputSpec, FlowNodeMetadata, SequenceNode } from "./types.js";

export type FlowFragmentDsl = "dzupflow/v1";

export interface FlowFragmentExportSpec {
  expression: string;
  description?: string;
  availability?: "success" | "always";
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
  root: SequenceNode;
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
