import { createHash } from "node:crypto";

import type {
  FlowDataClassification,
  FlowNode,
  ResolvedTool,
} from "@dzupagent/flow-ast";

import type {
  FlowReferenceBindings,
} from "@dzupagent/flow-ast/expressions";
import type {
  FlowReferenceClassificationBindings,
  FlowReferencePortBindings,
  FlowReferencePortClassificationBindings,
  FlowReferenceTypeBindings,
} from "./types.js";
import {
  FLOW_COMPILED_CLASSIFICATION_ENVELOPE_SCHEMA,
  type FlowCompiledClassificationEnvelope,
  type FlowCompiledClassifiedPort,
  type FlowCompiledClassifiedValue,
  type FlowCompiledIntegrationObligation,
  type FlowCompiledPrimitiveObligation,
} from "./classification-envelope-types.js";
import { resolveBuiltInPrimitiveDefinition } from "./stages/primitive-reference-ports.js";

export interface FlowClassificationEnvelopeSnapshot {
  readonly referenceBindings: FlowReferenceBindings;
  readonly referenceTypeBindings: FlowReferenceTypeBindings;
  readonly referencePortBindings: FlowReferencePortBindings;
  readonly referenceClassificationBindings: FlowReferenceClassificationBindings;
  readonly referencePortClassificationBindings: FlowReferencePortClassificationBindings;
}

/** Build the immutable classification and primitive-obligation projection. */
export function createFlowCompiledClassificationEnvelope(
  root: FlowNode,
  compileId: string,
  semanticHash: string,
  snapshot: FlowClassificationEnvelopeSnapshot,
  resolvedTools: ReadonlyMap<string, ResolvedTool> = new Map(),
): FlowCompiledClassificationEnvelope {
  const values = Object.freeze(classifiedValues(snapshot));
  const ports = Object.freeze(classifiedPorts(snapshot));
  const primitives = Object.freeze(primitiveObligations(root, snapshot));
  const integrations = Object.freeze(
    integrationObligations(root, resolvedTools),
  );
  const unclassifiedReferences = Object.freeze(
    collectUnclassifiedReferences(snapshot),
  );
  const classificationComplete = unclassifiedReferences.length === 0;
  const classificationHash = hashFlowCompiledClassificationEnvelopePayload({
    schema: FLOW_COMPILED_CLASSIFICATION_ENVELOPE_SCHEMA,
    semanticHash,
    classificationComplete,
    unclassifiedReferences,
    values,
    ports,
    primitives,
    integrations,
  });
  const envelope: FlowCompiledClassificationEnvelope = {
    schema: FLOW_COMPILED_CLASSIFICATION_ENVELOPE_SCHEMA,
    compileId,
    semanticHash,
    classificationHash,
    classificationComplete,
    unclassifiedReferences,
    values,
    ports,
    primitives,
    integrations,
  };
  return Object.freeze(envelope);
}

function integrationObligations(
  root: FlowNode,
  resolvedTools: ReadonlyMap<string, ResolvedTool>,
): FlowCompiledIntegrationObligation[] {
  const nodeIds = new Map<string, string>();
  visitNodes(root, "root", (node, nodePath) => {
    if (node.id !== undefined) nodeIds.set(nodePath, node.id);
  });
  return [...resolvedTools.entries()]
    .flatMap(([nodePath, tool]) => {
      const policy = tool.securityPolicy;
      if (policy === undefined) return [];
      const credential =
        policy.credential.mode === "handle-only"
          ? Object.freeze({
              mode: "handle-only" as const,
              inputPaths: Object.freeze([...policy.credential.inputPaths]),
              resolverCapabilityRef:
                policy.credential.resolverCapabilityRef as string,
              allowedProviders: Object.freeze([
                ...policy.credential.allowedProviders,
              ]),
              requiredScopes: Object.freeze([
                ...policy.credential.requiredScopes,
              ]),
            })
          : undefined;
      return [
        Object.freeze({
          nodePath,
          ...(nodeIds.get(nodePath) === undefined
            ? {}
            : { nodeId: nodeIds.get(nodePath) as string }),
          toolRef: tool.ref,
          toolKind: tool.kind,
          policyHash: hashFlowToolSecurityPolicy(policy),
          acceptedInputClassifications: Object.freeze([
            ...policy.acceptedInputClassifications,
          ]),
          ...(credential === undefined ? {} : { credential }),
          outputClassification: policy.outputClassification,
          effectClasses: Object.freeze([...policy.effectClasses]),
          evidence: Object.freeze({
            required: Object.freeze([...policy.evidence.required]),
            classification: policy.evidence.classification,
            rawContent: policy.evidence.rawContent,
          }),
        }),
      ];
    })
    .sort((left, right) => left.nodePath.localeCompare(right.nodePath));
}

