/**
 * Default PII detector for the {@link MemoryService} write path.
 *
 * Backed by the shared `@dzupagent/security` scanner (the same one
 * `@dzupagent/core`'s `detectPII` wraps), so memory redacts by default
 * without depending on core. Matches are replaced with `[REDACTED-<TAG>]`.
 */
import { PiiDetector } from "@dzupagent/security";
import type { MemoryPIIResult } from "./memory-service-types.js";

const detector = new PiiDetector();

export function defaultMemoryPIIDetector(text: string): MemoryPIIResult {
  const scan = detector.scanDetailed(text);
  return { hasPII: scan.hasPii, redacted: scan.redacted };
}
