import type { DslDiagnostic } from "../types.js";
import type { FragmentRegistry } from "../fragments/types.js";
import type { PrimitiveRegistry } from "./types.js";

export type PrimitiveImports = Record<string, string>;

export interface NormalizedImports {
  primitiveUses?: PrimitiveImports;
  fragmentUses?: PrimitiveImports;
}

const ALIAS_RE = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const PACKAGE_REF_RE = /^dzup\.([A-Za-z][A-Za-z0-9_.-]*)@([0-9]+)$/;

export function normalizePrimitiveImports(
  raw: unknown,
  diagnostics: DslDiagnostic[],
  registry: PrimitiveRegistry,
  fragmentRegistry?: FragmentRegistry,
): NormalizedImports | undefined {
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

  const primitiveUses: PrimitiveImports = {};
  const fragmentUses: PrimitiveImports = {};
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

    const registeredPrimitive = registry
      .list(namespace)
      .some((definition) => definition.version === majorVersion);
    const registeredFragment = fragmentRegistry
      ?.list(namespace)
      .some((entry) => entry.version === Number(majorVersion));
    if (!registeredPrimitive && !registeredFragment) {
      diagnostics.push({
        phase: "normalize",
        code: "INVALID_USES",
        message: `uses.${alias} references an unregistered primitive namespace or fragment version: ${value}`,
        path: `root.uses.${alias}`,
      });
      continue;
    }

    if (registeredPrimitive) primitiveUses[alias] = value;
    if (registeredFragment) fragmentUses[alias] = value;
  }

  return {
    ...(Object.keys(primitiveUses).length > 0 ? { primitiveUses } : {}),
    ...(Object.keys(fragmentUses).length > 0 ? { fragmentUses } : {}),
  };
}
