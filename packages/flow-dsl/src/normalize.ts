import type { FlowDocumentDsl, FlowDocumentV1 } from "@dzupagent/flow-ast";

import { DSL_ERROR } from "./errors.js";
import { normalizeSteps } from "./normalize-node-helpers.js";
import { DEFAULT_PRIMITIVE_REGISTRY } from "./primitives/built-ins.js";
import { normalizePrimitiveImports } from "./primitives/imports.js";
import {
  isPlainObject,
  normalizeDefaults,
  normalizeInputs,
  normalizeObject,
  normalizeStringArray,
} from "./normalize-value-helpers.js";
import type { DslDiagnostic, NormalizeDslResult } from "./types.js";

export { normalizeSteps } from "./normalize-node-helpers.js";

const TOP_LEVEL_KEYS = new Set([
  "dsl",
  "id",
  "title",
  "description",
  "version",
  "inputs",
  "defaults",
  "tags",
  "meta",
  "uses",
  "durability",
  "steps",
]);

export function normalizeDslDocument(raw: unknown): NormalizeDslResult {
  const diagnostics: DslDiagnostic[] = [];
  if (!isPlainObject(raw)) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.INVALID_TOP_LEVEL_SHAPE,
      message: "Top-level dzupflow document must be an object",
      path: "root",
    });
    return { ok: false, document: null, partialDocument: null, diagnostics };
  }

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      const message =
        key === "nodes" || key === "edges"
          ? `Graph-style top-level field "${key}" is not supported in dzupflow/v1; use "steps" authoring form instead`
          : `Unsupported top-level field "${key}"`;
      diagnostics.push({
        phase: "normalize",
        code: DSL_ERROR.UNSUPPORTED_FIELD,
        message,
        path: `root.${key}`,
        ...(key === "nodes" || key === "edges"
          ? {
              suggestion:
                "Replace graph-style nodes/edges input with dzupflow/v1 steps.",
            }
          : {}),
      });
    }
  }

  const stepsRaw = raw.steps;
  const steps = normalizeSteps(stepsRaw, "root.steps", diagnostics);

  const inputs = normalizeInputs(raw.inputs, diagnostics);
  const defaults = normalizeDefaults(raw.defaults, diagnostics);
  const tags = normalizeStringArray(raw.tags, "root.tags", diagnostics);
  const meta = normalizeObject(raw.meta, "root.meta", diagnostics);
  // P0 durability contract: carry the top-level `durability` block through.
  // Deep field validation happens in flow-ast `validateDocument`; here we only
  // ensure it is a plain object and pass it on.
  const durability = normalizeObject(
    raw.durability,
    "root.durability",
    diagnostics,
  );
  const uses = normalizePrimitiveImports(
    raw.uses,
    diagnostics,
    DEFAULT_PRIMITIVE_REGISTRY,
  );

  const dslDeclared = typeof raw.dsl === "string" ? raw.dsl : undefined;
  const dslEffective: FlowDocumentDsl =
    dslDeclared === "dzupflow/v1alpha-agent"
      ? "dzupflow/v1alpha-agent"
      : "dzupflow/v1";

  const doc: FlowDocumentV1 = {
    dsl: dslEffective,
    id: typeof raw.id === "string" ? raw.id : "",
    version: typeof raw.version === "number" ? raw.version : 0,
    root: {
      type: "sequence",
      id: "root",
      nodes: steps,
    },
  };

  if (typeof raw.title === "string") doc.title = raw.title;
  if (typeof raw.description === "string") doc.description = raw.description;
  if (inputs !== undefined) doc.inputs = inputs;
  if (defaults !== undefined) doc.defaults = defaults;
  if (tags !== undefined) doc.tags = tags;
  if (meta !== undefined || uses !== undefined) {
    doc.meta = {
      ...(meta ?? {}),
      ...(uses !== undefined ? { primitiveUses: uses } : {}),
    };
  }
  if (durability !== undefined) {
    doc.durability = durability as FlowDocumentV1["durability"];
  }
  if (
    dslDeclared !== undefined &&
    dslDeclared !== "dzupflow/v1" &&
    dslDeclared !== "dzupflow/v1alpha-agent"
  ) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.INVALID_DSL_VERSION,
      message: `Unsupported DSL version "${dslDeclared}"; accepted: "dzupflow/v1", "dzupflow/v1alpha-agent"`,
      path: "root.dsl",
    });
  }
  if (raw.version !== undefined && raw.version !== 1) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.INVALID_ENUM_VALUE,
      message: "version must equal 1 for dzupflow/v1",
      path: "root.version",
    });
  }
  if (diagnostics.length > 0) {
    return { ok: false, document: null, partialDocument: doc, diagnostics };
  }

  return { ok: true, document: doc, partialDocument: null, diagnostics: [] };
}
