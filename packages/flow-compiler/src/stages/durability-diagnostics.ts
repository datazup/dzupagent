/**
 * P0 — DSL Durability Contract: compiler diagnostics.
 *
 * Document-level, additive, advisory diagnostics that surface unsafe-by-
 * construction durability declarations. These do NOT change runtime behavior
 * — they are appended to the compile result's warnings and reflected in
 * evidence. See
 * workspace-docs/repos/dzupagent/docs/architecture/plans/P0-dsl-durability-contract.md
 *
 * Implemented here (operate purely on the document, no node-field traversal):
 *  - D4 — an adapter node's `idempotency` enum conflicts with a richer
 *         `meta.idempotency` shape on the same node.
 *  - D5 — `durability.mode: durable` while no checkpoint `storeRef` is
 *         configured (OQ-1: compile-warn, runtime-admission-fail).
 *
 * D1 (mutating effect without idempotency), D2 (return-prior without output
 * schema) and D3 (requireResumePoint unmet) require node-level EffectClass /
 * output-schema / resume traversal and land with the node-field wiring
 * follow-up; they are intentionally not implemented in this pass.
 */
import type { CompilationWarning } from "../types.js";

const ADAPTER_NODE_KEYS = [
  "adapter.run",
  "adapter.race",
  "adapter.parallel",
  "adapter.supervisor",
] as const;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Compute document-level durability diagnostics for a parsed flow document.
 * Returns Stage-4 warnings (never errors — advisory only in P0).
 */
export function computeDurabilityDiagnostics(
  document: unknown,
): CompilationWarning[] {
  if (!isObject(document)) return [];
  const warnings: CompilationWarning[] = [];

  // ── D5: durable mode without a checkpoint store ───────────────────────────
  const durability = document["durability"];
  if (isObject(durability) && durability["mode"] === "durable") {
    const checkpoint = durability["checkpoint"];
    const storeRef = isObject(checkpoint) ? checkpoint["storeRef"] : undefined;
    if (typeof storeRef !== "string" || storeRef.length === 0) {
      warnings.push({
        stage: 4,
        code: "DURABILITY_NO_STORE",
        message:
          "durability.mode is 'durable' but no checkpoint.storeRef is configured; " +
          "compilation succeeds, but the runtime will fail admission unless a durable store is provided (OQ-1).",
        nodePath: "root.durability",
        category: "policy",
      });
    }
  }

  // ── D4: adapter idempotency enum vs richer meta.idempotency conflict ──────
  walkSteps(document["root"], "root", warnings);

  return warnings;
}

function walkSteps(
  node: unknown,
  path: string,
  warnings: CompilationWarning[],
): void {
  if (!isObject(node)) return;

  // A node may be an envelope like { "adapter.run": {...} } (authoring form) or
  // a typed node { type: "adapter.run", ... } (AST form). Handle both.
  for (const key of ADAPTER_NODE_KEYS) {
    const inner = node[key];
    if (isObject(inner))
      checkAdapterIdempotency(inner, `${path}.${key}`, warnings);
  }
  if (
    typeof node["type"] === "string" &&
    (ADAPTER_NODE_KEYS as readonly string[]).includes(node["type"])
  ) {
    checkAdapterIdempotency(node, path, warnings);
  }

  // Recurse into common child-bearing fields.
  for (const childKey of [
    "nodes",
    "steps",
    "body",
    "then",
    "else",
    "branches",
  ]) {
    const child = node[childKey];
    if (Array.isArray(child)) {
      child.forEach((c, i) =>
        walkSteps(c, `${path}.${childKey}[${i}]`, warnings),
      );
    } else if (isObject(child)) {
      walkSteps(child, `${path}.${childKey}`, warnings);
    }
  }
}

function checkAdapterIdempotency(
  node: Record<string, unknown>,
  path: string,
  warnings: CompilationWarning[],
): void {
  const enumMode = node["idempotency"];
  const meta = node["meta"];
  const metaIdem = isObject(meta) ? meta["idempotency"] : undefined;
  if (
    typeof enumMode === "string" &&
    metaIdem !== undefined &&
    isObject(metaIdem) &&
    typeof metaIdem["mode"] === "string" &&
    metaIdem["mode"] !== enumMode
  ) {
    warnings.push({
      stage: 4,
      code: "IDEMPOTENCY_MODE_CONFLICT",
      message:
        `node declares idempotency '${enumMode}' but meta.idempotency.mode is ` +
        `'${String(metaIdem["mode"])}'; the node-level enum takes precedence.`,
      nodePath: path,
      category: "mutation",
    });
  }
}
