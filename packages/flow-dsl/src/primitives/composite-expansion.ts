import {
  BUILT_IN_PRIMITIVE_REGISTRY_V2,
  DEFAULT_PRIMITIVE_REGISTRY,
} from "./built-ins.js";
import type {
  PrimitiveDefinition,
  PrimitiveDefinitionV2,
  PrimitiveRegistry,
  PrimitiveRegistryV2,
} from "./types.js";
import { expandFragmentInvocation } from "../fragments/expand-fragment.js";
import type {
  FragmentExpansionMetadata,
  FragmentRegistry,
} from "../fragments/types.js";
import {
  generatedV2SourceLineage,
  readV2SourceLineage,
  withV2SourceLineage,
  type V2SourceLineageMarker,
} from "../v2/source-lineage.js";

type StepWrapper = Record<string, unknown>;
const STEP_ARRAY_FIELDS = new Set([
  "steps",
  "nodes",
  "body",
  "then",
  "else",
  "catch",
  "onApprove",
  "onReject",
  "on_approve",
  "on_reject",
]);

export interface CompositeExpansionOptions {
  primitiveRegistry?: PrimitiveRegistry;
  primitiveRegistryV2?: PrimitiveRegistryV2;
  fragmentRegistry?: FragmentRegistry;
  requirePinnedFragmentUses?: boolean;
  requirePrimitiveLineage?: boolean;
}

interface ResolvedCompositeExpansionOptions {
  primitiveRegistry: PrimitiveRegistry;
  primitiveRegistryV2: PrimitiveRegistryV2;
  fragmentRegistry?: FragmentRegistry;
  requirePinnedFragmentUses: boolean;
  requirePrimitiveLineage: boolean;
  pinnedPrimitiveUses: Record<string, string>;
  pinnedFragmentUses: Record<string, string>;
}

export interface CompositeExpansionResult {
  raw: unknown;
  fragmentExpansions: FragmentExpansionMetadata[];
  primitiveExpansions: PrimitiveExpansionLineage[];
}

export interface PrimitiveExpansionLineage {
  readonly ref: PrimitiveDefinitionV2["ref"];
  readonly semanticHash: PrimitiveDefinitionV2["compatibility"]["semanticHash"];
  readonly invocationPath: string;
  readonly expandedPaths: readonly string[];
  readonly childPrimitiveRefs: readonly PrimitiveDefinitionV2["ref"][];
  readonly parentPrimitiveRef?: PrimitiveDefinitionV2["ref"];
}

function isStepWrapperArray(value: unknown): value is StepWrapper[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) => item && typeof item === "object" && !Array.isArray(item)
    )
  );
}

function isPrimitiveRegistry(value: unknown): value is PrimitiveRegistry {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as PrimitiveRegistry).get === "function" &&
    typeof (value as PrimitiveRegistry).list === "function" &&
    typeof (value as PrimitiveRegistry).has === "function"
  );
}

