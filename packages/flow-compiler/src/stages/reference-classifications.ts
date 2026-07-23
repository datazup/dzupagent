import type {
  FlowDataClassification,
  FlowDocumentV1,
  FlowNode,
} from "@dzupagent/flow-ast";
import {
  analyzeFlowTemplateReferences,
  parseFlowReferenceExpression,
  type FlowReferenceBindings,
  type ParsedFlowReference,
} from "@dzupagent/flow-ast/expressions";

import type {
  FlowReferenceClassificationBindings,
  FlowReferencePortClassificationBindings,
} from "../types.js";

const CLASSIFICATION_ORDER: Record<FlowDataClassification, number> = {
  public: 0,
  internal: 1,
  sensitive: 2,
  secret: 3,
};

const CANONICAL_BARE_REFERENCE =
  /^(?:inputs|state|steps|loop|context|secrets|artifacts|params)(?:\.|\[)/;

/** Derive explicit input classifications from an authored document. */
export function deriveDocumentReferenceClassificationBindings(
  document: FlowDocumentV1,
): FlowReferenceClassificationBindings {
  const inputs: Record<string, FlowDataClassification> = {};
  for (const [name, spec] of Object.entries(document.inputs ?? {}).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const classification =
      spec.type === "credential" ? "secret" : spec.classification;
    if (classification !== undefined) {
      inputs[name] = classification;
    }
  }
  return Object.keys(inputs).length > 0 ? { inputs } : {};
}

/** Treat every declared `secrets.*` binding as secret without host repetition. */
export function deriveSecretReferenceClassificationBindings(
  bindings: FlowReferenceBindings | undefined,
): FlowReferenceClassificationBindings {
  const names = bindings?.["secrets"] ?? [];
  if (names.length === 0) return {};
  return {
    secrets: Object.fromEntries(
      [...names].sort((left, right) => left.localeCompare(right)).map(
        (name) => [name, "secret" as const],
      ),
    ),
  };
}

/** Merge classifications monotonically; the most restrictive value wins. */
export function mergeReferenceClassificationBindings(
  ...sources: Array<FlowReferenceClassificationBindings | undefined>
): FlowReferenceClassificationBindings {
  return mergeClassificationMaps(sources);
}

/** Merge reviewed port classifications monotonically. */
export function mergeReferencePortClassificationBindings(
  ...sources: Array<FlowReferencePortClassificationBindings | undefined>
): FlowReferencePortClassificationBindings {
  return mergeClassificationMaps(sources);
}

/** Return the more restrictive of two classifications. */
export function mergeFlowDataClassification(
  current: FlowDataClassification | undefined,
  next: FlowDataClassification | undefined,
): FlowDataClassification | undefined {
  if (current === undefined) return next;
  if (next === undefined) return current;
  const nextRank = CLASSIFICATION_ORDER[next] ?? 0;
  const currentRank = CLASSIFICATION_ORDER[current] ?? 0;
  return nextRank > currentRank
    ? next
    : current;
}

/** Resolve a parsed reference against ordinary or reviewed port bindings. */
export function classificationForReference(
  reference: ParsedFlowReference,
  bindings: FlowReferenceClassificationBindings | undefined,
  ports: FlowReferencePortClassificationBindings | undefined,
): FlowDataClassification | undefined {
  if (reference.root === "secrets") return "secret";
  const first = reference.segments[0];
  if (first?.kind !== "property") return undefined;
  if (reference.root !== "steps") {
    return bindings?.[reference.root]?.[first.key];
  }
  const port = reference.segments[1];
  if (port?.kind !== "property") return undefined;
  return ports?.[first.key]?.[port.key];
}

/**
 * Conservatively propagate declared classifications into compiler-owned state
 * outputs. This is a bounded fixed point over the finite output-key set; it
 * never lowers an existing classification.
 */
export function deriveNodeReferenceClassificationBindings(
  root: FlowNode,
  seed: FlowReferenceClassificationBindings = {},
  ports: FlowReferencePortClassificationBindings = {},
): FlowReferenceClassificationBindings {
  let bindings = mergeReferenceClassificationBindings(seed);
  const nodes = flattenNodes(root);
  const iterationLimit = Math.max(1, countOutputKeys(nodes) + 1);

  for (let iteration = 0; iteration < iterationLimit; iteration += 1) {
    let changed = false;
    for (const node of nodes) {
      for (const [name, classification] of outputClassifications(
        node,
        bindings,
        ports,
      )) {
        const current = bindings["state"]?.[name];
        const merged = mergeFlowDataClassification(current, classification);
        if (merged === undefined || merged === current) continue;
        bindings = mergeReferenceClassificationBindings(bindings, {
          state: { [name]: merged },
        });
        changed = true;
      }
    }
    if (!changed) break;
  }

  return bindings["state"] === undefined ? {} : { state: bindings["state"] };
}

function mergeClassificationMaps(
  sources: Array<
    | FlowReferenceClassificationBindings
    | FlowReferencePortClassificationBindings
    | undefined
  >,
): FlowReferenceClassificationBindings {
  const merged = new Map<
    string,
    Map<string, FlowDataClassification>
  >();
  for (const source of sources) {
    if (source === undefined) continue;
    for (const [root, values] of Object.entries(source)) {
      if (values === undefined) continue;
      const current =
        merged.get(root) ?? new Map<string, FlowDataClassification>();
      for (const [name, classification] of Object.entries(values)) {
        if (classification === undefined) continue;
        const next = mergeFlowDataClassification(
          current.get(name),
          classification,
        );
        if (next !== undefined) current.set(name, next);
      }
      merged.set(root, current);
    }
  }
  return Object.fromEntries(
    [...merged.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([root, values]) => [
        root,
        Object.fromEntries(
          [...values.entries()].sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        ),
      ]),
  );
}

function outputClassifications(
  node: FlowNode,
  bindings: FlowReferenceClassificationBindings,
  ports: FlowReferencePortClassificationBindings,
): Array<[string, FlowDataClassification]> {
  if (node.type === "set") {
    return Object.entries(node.assign).flatMap(([name, value]) => {
      const classification = classificationFromValue(value, bindings, ports);
      return classification === undefined ? [] : [[name, classification]];
    });
  }

  if (node.type === "for_each") {
    const outputs: Array<[string, FlowDataClassification]> = [];
    const source = classificationFromBareOrTemplate(
      node.source,
      bindings,
      ports,
    );
    if (source !== undefined) {
      outputs.push([node.as, source]);
      if (node.collect !== undefined) outputs.push([node.collect.into, source]);
    }
    if (node.accumulator !== undefined) {
      const accumulated = mergeFlowDataClassification(
        source,
        classificationFromValue(
          node.accumulator.initialValue,
          bindings,
          ports,
        ),
      );
      if (accumulated !== undefined) {
        outputs.push([node.accumulator.key, accumulated]);
      }
    }
    return outputs;
  }

  const output = stateOutputKeyForClassification(node);
  if (output === undefined) return [];
  let classification =
    node.type === "evidence.write" || node.type === "validate.schema"
      ? classificationFromStateKeyOrTemplate(node.source, bindings, ports)
      : classificationFromValue(outputSourceValue(node), bindings, ports);
  if (node.type === "evidence.write" && node.redact === true) {
    classification = redactClassification(classification);
  }
  return classification === undefined ? [] : [[output, classification]];
}

export function stateOutputKeyForClassification(
  node: FlowNode,
): string | undefined {
  switch (node.type) {
    case "classify":
      return node.outputKey;
    case "http":
      return node.outputVar ?? node.id ?? "httpResponse";
    case "subflow":
      return node.outputVar ?? node.id ?? "subflowResult";
    case "prompt":
      return node.outputKey ?? node.id ?? "promptResult";
    case "agent":
      return node.output.key;
    case "worker.dispatch":
      return node.outputKey;
    case "adapter.run":
    case "adapter.race":
    case "adapter.parallel":
    case "adapter.supervisor":
      return node.output;
    case "fleet.dispatch":
    case "fleet.gather":
    case "fleet.contract-net":
    case "shell.run":
    case "evidence.write":
    case "validate.schema":
      return node.output;
    case "knowledge.query":
      return node.output;
    case "spdd.import_sources":
    case "spdd.build_source_pack":
    case "spdd.run_analysis":
    case "spdd.generate_canvas":
    case "spdd.validate_canvas":
    case "spdd.review_canvas":
    case "spdd.project_plan":
    case "spdd.arm_dispatch":
    case "spdd.run_validation":
    case "spdd.collect_proof":
    case "spdd.scan_drift":
    case "spdd.create_sync_proposal":
    case "spdd.agent_swarm":
      return node.outputKey;
    default:
      return undefined;
  }
}

function outputSourceValue(node: FlowNode): unknown {
  switch (node.type) {
    case "classify":
      return node.prompt;
    case "http":
      return [node.url, node.headers, node.body];
    case "subflow":
      return node.input;
    case "prompt":
      return [node.userPrompt, node.systemPrompt];
    case "agent":
      return [node.instructions, node.input];
    case "worker.dispatch":
      return [node.systemPrompt, node.instructions, node.input];
    case "adapter.run":
    case "adapter.race":
    case "adapter.parallel":
      return [node.systemPrompt, node.instructions, node.input];
    case "adapter.supervisor":
      return [node.systemPrompt, node.goal, node.input];
    case "fleet.dispatch":
      return [node.repos, node.task];
    case "fleet.gather":
      return node.source;
    case "fleet.contract-net":
      return [node.repos, node.task];
    case "shell.run":
      return [node.command, node.cwd];
    case "evidence.write":
    case "validate.schema":
      return node.source;
    case "knowledge.query":
      return node.filter;
    case "spdd.import_sources":
      return [node.spddRunId, node.sourceRefs];
    case "spdd.build_source_pack":
      return [node.spddRunId, node.sourceRefsKey, node.featureId];
    case "spdd.run_analysis":
      return [node.spddRunId, node.planArtifactId, node.sourceArtifactIds];
    case "spdd.generate_canvas":
      return [
        node.spddRunId,
        node.promptAssetVersionId,
        node.title,
        node.objective,
      ];
    case "spdd.validate_canvas":
    case "spdd.review_canvas":
    case "spdd.project_plan":
    case "spdd.scan_drift":
      return [node.spddRunId, node.promptAssetVersionId];
    case "spdd.arm_dispatch":
      return [node.spddRunId, node.planRunId];
    case "spdd.run_validation":
      return [
        node.spddRunId,
        node.planRunId,
        node.executionRunId,
        node.reviewerId,
      ];
    case "spdd.collect_proof":
      return [node.spddRunId, node.planRunId, node.taskId];
    case "spdd.create_sync_proposal":
      return [node.spddRunId, node.driftFindingIdsKey];
    case "spdd.agent_swarm":
      return [node.spddRunId, node.subTasks];
    default:
      return undefined;
  }
}

function classificationFromValue(
  value: unknown,
  bindings: FlowReferenceClassificationBindings,
  ports: FlowReferencePortClassificationBindings,
): FlowDataClassification | undefined {
  if (typeof value === "string") {
    return classificationFromTemplate(value, bindings, ports);
  }
  if (Array.isArray(value)) {
    return value.reduce<FlowDataClassification | undefined>(
      (current, nested) =>
        mergeFlowDataClassification(
          current,
          classificationFromValue(nested, bindings, ports),
        ),
      undefined,
    );
  }
  if (value === null || typeof value !== "object") return undefined;
  return Object.values(value as Record<string, unknown>).reduce<
    FlowDataClassification | undefined
  >(
    (current, nested) =>
      mergeFlowDataClassification(
        current,
        classificationFromValue(nested, bindings, ports),
      ),
    undefined,
  );
}

function classificationFromTemplate(
  source: string,
  bindings: FlowReferenceClassificationBindings,
  ports: FlowReferencePortClassificationBindings,
): FlowDataClassification | undefined {
  const analysis = analyzeFlowTemplateReferences(source);
  return analysis.references.reduce<FlowDataClassification | undefined>(
    (current, reference) =>
      mergeFlowDataClassification(
        current,
        classificationForReference(reference, bindings, ports),
      ),
    undefined,
  );
}

function classificationFromBareOrTemplate(
  source: string,
  bindings: FlowReferenceClassificationBindings,
  ports: FlowReferencePortClassificationBindings,
): FlowDataClassification | undefined {
  const template = classificationFromTemplate(source, bindings, ports);
  if (template !== undefined || !CANONICAL_BARE_REFERENCE.test(source.trim())) {
    return template;
  }
  const parsed = parseFlowReferenceExpression(`{{ ${source.trim()} }}`);
  return parsed.reference === undefined
    ? undefined
    : classificationForReference(parsed.reference, bindings, ports);
}

function classificationFromStateKeyOrTemplate(
  source: string,
  bindings: FlowReferenceClassificationBindings,
  ports: FlowReferencePortClassificationBindings,
): FlowDataClassification | undefined {
  const template = classificationFromTemplate(source, bindings, ports);
  if (source.includes("{{") || source.includes("}}")) return template;
  return bindings["state"]?.[source];
}

function redactClassification(
  classification: FlowDataClassification | undefined,
): FlowDataClassification | undefined {
  if (classification === "sensitive" || classification === "secret") {
    return "internal";
  }
  return classification;
}

function flattenNodes(root: FlowNode): FlowNode[] {
  const nodes: FlowNode[] = [];
  const visit = (node: FlowNode): void => {
    nodes.push(node);
    for (const child of childNodes(node)) visit(child);
  };
  visit(root);
  return nodes;
}

function childNodes(node: FlowNode): readonly FlowNode[] {
  switch (node.type) {
    case "sequence":
      return node.nodes;
    case "for_each":
    case "persona":
    case "route":
    case "loop":
      return node.body;
    case "branch":
      return [...node.then, ...(node.else ?? [])];
    case "parallel":
      return node.branches.flat();
    case "approval":
      return [...node.onApprove, ...(node.onReject ?? [])];
    case "try_catch":
      return [...node.body, ...node.catch];
    default:
      return [];
  }
}

function countOutputKeys(nodes: readonly FlowNode[]): number {
  return nodes.reduce((count, node) => {
    if (node.type === "set") return count + Object.keys(node.assign).length;
    if (node.type === "for_each") {
      return (
        count +
        1 +
        (node.collect === undefined ? 0 : 1) +
        (node.accumulator === undefined ? 0 : 1)
      );
    }
    return count + (stateOutputKeyForClassification(node) === undefined ? 0 : 1);
  }, 0);
}
