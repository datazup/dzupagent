/**
 * @dzupagent/flow-compiler — canonical artifact normalization (F-R3).
 *
 * Defines the ONE canonical form of a compiled artifact: the artifact with the
 * per-compile run-variant id (`compileId`) stripped, recursively, wherever it
 * appears (`CompileSuccess.compileId` is duplicated into
 * `artifact.classificationEnvelope.compileId` and into evidence correlation).
 * F-R5 asserts byte-identity over THIS form, and
 * `FlowCompileEvidence.canonicalArtifact.hash` is computed over it.
 *
 * The normalization is deliberately narrow. Stripping anything beyond the
 * run-variant id would let two genuinely divergent frontends normalize into
 * equality — the vacuous-parity failure mode. Every other cross-frontend or
 * cross-compile difference is a REAL inequality that parity and byte-identity
 * checks must surface, never normalize away. Widening this strip is a schema
 * change: bump `FLOW_CANONICAL_ARTIFACT_SCHEMA`.
 */

/** Versioned id of the normalization `canonicalArtifact.hash` is keyed by. */
export const FLOW_CANONICAL_ARTIFACT_SCHEMA =
  "dzupagent.flowCanonicalArtifact/v1";

export type FlowCanonicalArtifactSchema = typeof FLOW_CANONICAL_ARTIFACT_SCHEMA;

/**
 * Return the artifact's canonical form: a structural copy with every
 * `compileId` key removed, and nothing else changed. Non-object values and
 * cyclic re-visits are returned as-is; arrays keep their order.
 */
export function canonicalizeArtifact(
  artifact: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (artifact === null || typeof artifact !== "object") return artifact;
  if (seen.has(artifact)) return artifact;
  seen.add(artifact);

  if (Array.isArray(artifact)) {
    return artifact.map((item) => canonicalizeArtifact(item, seen));
  }

  const record = artifact as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (key === "compileId") continue;
    out[key] = canonicalizeArtifact(record[key], seen);
  }
  return out;
}
