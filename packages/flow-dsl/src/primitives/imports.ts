import type { DslDiagnostic } from "../types.js";
import type { PrimitiveRegistry } from "./types.js";

export type PrimitiveImports = Record<string, string>;

const ALIAS_RE = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const PACKAGE_REF_RE = /^dzup\.([A-Za-z][A-Za-z0-9_.-]*)@([0-9]+)$/;

export function normalizePrimitiveImports(
  raw: unknown,
  diagnostics: DslDiagnostic[],
  registry: PrimitiveRegistry
): PrimitiveImports | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    diagnostics.push({
      phase: "normalize",
      code: "INVALID_USES",
      message: "uses must be an object of namespace aliases to package refs",
      path: "root.uses",
    });
    return undefined;
  }

  const imports: PrimitiveImports = {};
  for (const [alias, value] of Object.entries(raw)) {
    if (!ALIAS_RE.test(alias)) {
      diagnostics.push({
        phase: "normalize",
        code: "INVALID_USES",
        message: `uses.${alias} must be a valid primitive namespace alias`,
        path: `root.uses.${alias}`,
      });
      continue;
    }

    if (typeof value !== "string") {
      diagnostics.push({
        phase: "normalize",
        code: "INVALID_USES",
        message: `uses.${alias} must be a primitive package reference like dzup.${alias}@1`,
        path: `root.uses.${alias}`,
      });
      continue;
    }

    const match = PACKAGE_REF_RE.exec(value);
    if (!match) {
      diagnostics.push({
        phase: "normalize",
        code: "INVALID_USES",
        message: `uses.${alias} must be a primitive package reference like dzup.${alias}@1`,
        path: `root.uses.${alias}`,
      });
      continue;
    }

    const namespace = match[1]!;
    const majorVersion = match[2]!;
    if (namespace !== alias) {
      diagnostics.push({
        phase: "normalize",
        code: "INVALID_USES",
        message: `uses.${alias} must reference dzup.${alias}@${majorVersion}`,
        path: `root.uses.${alias}`,
      });
      continue;
    }

    const registered = registry
      .list(namespace)
      .some((definition) => definition.version === majorVersion);
    if (!registered) {
      diagnostics.push({
        phase: "normalize",
        code: "INVALID_USES",
        message: `uses.${alias} references an unregistered primitive namespace or version: ${value}`,
        path: `root.uses.${alias}`,
      });
      continue;
    }

    imports[alias] = value;
  }

  return imports;
}
