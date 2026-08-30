/**
 * Digest of the persisted pipeline-definition artifact — typed against the
 * artifact contract this package owns (ARCH27-T-14), sharing the canonical
 * digest form pipeline interactions bind to so persisted digests are
 * byte-identical to the previous untyped implementation.
 */

import { digestPipelineInteractionValue } from "../pipeline-interaction/digest.js";
import type { PipelineSha256Digest } from "../pipeline-interaction/types.js";

import type { PipelineDefinition } from "./definition.js";

export function digestPipelineDefinition(
  definition: PipelineDefinition,
): PipelineSha256Digest {
  return digestPipelineInteractionValue(definition);
}
