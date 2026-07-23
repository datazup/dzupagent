import { generateFlowSemanticCatalog } from "./generate.js";
import type { FlowSemanticCatalog } from "./types.js";

export function renderFlowSemanticCatalogMarkdown(
  catalog: FlowSemanticCatalog = generateFlowSemanticCatalog(),
): string {
  const lines = [
    "# Flow Semantic Catalog",
    "",
    "> Generated from the framework node, capability, primitive, fragment, and execution-leaf registries. Do not edit by hand.",
    "",
    `Schema: \`${catalog.schema}\``,
    `Status: **${catalog.status}**`,
    "",
    `- Nodes: ${catalog.summary.nodes}`,
    `- Primitives: ${catalog.summary.primitives}`,
    `- Fragments: ${catalog.summary.fragments}`,
    `- Execution leaves: ${catalog.summary.executionLeaves}`,
    "",
    "## Nodes",
    "",
    "| Node | Class | Status | Lowering | Profile | Owner | Primitive refs | Execution leaf |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const node of catalog.nodes) {
    lines.push(
      `| \`${node.kind}\` | ${node.classification} | ${node.status} | ${node.lowering} | \`${node.profile}\` | ${node.owner} | ${
        node.primitiveRefs.map(code).join("<br>") || "none"
      } | ${node.executionLeaf === undefined ? "none" : code(node.executionLeaf)} |`,
    );
  }

  lines.push(
    "",
    "## Primitives",
    "",
    "| Primitive | Category | Execution | Target | Effect | Idempotency | Expands to |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const primitive of catalog.primitives) {
    lines.push(
      `| \`${primitive.kind}@${primitive.version}\` | ${primitive.category} | ${
        primitive.execution.mode
      } | ${
        primitive.execution.target === undefined
          ? "none"
          : code(primitive.execution.target)
      } | ${primitive.effectClass ?? "unspecified"} | ${
        primitive.idempotency ?? "unspecified"
      } | ${
        primitive.expandsTo.map((target) => code(target.authored)).join("<br>") ||
        "none"
      } |`,
    );
  }

  lines.push(
    "",
    "## Fragments",
    "",
    "| Fragment | Catalog | Params | Exports | Node kinds | Fragment refs |",
    "| --- | --- | --- | --- | --- | --- |",
  );
  for (const fragment of catalog.fragments) {
    lines.push(
      `| \`${fragment.id}@${fragment.version}\` | \`${fragment.catalogRef}\` | ${
        fragment.params.map(code).join("<br>") || "none"
      } | ${fragment.exports.map(code).join("<br>") || "none"} | ${
        fragment.nodeKinds.map(code).join("<br>") || "none"
      } | ${fragment.fragmentRefs.map(code).join("<br>") || "none"} |`,
    );
  }

  lines.push(
    "",
    "## Execution leaves",
    "",
    "| Execution leaf | Node | Primitive refs | Runtime capability |",
    "| --- | --- | --- | --- |",
  );
  for (const leaf of catalog.executionLeaves) {
    lines.push(
      `| \`${leaf.kind}\` | \`${leaf.nodeKind}\` | ${
        leaf.primitiveRefs.map(code).join("<br>") || "none"
      } | \`${leaf.runtimeCapability}\` |`,
    );
  }

  lines.push("", "## Diagnostics", "");
  if (catalog.diagnostics.length === 0) {
    lines.push("No catalog drift diagnostics.");
  } else {
    for (const diagnostic of catalog.diagnostics) {
      lines.push(
        `- \`${diagnostic.code}\` at \`${diagnostic.path}\`: ${diagnostic.message}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

function code(value: string): string {
  return `\`${value.replaceAll("`", "\\`")}\``;
}
