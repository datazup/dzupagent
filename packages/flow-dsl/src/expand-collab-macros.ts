// Compatibility wrapper for callers that imported the pre-P2 collab macro
// helper directly. The real expansion path is registry-backed and lives under
// primitives/composite-expansion.ts.

import { expandRegisteredComposites } from "./primitives/composite-expansion.js";

export { CollabMacroError } from "./primitives/collab-review-loop.js";

export function expandCollabMacros(raw: unknown): unknown {
  return expandRegisteredComposites(raw);
}