function normalizePinnedUses(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function pinnedPrimitiveVersion(
  namespace: string,
  options: ResolvedCompositeExpansionOptions,
): string | undefined {
  const reference = options.pinnedPrimitiveUses[namespace];
  if (!reference) return undefined;
  const match = /^dzup\.([A-Za-z][A-Za-z0-9_.-]*)@([0-9]+)$/.exec(reference);
  return match?.[1] === namespace ? match[2] : undefined;
}

function resolvePrimitiveDefinition(
  kind: string,
  options: ResolvedCompositeExpansionOptions,
): PrimitiveDefinition | undefined {
  const latest = options.primitiveRegistry.get(kind);
  if (!latest || latest.category !== "composite") return latest;

  const pinnedVersion = pinnedPrimitiveVersion(latest.namespace, options);
  if (pinnedVersion === undefined) return latest;

  const pinned = options.primitiveRegistry.get(kind, pinnedVersion);
  if (!pinned || pinned.category !== "composite") {
    const reference = options.pinnedPrimitiveUses[latest.namespace];
    throw new Error(
      `composite primitive ${kind} is pinned by uses.${latest.namespace} to ${reference}, but ${kind}@${pinnedVersion} is not registered as a composite`,
    );
  }
  return pinned;
}

function assertPinnedFragmentUse(
  kind: string,
  version: number,
  namespace: string,
  options: ResolvedCompositeExpansionOptions,
): void {
  if (!options.requirePinnedFragmentUses) return;
  const expectedRef = `dzup.${namespace}@${version}`;
  if (options.pinnedFragmentUses[namespace] === expectedRef) return;
  const foundRef = options.pinnedFragmentUses[namespace];
  throw new Error(
    `fragment ${kind}@${version} requires pinned uses entry "${namespace}: ${expectedRef}"` +
      (foundRef ? `; found "${foundRef}"` : ""),
  );
}

function expandNestedStepArrays(
  raw: unknown,
  options: ResolvedCompositeExpansionOptions,
  path: string,
): CompositeExpansionResult & { changed: boolean } {
  if (isStepWrapperArray(raw)) {
    return expandStepArray(raw, options, path);
  }
  if (Array.isArray(raw)) {
    return { raw, changed: false, fragmentExpansions: [], primitiveExpansions: [] };
  }
  if (!raw || typeof raw !== "object") {
    return { raw, changed: false, fragmentExpansions: [], primitiveExpansions: [] };
  }

  let changed = false;
  const fragmentExpansions: FragmentExpansionMetadata[] = [];
  const primitiveExpansions: PrimitiveExpansionLineage[] = [];
  const entries = Object.entries(raw as Record<string, unknown>).map(
    ([key, value]) => {
      if (!STEP_ARRAY_FIELDS.has(key) && key !== "branches") {
        return [key, value] as const;
      }
      const expanded =
        key === "branches"
          ? expandBranches(value, options, `${path}.${key}`)
          : expandNestedStepArrays(value, options, `${path}.${key}`);
      if (expanded.changed) changed = true;
      fragmentExpansions.push(...expanded.fragmentExpansions);
      primitiveExpansions.push(...expanded.primitiveExpansions);
      return [key, expanded.raw] as const;
    },
  );
  return {
    raw: changed ? Object.fromEntries(entries) : raw,
    changed,
    fragmentExpansions,
    primitiveExpansions,
  };
}

function expandBranches(
  raw: unknown,
  options: ResolvedCompositeExpansionOptions,
  path: string,
): CompositeExpansionResult & { changed: boolean } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { raw, changed: false, fragmentExpansions: [], primitiveExpansions: [] };
  }

  let changed = false;
  const fragmentExpansions: FragmentExpansionMetadata[] = [];
  const primitiveExpansions: PrimitiveExpansionLineage[] = [];
  const entries = Object.entries(raw as Record<string, unknown>).map(
    ([branchName, value]) => {
      const expanded = expandNestedStepArrays(
        value,
        options,
        `${path}.${branchName}`,
      );
      if (expanded.changed) changed = true;
      fragmentExpansions.push(...expanded.fragmentExpansions);
      primitiveExpansions.push(...expanded.primitiveExpansions);
      return [branchName, expanded.raw] as const;
    },
  );

  return {
    raw: changed ? Object.fromEntries(entries) : raw,
    changed,
    fragmentExpansions,
    primitiveExpansions,
  };
}

