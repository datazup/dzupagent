import type { PrimitiveDefinitionV2 } from "@dzupagent/flow-dsl";

export interface FlowPrimitiveBinding {
  readonly ref: PrimitiveDefinitionV2["ref"];
  readonly semanticHash: PrimitiveDefinitionV2["compatibility"]["semanticHash"];
}

export type FlowPrimitiveBindings = Readonly<
  Record<string, FlowPrimitiveBinding | undefined>
>;
