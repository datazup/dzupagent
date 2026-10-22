import { FLOW_NODE_KINDS } from "@dzupagent/flow-ast";

import { FLOW_NODE_CAPABILITY_REGISTRY } from "./node-registry.js";
import {
  FLOW_VALIDATION_PROFILES,
  TARGET_CAPABILITY_MANIFESTS,
} from "./target-manifests.js";
import type {
  FlowConformanceMatrix,
  FlowConformanceMatrixOptions,
  FlowHostConformanceColumn,
  FlowNodeCapabilityDescriptor,
  HostCapabilityManifest,
} from "./types.js";

export function generateFlowConformanceMatrix(
  options: FlowConformanceMatrixOptions = {}
): FlowConformanceMatrix {
  const nodes = FLOW_NODE_KINDS.map(
    (kind) => FLOW_NODE_CAPABILITY_REGISTRY[kind]
  );
  return {
    schema: "dzupagent.flowConformanceMatrix/v1",
    generatedFrom: "FLOW_NODE_KIND_REGISTRY",
    ...(options.provenance !== undefined
      ? {
          provenance: {
            sourceRevision: options.provenance.sourceRevision,
            committedAt: options.provenance.committedAt,
          },
        }
      : {}),
    nodes,
    targets: Object.values(TARGET_CAPABILITY_MANIFESTS),
    validationProfiles: Object.values(FLOW_VALIDATION_PROFILES),
    ...(options.hosts !== undefined
      ? { hosts: hostColumns(nodes, options.hosts) }
      : {}),
  };
}

function hostColumns(
  nodes: FlowNodeCapabilityDescriptor[],
  hosts: HostCapabilityManifest[]
): FlowHostConformanceColumn[] {
  const seen = new Set<string>();
  return hosts.map((host) => {
    if (seen.has(host.host)) {
      throw new Error(
        `Flow conformance matrix: duplicate host "${host.host}"; each host column needs a unique host id.`
      );
    }
    seen.add(host.host);
    return {
      host: host.host,
      version: host.version,
      nodes: nodes.map((node) => ({
        kind: node.kind,
        executable: isExecutableOnHost(node, host),
      })),
    };
  });
}

/**
 * Mirrors `resolveHostReadiness` (default profile) for a flow made of this one
 * kind on its current route: the host must accept the route target, declare
 * the target's capability and every runtime capability of the kind, and the
 * kind must not be unsupported.
 */
function isExecutableOnHost(
  node: FlowNodeCapabilityDescriptor,
  host: HostCapabilityManifest
): boolean {
  const capabilities = new Set(host.capabilities);
  return (
    node.status !== "unsupported" &&
    host.targets.includes(node.currentRoute) &&
    capabilities.has(TARGET_CAPABILITY_MANIFESTS[node.currentRoute].capability) &&
    node.runtimeCapabilities.every((capability) => capabilities.has(capability))
  );
}

export function renderFlowConformanceMatrixMarkdown(
  matrix: FlowConformanceMatrix = generateFlowConformanceMatrix()
): string {
  const lines = [
    "# Flow Node And Target Conformance Matrix",
    "",
    "> Generated from the public `FLOW_NODE_KIND_REGISTRY` and the compiler capability manifests. Do not edit by hand.",
    "",
    `Schema: \`${matrix.schema}\``,
    "",
    ...(matrix.provenance !== undefined
      ? [
          `Source revision: \`${matrix.provenance.sourceRevision}\` (committed ${matrix.provenance.committedAt})`,
          "",
        ]
      : []),
    "## Nodes",
    "",
    "| Node | Parse | Validate | Status | Lowering | Current route | Recommended profile | Owner | Runtime requirements | Notes |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const node of matrix.nodes) {
    lines.push(
      `| \`${node.kind}\` | yes | yes | ${node.status} | ${node.lowering} | \`${
        node.currentRoute
      }\` | \`${node.recommendedProfile}\` | ${node.owner} | ${
        node.runtimeCapabilities.map((item) => `\`${item}\``).join("<br>") ||
        "none"
      } | ${escapeTableCell(node.notes ?? "")} |`
    );
  }

  lines.push("", "## Targets", "");
  lines.push(
    "| Target | Capability | Route features | Execution | Durability | Limitations |",
    "| --- | --- | --- | --- | --- | --- |"
  );
  for (const target of matrix.targets) {
    lines.push(
      `| \`${target.target}\` | \`${
        target.capability
      }\` | ${target.routeFeatures.join(", ")} | ${
        target.executionModel
      } | ${target.durabilityModes.join(", ")} | ${target.limitations
        .map((item) => `\`${item.code}\`: ${escapeTableCell(item.message)}`)
        .join("<br>")} |`
    );
  }

  lines.push("", "## Validation profiles", "");
  lines.push(
    "| Profile | Gates | Host manifest required |",
    "| --- | --- | --- |"
  );
  for (const profile of matrix.validationProfiles) {
    lines.push(
      `| \`${profile.id}\` | ${profile.gates
        .map((gate) => `\`${gate}\``)
        .join(" → ")} | ${profile.requiresHostManifest ? "yes" : "no"} |`
    );
  }

  if (matrix.hosts !== undefined && matrix.hosts.length > 0) {
    const hosts = matrix.hosts;
    lines.push("", "## Host executability", "");
    lines.push(
      "A node kind is executable on a host when the host accepts the kind's current route target and declares that target's capability and every runtime requirement of the kind, as `resolveHostReadiness` checks for a flow of that kind alone.",
      ""
    );
    lines.push(
      `Hosts: ${hosts
        .map((host) => `\`${host.host}\` ${host.version}`)
        .join(", ")}`,
      ""
    );
    lines.push(
      `| Node | ${hosts.map((host) => `\`${host.host}\``).join(" | ")} |`,
      `| --- | ${hosts.map(() => "---").join(" | ")} |`
    );
    for (const node of matrix.nodes) {
      const cells = hosts.map((host) => {
        const cell = host.nodes.find((item) => item.kind === node.kind);
        if (cell === undefined) {
          throw new Error(
            `Flow conformance matrix: host "${host.host}" has no cell for node kind "${node.kind}".`
          );
        }
        return cell.executable ? "yes" : "no";
      });
      lines.push(`| \`${node.kind}\` | ${cells.join(" | ")} |`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function escapeTableCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}
