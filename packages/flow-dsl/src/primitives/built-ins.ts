import { expandCollabReviewLoop } from "./collab-review-loop.js";
import { expandCollabReviewLoopV2 } from "./collab-review-loop-v2.js";
import { BUILT_IN_PRIMITIVE_DEFINITIONS_V2 } from "./built-ins-v2.js";
import { toPrimitiveDefinitionV1 } from "./definition-v2.js";
import { createPrimitiveRegistry } from "./registry.js";
import type { PrimitiveDefinition } from "./types.js";

export const BUILT_IN_PRIMITIVES: readonly PrimitiveDefinition[] =
  Object.freeze(
    BUILT_IN_PRIMITIVE_DEFINITIONS_V2.map((definition) =>
      toPrimitiveDefinitionV1(definition, {
        "collab.review_loop@1": expandCollabReviewLoop,
        "collab.review_loop@2": expandCollabReviewLoopV2,
      }),
    ),
  );

export { BUILT_IN_PRIMITIVE_DEFINITIONS_V2 } from "./built-ins-v2.js";

export const DEFAULT_PRIMITIVE_REGISTRY =
  createPrimitiveRegistry(BUILT_IN_PRIMITIVES);
