export type FlowSchemaRef = `schema://${string}@${string}`;
export type FlowSchemaTrust = "reviewed" | "local" | "untrusted";

export interface FlowSchemaDefinition {
  readonly schema: "dzupagent.schemaDefinition/v1";
  readonly ref: FlowSchemaRef;
  readonly owner: string;
  readonly trust: FlowSchemaTrust;
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  readonly compatibility: {
    readonly semanticHash: `sha256:${string}`;
    readonly supersedes: readonly FlowSchemaRef[];
  };
}

export type FlowSchemaDefinitionInput = Omit<
  FlowSchemaDefinition,
  "compatibility"
> & {
  readonly compatibility: Omit<
    FlowSchemaDefinition["compatibility"],
    "semanticHash"
  >;
};

export interface FlowSchemaBinding {
  readonly ref: FlowSchemaRef;
  readonly semanticHash: `sha256:${string}`;
}

export interface FlowSchemaRegistry {
  readonly schema: "dzupagent.schemaRegistry/v1";
  readonly registryHash: `sha256:${string}`;
  get(ref: FlowSchemaRef): FlowSchemaDefinition | undefined;
  has(ref: FlowSchemaRef): boolean;
  list(namespace?: string): readonly FlowSchemaDefinition[];
}

export interface FlowSchemaRegistryOptions {
  readonly acceptedTrust?: readonly FlowSchemaTrust[];
}

export interface ResolvedFlowSchema {
  readonly schema: "dzupagent.resolvedSchema/v1";
  readonly root: FlowSchemaBinding;
  readonly registryHash: `sha256:${string}`;
  readonly bindings: readonly FlowSchemaBinding[];
  readonly jsonSchema: Readonly<Record<string, unknown>>;
}
