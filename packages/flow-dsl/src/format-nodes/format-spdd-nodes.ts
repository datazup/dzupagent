import {
  formatScalar,
  indentFor,
  pushCommon,
  quote,
  type FormatContext,
  type NodeOf,
} from "./format-helpers.js";

/** SPDD (spec-plan-dispatch-drift) pipeline node categories. */
export function formatSpddNode(
  ctx: FormatContext,
  node: NodeOf<
    | "spdd.import_sources"
    | "spdd.build_source_pack"
    | "spdd.run_analysis"
    | "spdd.generate_canvas"
    | "spdd.validate_canvas"
    | "spdd.review_canvas"
    | "spdd.project_plan"
    | "spdd.arm_dispatch"
    | "spdd.run_validation"
    | "spdd.collect_proof"
    | "spdd.scan_drift"
    | "spdd.create_sync_proposal"
    | "spdd.agent_swarm"
  >,
  indentLevel: number
): void {
  const { lines } = ctx;
  const indent = indentFor(indentLevel);
  const childIndent = indentFor(indentLevel + 2);
  switch (node.type) {
    case "spdd.import_sources":
      lines.push(`${indent}- spdd.import_sources:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}spddRunId: ${node.spddRunId}`);
      lines.push(`${childIndent}sourceRefs: ${formatScalar(node.sourceRefs)}`);
      lines.push(`${childIndent}outputKey: ${node.outputKey}`);
      return;
    case "spdd.build_source_pack":
      lines.push(`${indent}- spdd.build_source_pack:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}spddRunId: ${node.spddRunId}`);
      lines.push(`${childIndent}sourceRefsKey: ${node.sourceRefsKey}`);
      if (node.featureId)
        lines.push(`${childIndent}featureId: ${node.featureId}`);
      lines.push(`${childIndent}outputKey: ${node.outputKey}`);
      return;
    case "spdd.run_analysis":
      lines.push(`${indent}- spdd.run_analysis:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}spddRunId: ${node.spddRunId}`);
      lines.push(`${childIndent}planArtifactId: ${node.planArtifactId}`);
      if (node.sourceArtifactIds && node.sourceArtifactIds.length > 0) {
        lines.push(
          `${childIndent}sourceArtifactIds: [${node.sourceArtifactIds
            .map(quote)
            .join(", ")}]`
        );
      }
      lines.push(`${childIndent}outputKey: ${node.outputKey}`);
      return;
    case "spdd.generate_canvas":
      lines.push(`${indent}- spdd.generate_canvas:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}spddRunId: ${node.spddRunId}`);
      lines.push(
        `${childIndent}promptAssetVersionId: ${node.promptAssetVersionId}`
      );
      if (node.title) lines.push(`${childIndent}title: ${quote(node.title)}`);
      if (node.objective)
        lines.push(`${childIndent}objective: ${quote(node.objective)}`);
      lines.push(`${childIndent}outputKey: ${node.outputKey}`);
      return;
    case "spdd.validate_canvas":
      lines.push(`${indent}- spdd.validate_canvas:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}spddRunId: ${node.spddRunId}`);
      lines.push(
        `${childIndent}promptAssetVersionId: ${node.promptAssetVersionId}`
      );
      lines.push(`${childIndent}outputKey: ${node.outputKey}`);
      return;
    case "spdd.review_canvas":
      lines.push(`${indent}- spdd.review_canvas:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}spddRunId: ${node.spddRunId}`);
      lines.push(
        `${childIndent}promptAssetVersionId: ${node.promptAssetVersionId}`
      );
      lines.push(`${childIndent}outputKey: ${node.outputKey}`);
      return;
    case "spdd.project_plan":
      lines.push(`${indent}- spdd.project_plan:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}spddRunId: ${node.spddRunId}`);
      lines.push(
        `${childIndent}promptAssetVersionId: ${node.promptAssetVersionId}`
      );
      lines.push(`${childIndent}outputKey: ${node.outputKey}`);
      return;
    case "spdd.arm_dispatch":
      lines.push(`${indent}- spdd.arm_dispatch:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}spddRunId: ${node.spddRunId}`);
      lines.push(`${childIndent}planRunId: ${node.planRunId}`);
      lines.push(`${childIndent}outputKey: ${node.outputKey}`);
      return;
    case "spdd.run_validation":
      lines.push(`${indent}- spdd.run_validation:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}spddRunId: ${node.spddRunId}`);
      lines.push(`${childIndent}planRunId: ${node.planRunId}`);
      lines.push(`${childIndent}executionRunId: ${node.executionRunId}`);
      if (node.reviewerId)
        lines.push(`${childIndent}reviewerId: ${node.reviewerId}`);
      lines.push(`${childIndent}outputKey: ${node.outputKey}`);
      return;
    case "spdd.collect_proof":
      lines.push(`${indent}- spdd.collect_proof:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}spddRunId: ${node.spddRunId}`);
      lines.push(`${childIndent}planRunId: ${node.planRunId}`);
      if (node.taskId) lines.push(`${childIndent}taskId: ${node.taskId}`);
      lines.push(`${childIndent}outputKey: ${node.outputKey}`);
      return;
    case "spdd.scan_drift":
      lines.push(`${indent}- spdd.scan_drift:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}spddRunId: ${node.spddRunId}`);
      lines.push(
        `${childIndent}promptAssetVersionId: ${node.promptAssetVersionId}`
      );
      lines.push(`${childIndent}outputKey: ${node.outputKey}`);
      return;
    case "spdd.create_sync_proposal":
      lines.push(`${indent}- spdd.create_sync_proposal:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}spddRunId: ${node.spddRunId}`);
      lines.push(
        `${childIndent}driftFindingIdsKey: ${node.driftFindingIdsKey}`
      );
      lines.push(`${childIndent}outputKey: ${node.outputKey}`);
      return;
    case "spdd.agent_swarm":
      lines.push(`${indent}- spdd.agent_swarm:`);
      pushCommon(lines, node, indentLevel + 2);
      lines.push(`${childIndent}spddRunId: ${node.spddRunId}`);
      lines.push(`${childIndent}subTasks: ${formatScalar(node.subTasks)}`);
      lines.push(`${childIndent}outputKey: ${node.outputKey}`);
      return;
    default: {
      const _exhaustive: never = node;
      void _exhaustive;
    }
  }
}
