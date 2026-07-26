import { parseYamlSubset } from "../mini-yaml.js";
import { parseDslToDocument } from "../parse-dsl.js";
import type { DslDiagnostic } from "../types.js";
import { lowerDslV2Document } from "../v2/lower-v2.js";
import {
  DSL_V2_AUTHORING_ID,
  type DslV2AuthoringAuthority,
  type DslV2AuthoringOptions,
  type DslV2AuthoringResult,
} from "./contracts.js";
import {
  canonicalizeV2Document,
  renderCanonicalV2Yaml,
  sha256,
  stableStringify,
} from "./canonical.js";

const AUTHORITY: DslV2AuthoringAuthority = Object.freeze({
  sourceFormatting: true,
  reportOnlyMigration: true,
  documentMutation: false,
  runtimeExecution: false,
  providerDispatch: false,
  deployment: false,
  activation: false,
});

export function importDslV2Source(
  source: string,
  options: DslV2AuthoringOptions = {}
): DslV2AuthoringResult {
  const parsed = parseYamlSubset(source);
  if (!parsed.ok) {
    return failure(
      null,
      parsed.errors.map((error) => ({
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
      }))
    );
  }
  return formatDslV2Document(parsed.value, options);
}

export function formatDslV2Document(
  raw: unknown,
  options: DslV2AuthoringOptions = {}
): DslV2AuthoringResult {
  const canonical = canonicalizeV2Document(raw);
  if (!canonical.ok) return failure(null, canonical.diagnostics);
  const lowered = lowerDslV2Document(canonical.document, {
    ...(options.primitiveRegistryV2 === undefined
      ? {}
      : { primitiveRegistryV2: options.primitiveRegistryV2 }),
    ...(options.inheritedPolicy === undefined
      ? {}
      : { inheritedPolicy: options.inheritedPolicy }),
    ...(options.importCatalogs === undefined
      ? {}
      : { importCatalogs: options.importCatalogs }),
  });
  if (!lowered.ok) return failure(canonical.document, lowered.diagnostics);

  const canonicalSource = renderCanonicalV2Yaml(canonical.document);
  const reparsed = parseDslToDocument(canonicalSource, {
    ...(options.primitiveRegistryV2 === undefined
      ? {}
      : { primitiveRegistryV2: options.primitiveRegistryV2 }),
    ...(options.inheritedPolicy === undefined
      ? {}
      : { v2InheritedPolicy: options.inheritedPolicy }),
    ...(options.importCatalogs === undefined
      ? {}
      : { v2ImportCatalogs: options.importCatalogs }),
  });
  if (!reparsed.ok || reparsed.frontend === undefined) {
    return failure(
      canonical.document,
      reparsed.ok
        ? [
            diagnostic(
              "V2_AUTHORING_FRONTEND_METADATA_MISSING",
              "canonical V2 source reparsed without V2 frontend metadata"
            ),
          ]
        : reparsed.diagnostics.map((item) => ({
            ...item,
            code: `V2_AUTHORING_REPARSE_${item.code}`,
          }))
    );
  }

  return deepFreeze({
    ok: true as const,
    schema: "dzupagent.dslV2Authoring/v1" as const,
    authoringId: DSL_V2_AUTHORING_ID,
    document: canonical.document,
    canonicalSource,
    canonicalSourceSha256: sha256(canonicalSource),
    semanticSha256: sha256(stableStringify(reparsed.document)),
    resolvedImportLockSha256: reparsed.frontend.resolvedImportLock.lockSha256,
    canonicalDocument: reparsed.document,
    frontend: reparsed.frontend,
    diagnostics: [] as const,
    comments: "not-preserved" as const,
    authority: AUTHORITY,
  });
}

export function v2AuthoringAuthority(): DslV2AuthoringAuthority {
  return AUTHORITY;
}

function failure(
  document: Readonly<Record<string, unknown>> | null,
  diagnostics: readonly DslDiagnostic[]
): DslV2AuthoringResult {
  return deepFreeze({
    ok: false as const,
    schema: "dzupagent.dslV2Authoring/v1" as const,
    authoringId: DSL_V2_AUTHORING_ID,
    document,
    diagnostics: [...diagnostics],
    comments: "not-preserved" as const,
    authority: AUTHORITY,
  });
}

function diagnostic(code: string, message: string): DslDiagnostic {
  return { phase: "normalize", code, message, path: "root" };
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) value.forEach((item) => deepFreeze(item));
  else Object.values(value).forEach((item) => deepFreeze(item));
  return Object.freeze(value);
}
