/**
 * P0 — DSL Durability Contract: compiler diagnostics.
 *
 * Document-level, additive, advisory diagnostics that surface unsafe-by-
 * construction durability declarations. These do NOT change runtime behavior
 * — they are appended to the compile result's warnings and reflected in
 * evidence. See
 * workspace-docs/repos/dzupagent/docs/architecture/plans/P0-dsl-durability-contract.md
 *
 * Implemented here:
 *  - D1 — a node with a mutating `effectClass` (file_write / code_change /
 *         network_write / db_write / queue_publish) and no `idempotency`
 *         declaration and no `allowDuplicateEffects: true`.
 *  - D2 — a node declaring `idempotency: 'idempotent'` (return-prior-result
 *         semantics) without an output schema (`outputSchema` / `resultSchema`).
 *  - D4 — an adapter node's `idempotency` enum conflicts with a richer
 *         `meta.idempotency` shape on the same node.
 *  - D5 — `durability.mode: durable` while no checkpoint `storeRef` is
 *         configured (OQ-1: compile-warn, runtime-admission-fail).
 *
 * D3 (requireResumePoint unmet) requires resume-point reachability graph
 * analysis and lands as its own focused change; not implemented here.
 */
import type { CompilationWarning } from "../types.js";

const ADAPTER_NODE_KEYS = [
  "adapter.run",
  "adapter.race",
  "adapter.parallel",
  "adapter.supervisor",
] as const;

/** Mirrors `MUTATING_EFFECT_CLASSES` in @dzupagent/flow-ast (kept local to
 *  avoid a value import into the compiler's diagnostics pass). */
const MUTATING_EFFECT_CLASSES = new Set([
  "file_write",
  "code_change",
  "network_write",
  "db_write",
  "queue_publish",
]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** True when the node declares any output contract (D2 prerequisite). */
function hasOutputSchema(node: Record<string, unknown>): boolean {
  if (node["outputSchema"] !== undefined) return true;
  if (node["resultSchema"] !== undefined) return true;
  const output = node["output"];
  if (
    isObject(output) &&
    (output["schema"] !== undefined || output["schemaRef"] !== undefined)
  ) {
    return true;
  }
  return false;
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

  // D1/D2 apply to any node carrying the FlowNodeBase effectClass/idempotency
  // fields — check this node directly.
  checkNodeEffectIdempotency(node, path, warnings);

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

function checkNodeEffectIdempotency(
  node: Record<string, unknown>,
  path: string,
  warnings: CompilationWarning[],
): void {
  const effectClass = node["effectClass"];
  const idempotency = node["idempotency"];
  const allowDuplicate = node["allowDuplicateEffects"] === true;

  // ── D1: mutating effect without an idempotency declaration ────────────────
  if (
    typeof effectClass === "string" &&
    MUTATING_EFFECT_CLASSES.has(effectClass) &&
    idempotency === undefined &&
    !allowDuplicate
  ) {
    warnings.push({
      stage: 4,
      code: "MUTATING_EFFECT_NO_IDEMPOTENCY",
      message:
        `node has mutating effectClass '${effectClass}' but no idempotency ` +
        "declaration; declare `idempotency` or set `allowDuplicateEffects: true` " +
        "to acknowledge the duplicate-effect risk under retry/redelivery (D1).",
      nodePath: path,
      category: "mutation",
    });
  }

  // ── D2: return-prior-result semantics without an output schema ────────────
  // `idempotency: 'idempotent'` implies a duplicate invocation returns the
  // prior result; that result must be schema-validated to be safe to replay.
  if (idempotency === "idempotent" && !hasOutputSchema(node)) {
    warnings.push({
      stage: 4,
      code: "IDEMPOTENT_NO_OUTPUT_SCHEMA",
      message:
        "node declares idempotency 'idempotent' (prior result is replayed on " +
        "duplicate) but has no output schema; add `outputSchema`/`resultSchema` " +
        "so the replayed result is validated (D2).",
      nodePath: path,
      category: "mutation",
    });
  }
}