function collectUnclassifiedReferences(
  snapshot: FlowClassificationEnvelopeSnapshot,
): string[] {
  const unresolved = new Set<string>();
  for (const [root, names] of sortedEntries(snapshot.referenceBindings)) {
    if (root === "steps" || root === "loop") continue;
    for (const name of [...(names ?? [])].sort()) {
      if (snapshot.referenceClassificationBindings[root]?.[name] === undefined) {
        unresolved.add(`${root}.${name}`);
      }
    }
  }
  for (const [stepId, ports] of sortedEntries(snapshot.referencePortBindings)) {
    for (const port of Object.keys(ports ?? {}).sort()) {
      if (
        snapshot.referencePortClassificationBindings[stepId]?.[port] ===
        undefined
      ) {
        unresolved.add(`steps.${stepId}.${port}`);
      }
    }
  }
  return [...unresolved].sort((left, right) => left.localeCompare(right));
}

/** Attach the same immutable envelope to every object-shaped target artifact. */
export function attachFlowCompiledClassificationEnvelope(
  artifact: unknown,
  envelope: FlowCompiledClassificationEnvelope,
): void {
  if (typeof artifact !== "object" || artifact === null || Array.isArray(artifact)) {
    return;
  }
  Object.defineProperty(artifact, "classificationEnvelope", {
    value: envelope,
    enumerable: true,
    configurable: false,
    writable: false,
  });
}

function classifiedValues(
  snapshot: FlowClassificationEnvelopeSnapshot,
): FlowCompiledClassifiedValue[] {
  const values: FlowCompiledClassifiedValue[] = [];
  for (const [root, names] of sortedEntries(
    snapshot.referenceClassificationBindings,
  )) {
    for (const [name, classification] of sortedEntries(names ?? {})) {
      if (classification === undefined) continue;
      const valueType =
        snapshot.referenceTypeBindings[root]?.[name] ?? "unknown";
      values.push(
        Object.freeze({
          reference: `${root}.${name}`,
          root,
          name,
          classification,
          valueType,
          ...(valueType === "credential"
            ? {
                credential: Object.freeze({
                  form: "opaque-handle" as const,
                  resolution: "lease-only" as const,
                }),
              }
            : {}),
        }),
      );
    }
  }
  return values;
}

function classifiedPorts(
  snapshot: FlowClassificationEnvelopeSnapshot,
): FlowCompiledClassifiedPort[] {
  const ports: FlowCompiledClassifiedPort[] = [];
  for (const [stepId, stepPorts] of sortedEntries(
    snapshot.referencePortClassificationBindings,
  )) {
    for (const [port, classification] of sortedEntries(stepPorts ?? {})) {
      if (classification === undefined) continue;
      ports.push(
        Object.freeze({
          reference: `steps.${stepId}.${port}`,
          stepId,
          port,
          classification,
          valueType:
            snapshot.referencePortBindings[stepId]?.[port] ?? "unknown",
        }),
      );
    }
  }
  return ports;
}