function expandStepArray(
  stepsRaw: StepWrapper[],
  options: ResolvedCompositeExpansionOptions,
  path: string,
): {
  changed: boolean;
  raw: StepWrapper[];
  steps: StepWrapper[];
  fragmentExpansions: FragmentExpansionMetadata[];
  primitiveExpansions: PrimitiveExpansionLineage[];
} {
  const steps: StepWrapper[] = [];
  const fragmentExpansions: FragmentExpansionMetadata[] = [];
  const primitiveExpansions: PrimitiveExpansionLineage[] = [];
  let changed = false;

  for (let index = 0; index < stepsRaw.length; index += 1) {
    const wrapper = stepsRaw[index]!;
    const keys = Object.keys(wrapper);
    if (keys.length !== 1) {
      steps.push(wrapper);
      continue;
    }

    const kind = keys[0]!;
    const definition = resolvePrimitiveDefinition(kind, options);
    if (definition?.category !== "composite") {
      const fragmentRegistry = options.fragmentRegistry;
      const fragmentEntry = fragmentRegistry?.get(kind);
      if (fragmentRegistry && fragmentEntry) {
        assertPinnedFragmentUse(
          kind,
          fragmentEntry.version,
          fragmentEntry.namespace,
          options,
        );
        const expanded = expandFragmentInvocation({
          registry: fragmentRegistry,
          kind,
          raw: wrapper[kind],
          path: `${path}[${index}]`,
        });
        const sourceLineage = readV2SourceLineage(wrapper[kind]);
        steps.push(
          ...(sourceLineage === undefined
            ? expanded.steps
            : annotateGeneratedV2Lineage(expanded.steps, sourceLineage)),
        );
        fragmentExpansions.push(...expanded.fragmentExpansions);
        changed = true;
        continue;
      }
      const nested = expandNestedStepArrays(
        wrapper[kind],
        options,
        `${path}[${index}]`,
      );
      if (nested.changed) {
        steps.push({ [kind]: nested.raw });
        fragmentExpansions.push(...nested.fragmentExpansions);
        primitiveExpansions.push(...nested.primitiveExpansions);
        changed = true;
        continue;
      }
      steps.push(wrapper);
      continue;
    }

    if (!definition.expand) {
      throw new Error(
        `composite primitive ${definition.kind}@${definition.version} has no registered expander`
      );
    }

    const primitiveSteps = definition.expand(wrapper[kind], {
        kind: definition.kind,
        version: definition.version,
      });
    const annotatedSteps = annotatePrimitiveSteps(
      primitiveSteps,
      `${definition.kind}@${definition.version}`,
    );
    const sourceLineage = readV2SourceLineage(wrapper[kind]);
    const sourcedSteps =
      sourceLineage === undefined
        ? annotatedSteps
        : annotateGeneratedV2Lineage(annotatedSteps, sourceLineage);
    const nested = expandStepArray(sourcedSteps, options, `${path}[${index}]`);
    const v2Definition = options.primitiveRegistryV2.resolve(
      definition.kind,
      definition.version,
    );
    if (v2Definition === undefined && options.requirePrimitiveLineage) {
      throw new Error(
        `composite primitive ${definition.kind}@${definition.version} requires an exact V2 definition for expansion lineage`,
      );
    }
    if (v2Definition !== undefined) {
      const childPrimitiveRefs = Object.freeze(
        [...new Set(nested.primitiveExpansions.map((item) => item.ref))].sort(),
      );
      primitiveExpansions.push(
        Object.freeze({
          ref: v2Definition.ref,
          semanticHash: v2Definition.compatibility.semanticHash,
          invocationPath: `${path}[${index}]`,
          expandedPaths: Object.freeze(
            nested.steps.map(
              (_, childIndex) =>
                `${path}[${index}].expanded[${childIndex}]`,
            ),
          ),
          childPrimitiveRefs,
        }),
        ...nested.primitiveExpansions.map((item) =>
          item.parentPrimitiveRef === undefined
            ? Object.freeze({
                ...item,
                parentPrimitiveRef: v2Definition.ref,
              })
            : item,
        ),
      );
    } else {
      primitiveExpansions.push(...nested.primitiveExpansions);
    }
    steps.push(...nested.steps);
    fragmentExpansions.push(...nested.fragmentExpansions);
    changed = true;
  }

  return {
    changed,
    raw: changed ? steps : stepsRaw,
    steps,
    fragmentExpansions,
    primitiveExpansions,
  };
}

function annotatePrimitiveSteps(
  steps: readonly StepWrapper[],
  primitive: string,
): StepWrapper[] {
  return steps.map((wrapper) => {
    const keys = Object.keys(wrapper);
    if (keys.length !== 1) return { ...wrapper };
    const kind = keys[0]!;
    const value = wrapper[kind];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ...wrapper };
    }
    const record = value as Record<string, unknown>;
    const meta =
      record.meta !== null &&
      typeof record.meta === "object" &&
      !Array.isArray(record.meta)
        ? (record.meta as Record<string, unknown>)
        : {};
    return {
      [kind]: {
        ...record,
        meta: { ...meta, primitive },
      },
    };
  });
}

function annotateGeneratedV2Lineage(
  steps: readonly StepWrapper[],
  source: V2SourceLineageMarker,
): StepWrapper[] {
  const generated = generatedV2SourceLineage(source);
  return steps.map((wrapper) =>
    annotateGeneratedV2Wrapper(wrapper, generated),
  );
}

