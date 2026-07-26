import type { FlowDocumentV1 } from "@dzupagent/flow-ast";

import { parseYamlSubset } from "./mini-yaml.js";
import { expandRegisteredCompositesDetailed } from "./primitives/composite-expansion.js";
import { normalizeDslDocument } from "./normalize.js";
import { validateDocument } from "./document-validate.js";
import { BUILT_IN_FRAGMENT_REGISTRY } from "./fragments/built-ins.js";
import type { ParseDslResult } from "./types.js";
import type { FragmentRegistry } from "./fragments/types.js";
import type { PrimitiveRegistry } from "./primitives/types.js";
import type { PrimitiveRegistryV2 } from "./primitives/types.js";
import type { PrimitivePolicyLimits } from "./v2/policy-narrowing.js";
import type { DslV2ExternalImportCatalogs } from "./v2/types.js";
import { BUILT_IN_PRIMITIVE_REGISTRY_V2 } from "./primitives/built-ins.js";
import { lowerDslV2Document } from "./v2/lower-v2.js";
import { createDslSourceMap, resolveDslSourceSpan } from "./dsl-source-map.js";
import { stripV2SourceLineage } from "./v2/source-lineage.js";
import type { DslDiagnostic, DslSourceMap } from "./types.js";

export interface ParseDslToDocumentOptions {
  fragmentRegistry?: FragmentRegistry;
  primitiveRegistry?: PrimitiveRegistry;
  primitiveRegistryV2?: PrimitiveRegistryV2;
  requirePinnedFragmentUses?: boolean;
  requirePrimitiveLineage?: boolean;
  v2InheritedPolicy?: PrimitivePolicyLimits;
  v2ImportCatalogs?: DslV2ExternalImportCatalogs;
}

export function parseDslToDocument(
  source: string,
  options: ParseDslToDocumentOptions = {}
): ParseDslResult {
  const fragmentRegistry =
    options.fragmentRegistry ?? BUILT_IN_FRAGMENT_REGISTRY;
  const yaml = parseYamlSubset(source);
  if (!yaml.ok) {
    return {
      document: null,
      diagnostics: yaml.errors.map((error) => ({
        phase: "parse" as const,
        code: error.code,
        message: error.message,
        path: "root",
        span: {
          lineStart: error.line,
          columnStart: error.column,
          lineEnd: error.line,
          columnEnd: error.column,
        },
      })),
      ok: false,
      partialDocument: null,
    };
  }

  const v2 =
    yaml.value &&
    typeof yaml.value === "object" &&
    !Array.isArray(yaml.value) &&
    (yaml.value as Record<string, unknown>).dsl === "dzupflow/v2"
      ? lowerDslV2Document(yaml.value, {
          primitiveRegistryV2:
            options.primitiveRegistryV2 ?? BUILT_IN_PRIMITIVE_REGISTRY_V2,
          ...(options.v2InheritedPolicy === undefined
            ? {}
            : { inheritedPolicy: options.v2InheritedPolicy }),
          ...(options.v2ImportCatalogs === undefined
            ? {}
            : { importCatalogs: options.v2ImportCatalogs }),
        })
      : undefined;
  if (v2 !== undefined && !v2.ok) {
    const sourceMap = createDslSourceMap(source);
    return {
      ok: false,
      document: null,
      partialDocument: null,
      diagnostics: attachDiagnosticSpans(v2.diagnostics, sourceMap),
      ...(sourceMap === undefined ? {} : { sourceMap }),
    };
  }
  const authoredRaw = v2?.raw ?? yaml.value;

  // MPCO P2: expand registered composite primitives before normalization.
  let expandedRaw: unknown;
  let fragmentExpansions: unknown[] = [];
  let primitiveExpansions: unknown[] = [];
  try {
    const expanded = expandRegisteredCompositesDetailed(authoredRaw, {
      primitiveRegistry: options.primitiveRegistry,
      primitiveRegistryV2:
        options.primitiveRegistryV2 ?? BUILT_IN_PRIMITIVE_REGISTRY_V2,
      fragmentRegistry,
      requirePinnedFragmentUses: options.requirePinnedFragmentUses,
      requirePrimitiveLineage:
        options.requirePrimitiveLineage ?? v2 !== undefined,
    });
    expandedRaw = expanded.raw;
    fragmentExpansions = expanded.fragmentExpansions;
    primitiveExpansions = expanded.primitiveExpansions;
  } catch (error) {
    const sourceMap = createDslSourceMap(source);
    return {
      ok: false,
      document: null,
      partialDocument: null,
      diagnostics: [
        {
          phase: "normalize" as const,
          code: "INVALID_COMPOSITE_PRIMITIVE",
          message: error instanceof Error ? error.message : String(error),
          path: "root.steps",
        },
      ],
      ...(sourceMap === undefined ? {} : { sourceMap }),
    };
  }

  const normalized = normalizeDslDocument(expandedRaw, {
    primitiveRegistry: options.primitiveRegistry,
    fragmentRegistry,
  });
  if (!normalized.ok) {
    const sourceMap =
      v2 === undefined
        ? undefined
        : createDslSourceMap(source, normalized.partialDocument ?? undefined);
    const partialDocument =
      v2 === undefined || normalized.partialDocument === null
        ? normalized.partialDocument
        : stripV2SourceLineage(normalized.partialDocument);
    return {
      ok: false,
      document: null,
      partialDocument,
      diagnostics: attachDiagnosticSpans(normalized.diagnostics, sourceMap),
      ...(sourceMap === undefined ? {} : { sourceMap }),
    };
  }

  const { document } = normalized;
  if (fragmentExpansions.length > 0 || primitiveExpansions.length > 0) {
    document.meta = {
      ...(document.meta ?? {}),
      ...(fragmentExpansions.length === 0 ? {} : { fragmentExpansions }),
      ...(primitiveExpansions.length === 0 ? {} : { primitiveExpansions }),
    };
  }
  const sourceMap =
    v2 === undefined ? undefined : createDslSourceMap(source, document);
  const canonicalDocument =
    v2 === undefined ? document : stripV2SourceLineage(document);
  const validation = validateDocument(canonicalDocument);
  const allDiagnostics = attachDiagnosticSpans(
    validation.diagnostics,
    sourceMap
  );
  if (allDiagnostics.length > 0) {
    return {
      ok: false,
      document: null,
      partialDocument: canonicalDocument,
      diagnostics: allDiagnostics,
      ...(sourceMap === undefined ? {} : { sourceMap }),
    };
  }

  return {
    ok: true,
    document: canonicalDocument as FlowDocumentV1,
    partialDocument: null,
    diagnostics: [],
    ...(v2 === undefined ? {} : { frontend: v2.metadata }),
    ...(sourceMap === undefined ? {} : { sourceMap }),
  };
}

function attachDiagnosticSpans(
  diagnostics: readonly DslDiagnostic[],
  sourceMap: DslSourceMap | undefined
): DslDiagnostic[] {
  if (sourceMap === undefined) return [...diagnostics];
  return diagnostics.map((diagnostic) => {
    if (diagnostic.span !== undefined) return diagnostic;
    const span = resolveDslSourceSpan(sourceMap, diagnostic.path);
    return span === undefined
      ? diagnostic
      : {
          ...diagnostic,
          span: {
            lineStart: span.lineStart,
            columnStart: span.columnStart,
            lineEnd: span.lineEnd,
            columnEnd: span.columnEnd,
          },
        };
  });
}
