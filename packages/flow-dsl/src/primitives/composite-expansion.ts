import { DEFAULT_PRIMITIVE_REGISTRY } from "./built-ins.js";
import type { PrimitiveRegistry } from "./types.js";
import { expandFragmentInvocation } from "../fragments/expand-fragment.js";
import type {
  FragmentExpansionMetadata,
  FragmentRegistry,
} from "../fragments/types.js";

type StepWrapper = Record<string, unknown>;

export interface CompositeExpansionOptions {
  primitiveRegistry?: PrimitiveRegistry;
  fragmentRegistry?: FragmentRegistry;
}

interface ResolvedCompositeExpansionOptions {
  primitiveRegistry: PrimitiveRegistry;
  fragmentRegistry?: FragmentRegistry;
}

export interface CompositeExpansionResult {
  raw: unknown;
  fragmentExpansions: FragmentExpansionMetadata[];
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

function expandStepArray(
  stepsRaw: StepWrapper[],
  options: ResolvedCompositeExpansionOptions
): { changed: boolean; steps: StepWrapper[]; fragmentExpansions: FragmentExpansionMetadata[] } {
  const steps: StepWrapper[] = [];
  const fragmentExpansions: FragmentExpansionMetadata[] = [];
  let changed = false;

  for (let index = 0; index < stepsRaw.length; index += 1) {
    const wrapper = stepsRaw[index]!;
    const keys = Object.keys(wrapper);
    if (keys.length !== 1) {
      steps.push(wrapper);
      continue;
    }

    const kind = keys[0]!;
    const definition = options.primitiveRegistry.get(kind);
    if (definition?.category !== "composite") {
      const fragmentRegistry = options.fragmentRegistry;
      if (fragmentRegistry?.get(kind)) {
        const expanded = expandFragmentInvocation({
          registry: fragmentRegistry,
          kind,
          raw: wrapper[kind],
          path: `steps[${index}]`,
        });
        steps.push(...expanded.steps);
        fragmentExpansions.push(...expanded.fragmentExpansions);
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

    steps.push(
      ...definition.expand(wrapper[kind], {
        kind: definition.kind,
        version: definition.version,
      })
    );
    changed = true;
  }

  return { changed, steps, fragmentExpansions };
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
    return { raw, fragmentExpansions: [] };
  }
  const options: ResolvedCompositeExpansionOptions = isPrimitiveRegistry(
    registryOrOptions
  )
    ? { primitiveRegistry: registryOrOptions }
    : {
        primitiveRegistry:
          registryOrOptions.primitiveRegistry ?? DEFAULT_PRIMITIVE_REGISTRY,
        ...(registryOrOptions.fragmentRegistry
          ? { fragmentRegistry: registryOrOptions.fragmentRegistry }
          : {}),
      };
  const doc = raw as Record<string, unknown>;
  const arrayKey = isStepWrapperArray(doc.steps)
    ? "steps"
    : isStepWrapperArray(doc.nodes)
      ? "nodes"
      : null;

  if (arrayKey === null) return { raw, fragmentExpansions: [] };

  const expanded = expandStepArray(doc[arrayKey] as StepWrapper[], options);
  if (!expanded.changed) return { raw, fragmentExpansions: [] };

  return {
    raw: { ...doc, [arrayKey]: expanded.steps },
    fragmentExpansions: expanded.fragmentExpansions,
  };
}
