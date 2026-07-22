import { FLOW_NODE_KINDS } from "@dzupagent/flow-ast";

import { FLOW_NODE_CAPABILITY_REGISTRY } from "./node-registry.js";
import {
  FLOW_VALIDATION_PROFILES,
  TARGET_CAPABILITY_MANIFESTS,
} from "./target-manifests.js";
import type { FlowConformanceMatrix } from "./types.js";

export function generateFlowConformanceMatrix(): FlowConformanceMatrix {
  return {
    schema: "dzupagent.flowConformanceMatrix/v1",
    generatedFrom: "FLOW_NODE_KIND_REGISTRY",
    nodes: FLOW_NODE_KINDS.map((kind) => FLOW_NODE_CAPABILITY_REGISTRY[kind]),
    targets: Object.values(TARGET_CAPABILITY_MANIFESTS),
    validationProfiles: Object.values(FLOW_VALIDATION_PROFILES),
  };
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

  return `${lines.join("\n")}\n`;
}

function escapeTableCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}
