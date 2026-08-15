import { canonicalInputDigest } from "../idempotency.js";

import type { PipelineSha256Digest } from "./types.js";

export function digestPipelineInteractionValue(
  value: unknown,
): PipelineSha256Digest {
  return `sha256:${canonicalInputDigest(value)}`;
}
