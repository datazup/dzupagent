import { DEFAULT_PRIMITIVE_REGISTRY } from "./built-ins.js";
import type { PrimitiveRegistry } from "./types.js";

type StepWrapper = Record<string, unknown>;

function isStepWrapperArray(value: unknown): value is StepWrapper[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) => item && typeof item === "object" && !Array.isArray(item)
    )
  );
}

function expandStepArray(
  stepsRaw: StepWrapper[],
  registry: PrimitiveRegistry
): { changed: boolean; steps: StepWrapper[] } {
  const steps: StepWrapper[] = [];
  let changed = false;

  for (const wrapper of stepsRaw) {
    const keys = Object.keys(wrapper);
    if (keys.length !== 1) {
      steps.push(wrapper);
      continue;
    }

    const kind = keys[0]!;
    const definition = registry.get(kind);
    if (definition?.category !== "composite") {
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

  return { changed, steps };
}

export function expandRegisteredComposites(
  raw: unknown,
  registry: PrimitiveRegistry = DEFAULT_PRIMITIVE_REGISTRY
): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const doc = raw as Record<string, unknown>;
  const arrayKey = isStepWrapperArray(doc.steps)
    ? "steps"
    : isStepWrapperArray(doc.nodes)
      ? "nodes"
      : null;

  if (arrayKey === null) return raw;

  const expanded = expandStepArray(doc[arrayKey] as StepWrapper[], registry);
  if (!expanded.changed) return raw;

  return { ...doc, [arrayKey]: expanded.steps };
}