function primitiveObligations(
  root: FlowNode,
  snapshot: FlowClassificationEnvelopeSnapshot,
): FlowCompiledPrimitiveObligation[] {
  const obligations: FlowCompiledPrimitiveObligation[] = [];
  visitNodes(root, "root", (node, nodePath) => {
    const definition = resolveBuiltInPrimitiveDefinition(node.type);
    if (definition === undefined) return;
    const redaction =
      definition.redactionRequiredAbove !== undefined ||
      definition.evidence.redactionReceiptRequired
        ? Object.freeze({
            ...(definition.redactionRequiredAbove === undefined
              ? {}
              : { requiredAbove: definition.redactionRequiredAbove }),
            ...(definition.evidence.redactionPolicyRef === undefined
              ? {}
              : { policyRef: definition.evidence.redactionPolicyRef }),
            receiptRequired: definition.evidence.redactionReceiptRequired,
            ...(definition.evidence.redactionReceiptSchema === undefined
              ? {}
              : {
                  receiptSchema:
                    definition.evidence.redactionReceiptSchema,
                }),
          })
        : undefined;
    const credential =
      definition.credentialInputs === "forbidden"
        ? undefined
        : Object.freeze({
            mode: definition.credentialInputs,
            inputPaths: Object.freeze([...definition.credentialInputPaths]),
            ...(definition.credentialResolverCapabilityRef === undefined
              ? {}
              : {
                  resolverCapabilityRef:
                    definition.credentialResolverCapabilityRef,
                }),
            ...(node.type !== "http" || node.auth === undefined
              ? {}
              : {
                  allowedProviders: Object.freeze([node.auth.provider]),
                  requiredScopes: Object.freeze([...node.auth.scopes]),
                  httpAuth: Object.freeze({
                    scheme: node.auth.scheme,
                    ...(node.auth.headerName === undefined
                      ? {}
                      : { headerName: node.auth.headerName }),
                  }),
                }),
          });
    obligations.push(
      Object.freeze({
        nodePath,
        ...(node.id === undefined ? {} : { nodeId: node.id }),
        primitiveRef: definition.ref,
        requiredCapabilities: Object.freeze(
          [...definition.requiresCapabilities].sort((left, right) =>
            left.localeCompare(right),
          ),
        ),
        acceptedInputClassifications: Object.freeze([
          ...definition.acceptedInputClassifications,
        ]),
        ...(credential === undefined ? {} : { credential }),
        ...(redaction === undefined ? {} : { redaction }),
        outputs: Object.freeze(
          Object.entries(definition.outputPorts)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([port, output]) =>
              Object.freeze({
                port,
                expectedClassification: output.classification,
                effectiveClassification: effectiveOutputClassification(
                  node.id,
                  port,
                  output.classification,
                  snapshot,
                ),
                cardinality: output.cardinality,
                persistence: output.persistence,
              }),
            ),
        ),
      }),
    );
  });
  return obligations.sort((left, right) =>
    left.nodePath.localeCompare(right.nodePath),
  );
}

function effectiveOutputClassification(
  nodeId: string | undefined,
  port: string,
  fallback: FlowDataClassification,
  snapshot: FlowClassificationEnvelopeSnapshot,
): FlowDataClassification {
  if (nodeId === undefined) return fallback;
  return (
    snapshot.referencePortClassificationBindings[nodeId]?.[port] ?? fallback
  );
}

function visitNodes(
  node: FlowNode,
  path: string,
  visit: (node: FlowNode, path: string) => void,
): void {
  visit(node, path);
  switch (node.type) {
    case "sequence":
      visitList(node.nodes, `${path}.nodes`, visit);
      return;
    case "for_each":
    case "persona":
    case "route":
    case "loop":
      visitList(node.body, `${path}.body`, visit);
      return;
    case "branch":
      visitList(node.then, `${path}.then`, visit);
      visitList(node.else ?? [], `${path}.else`, visit);
      return;
    case "parallel":
      node.branches.forEach((branch, branchIndex) =>
        visitList(branch, `${path}.branches[${branchIndex}]`, visit),
      );
      return;
    case "approval":
      visitList(node.onApprove, `${path}.onApprove`, visit);
      visitList(node.onReject ?? [], `${path}.onReject`, visit);
      return;
    case "try_catch":
      visitList(node.body, `${path}.body`, visit);
      visitList(node.catch, `${path}.catch`, visit);
      return;
    default:
      return;
  }
}

function visitList(
  nodes: readonly FlowNode[],
  path: string,
  visit: (node: FlowNode, path: string) => void,
): void {
  nodes.forEach((node, index) => visitNodes(node, `${path}[${index}]`, visit));
}

function sortedEntries<T>(
  value: Readonly<Record<string, T | undefined>>,
): Array<[string, T | undefined]> {
  return Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right),
  );
}

export function hashFlowCompiledClassificationEnvelopePayload(
  value: unknown,
): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(stableStringify(value))
    .digest("hex")}`;
}

export function hashFlowToolSecurityPolicy(
  value: unknown,
): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(stableStringify(value))
    .digest("hex")}`;
}

function stableStringify(value: unknown, seen = new WeakSet<object>()): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (seen.has(value)) throw new TypeError("cannot hash cyclic envelope");
  seen.add(value);
  if (Array.isArray(value)) {
    const serialized = `[${value
      .map((item) => stableStringify(item, seen))
      .join(",")}]`;
    seen.delete(value);
    return serialized;
  }
  const record = value as Record<string, unknown>;
  const serialized = `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${stableStringify(record[key], seen)}`,
    )
    .join(",")}}`;
  seen.delete(value);
  return serialized;
}
