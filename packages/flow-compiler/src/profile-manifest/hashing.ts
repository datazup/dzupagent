import { createHash } from "node:crypto";

import { canonicalize } from "./internal.js";
import { type FlowProfileManifest } from "./types.js";

export function hashFlowProfileManifest(manifest: FlowProfileManifest): string {
  const normalized = {
    ...manifest,
    nodeKinds: [...manifest.nodeKinds].sort(),
    capabilities: [...manifest.capabilities].sort(),
    dependencies: [...manifest.dependencies].sort(),
  };
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalize(normalized)))
    .digest("hex")}`;
}
