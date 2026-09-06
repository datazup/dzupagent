import { describe, expect, it } from "vitest";
import { PipelineCheckpointSchema } from "../pipeline-serialization.js";

function checkpoint() {
  return { pipelineId: "p", pipelineRunId: "run", version: 1, schemaVersion: "1.0.0", completedNodeIds: [], state: {}, createdAt: new Date(0).toISOString(),
    loopState: { items: { iteration: 0, itemFrames: { "0": { itemIndex: 0, nextBodyNodeIndex: 0, bodyResults: {}, graph: {
      schema: "dzupagent/for-each-item-graph/v1", loopNodeId: "items", itemIndex: 0,
      itemValueDigest: `sha256:${"a".repeat(64)}`, state: { item: 1 },
      frame: { completed: false, nextNodeId: "choose", completedNodeIds: [], nodeResults: {}, nodeIdempotencyKeys: {} },
    } } } } } };
}
describe("for_each graph receipt compatibility", () => {
  it("roundtrips the graph receipt without dropping item state", () => {
    const cp = checkpoint();
    expect(PipelineCheckpointSchema.parse(JSON.parse(JSON.stringify(cp)))).toEqual(cp);
  });
  it("rejects unknown receipt versions and malformed graph frames", () => {
    const cp = checkpoint(); cp.loopState.items.itemFrames["0"].graph.schema = "future";
    expect(PipelineCheckpointSchema.safeParse(cp).success).toBe(false);
    const bad = checkpoint(); bad.loopState.items.itemFrames["0"].graph.frame.completed = true;
    expect(PipelineCheckpointSchema.safeParse(bad).success).toBe(false);
  });
  it("keeps legacy flat frame bytes unchanged", () => {
    const cp = checkpoint();
    const { graph: _graph, ...flat } = cp.loopState.items.itemFrames["0"];
    const legacy = { ...cp, loopState: { items: { iteration: 0, itemFrames: { "0": flat } } } };
    expect(PipelineCheckpointSchema.parse(legacy)).toEqual(legacy);
  });
});
