import type { EffectClass, NodeIdempotencyMode } from "@dzupagent/flow-ast";

export type PrimitiveCategory =
  | "leaf"
  | "composite"
  | "structural"
  | "validator"
  | "transformer"
  | "governance";

export interface PrimitivePolicyDefaults {
  timeoutMs?: number;
  budgetCents?: number;
  requireApproval?: boolean;
  rawProviderOutput?: false;
}

export interface PrimitiveExpansionContext {
  kind: string;
  version: string;
}

export type PrimitiveExpansionHandler = (
  raw: unknown,
  context: PrimitiveExpansionContext
) => Array<Record<string, unknown>>;

export interface PrimitiveDefinition {
  kind: string;
  version: string;
  namespace: string;
  category: PrimitiveCategory;
  description?: string;
  schema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  effectClass?: EffectClass;
  idempotency?: NodeIdempotencyMode;
  defaultPolicy?: PrimitivePolicyDefaults;
  expandsTo?: string[];
  expand?: PrimitiveExpansionHandler;
  executesWith?: string;
  supportsInlineBody?: boolean;
  supportsReferenceCall?: boolean;
}

export interface PrimitiveRegistry {
  get(kind: string, version?: string): PrimitiveDefinition | undefined;
  list(namespace?: string): PrimitiveDefinition[];
  has(kind: string, version?: string): boolean;
}