function annotateGeneratedV2Wrapper(
  wrapper: StepWrapper,
  marker: V2SourceLineageMarker,
): StepWrapper {
  const keys = Object.keys(wrapper);
  if (keys.length !== 1) return { ...wrapper };
  const kind = keys[0]!;
  const value = wrapper[kind];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...wrapper };
  }
  const body = value as Record<string, unknown>;
  const annotated: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(body)) {
    if (STEP_ARRAY_FIELDS.has(key) && Array.isArray(nested)) {
      annotated[key] = nested.map((item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? annotateGeneratedV2Wrapper(item as StepWrapper, marker)
          : item,
      );
      continue;
    }
    if (key === "branches" && nested && typeof nested === "object" && !Array.isArray(nested)) {
      annotated[key] = Object.fromEntries(
        Object.entries(nested as Record<string, unknown>).map(
          ([branchName, branchSteps]) => [
            branchName,
            Array.isArray(branchSteps)
              ? branchSteps.map((item) =>
                  item && typeof item === "object" && !Array.isArray(item)
                    ? annotateGeneratedV2Wrapper(item as StepWrapper, marker)
                    : item,
                )
              : branchSteps,
          ],
        ),
      );
      continue;
    }
    annotated[key] = nested;
  }
  return {
    [kind]: withV2SourceLineage(annotated, marker),
  };
}

export function expandRegisteredComposites(
  raw: unknown,
  registryOrOptions: PrimitiveRegistry | CompositeExpansionOptions = DEFAULT_PRIMITIVE_REGISTRY
): unknown {
  return expandRegisteredCompositesDetailed(raw, registryOrOptions).raw;
}

export function expandRegisteredCompositesDetailed(
  raw: unknown,
  registryOrOptions: PrimitiveRegistry | CompositeExpansionOptions = DEFAULT_PRIMITIVE_REGISTRY
): CompositeExpansionResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { raw, fragmentExpansions: [], primitiveExpansions: [] };
  }
  const options: ResolvedCompositeExpansionOptions = isPrimitiveRegistry(
    registryOrOptions
  )
    ? {
        primitiveRegistry: registryOrOptions,
        primitiveRegistryV2: BUILT_IN_PRIMITIVE_REGISTRY_V2,
        requirePinnedFragmentUses: false,
        requirePrimitiveLineage: false,
        pinnedPrimitiveUses: {},
        pinnedFragmentUses: {},
      }
    : {
        primitiveRegistry:
          registryOrOptions.primitiveRegistry ?? DEFAULT_PRIMITIVE_REGISTRY,
        primitiveRegistryV2:
          registryOrOptions.primitiveRegistryV2 ??
          BUILT_IN_PRIMITIVE_REGISTRY_V2,
        requirePinnedFragmentUses:
          registryOrOptions.requirePinnedFragmentUses ?? false,
        requirePrimitiveLineage:
          registryOrOptions.requirePrimitiveLineage ?? false,
        pinnedPrimitiveUses: {},
        pinnedFragmentUses: {},
        ...(registryOrOptions.fragmentRegistry
          ? { fragmentRegistry: registryOrOptions.fragmentRegistry }
          : {}),
      };
  const doc = raw as Record<string, unknown>;
  options.pinnedPrimitiveUses = normalizePinnedUses(doc.uses);
  options.pinnedFragmentUses = options.pinnedPrimitiveUses;
  const arrayKey = isStepWrapperArray(doc.steps)
    ? "steps"
    : isStepWrapperArray(doc.nodes)
      ? "nodes"
      : null;

  if (arrayKey === null) {
    return { raw, fragmentExpansions: [], primitiveExpansions: [] };
  }

  const expanded = expandStepArray(doc[arrayKey] as StepWrapper[], options, arrayKey);
  if (!expanded.changed) {
    return { raw, fragmentExpansions: [], primitiveExpansions: [] };
  }

  return {
    raw: { ...doc, [arrayKey]: expanded.steps },
    fragmentExpansions: expanded.fragmentExpansions,
    primitiveExpansions: expanded.primitiveExpansions,
  };
}
