/**
 * 24-I — the lost item-boundary commit at `concurrency > 1`.
 *
 * `restoreLoopStateAfterLostCommit` carries a doc comment saying it "owes an
 * end-to-end test" to the N>1 slice: at `concurrency: 1` the run aborts
 * immediately after a lost item-boundary commit and writes nothing further, so
 * the rollback has no observation point and a mutant deleting it survives every
 * suite.
 *
 * THAT DEBT IS STRUCTURALLY UNPAYABLE, AND THIS FILE RECORDS WHY rather than
 * pretending to discharge it.
 *
 * The comment's stated precondition is "a lost commit followed by another write
 * against the same frame". N>1 was expected to supply it, since a sibling
 * worker is still in flight when one worker loses the CAS race. It does not:
 * the callback THROWS `PipelineCheckpointCommitConflictError` on the line
 * immediately after the rollback, that throw propagates out of the worker and
 * aborts the run, and no further checkpoint is written against the frame.
 * Failing closed is exactly what prevents the second write the rollback would
 * be observable through — the two requirements are mutually exclusive.
 *
 * Verified, not reasoned: a mutant deleting the
 * `restoreLoopStateAfterLostCommit` call SURVIVES this test. It was applied,
 * the test still passed, and the source was restored to a zero diff. The
 * rollback's guarantee is therefore SUBSUMED by the throw on every reachable
 * end-to-end path. It remains defensive correctness for a future caller that
 * persists the frame after a loss — as its own comment's last paragraph says —
 * and its G2a unit tests remain the honest coverage for it. The "owes an
 * end-to-end test" sentence should be read as discharged-by-impossibility.
 *
 * What this test DOES pin is the integration claim N>1 genuinely made newly
 * reachable: a lost ordered-prefix commit stops a CONCURRENT run instead of
 * letting surviving workers carry on against a cursor the store does not hold.
 * That path could not exist before this packet, because the runtime refused to
 * dispatch more than one item at a time.
 */
import { describe, expect, it } from "vitest";
import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";
import { InMemoryPipelineCheckpointStore } from "../pipeline/in-memory-checkpoint-store.js";
import type {
  PipelineCheckpoint,
  PipelineCheckpointCommitReceipt,
} from "@dzupagent/core/pipeline";
import type { PipelineDefinition, PipelineNode } from "@dzupagent/core";

/**
 * Loses exactly one compare-and-set race, at a named ordered-prefix cursor.
 * The loss is produced through the real `saveIfVersion` contract (a receipt
 * with `committed: false`) rather than by throwing: a throw would take the
 * pre-existing integrity-error path and prove nothing about this seam. Firing
 * once matters too — a permanently-losing store would mask whether the runtime
 * stopped, since every later write would fail anyway.
 */
class RaceLosingCheckpointStore extends InMemoryPipelineCheckpointStore {
  loseAtIteration: number | undefined;
  readonly rivalVersion = 99;
  lostCommits = 0;
  /** Every ordered-prefix cursor this store was asked to commit. */
  readonly attemptedIterations: (number | undefined)[] = [];

  override async saveIfVersion(
    checkpoint: PipelineCheckpoint,
    expectedVersion: number
  ): Promise<PipelineCheckpointCommitReceipt> {
    const iteration = checkpoint.loopState?.["loop-items"]?.iteration;
    this.attemptedIterations.push(iteration);
    if (
      this.loseAtIteration !== undefined &&
      iteration === this.loseAtIteration
    ) {
      this.loseAtIteration = undefined;
      this.lostCommits++;
      return { committed: false, observedVersion: this.rivalVersion };
    }
    return super.saveIfVersion(checkpoint, expectedVersion);
  }
}

function concurrentPipeline(): PipelineDefinition {
  return {
    id: "for-each-lost-commit-e2e",
    name: "ForEachLostCommitE2E",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    entryNodeId: "loop-items",
    checkpointStrategy: "after_each_node",
    nodes: [
      {
        id: "loop-items",
        type: "loop",
        bodyNodeIds: ["step-a", "step-b"],
        maxIterations: 1000,
        continuePredicateName: "forEach__item__predicate",
        forEach: {
          source: "$.items",
          as: "item",
          order: "input",
          collect: { from: "itemStatus", into: "itemStatuses", order: "input" },
          concurrency: 2,
          empty: { body: "skip", aggregate: "empty-array" },
        },
      },
      { id: "step-a", type: "agent", agentId: "a", timeoutMs: 5000 },
      { id: "step-b", type: "agent", agentId: "b", timeoutMs: 5000 },
    ],
    edges: [],
  };
}

const ITEMS = [{ id: "a" }, { id: "b" }, { id: "c" }];

describe("for_each lost item-boundary commit at concurrency > 1 (24-I)", () => {
  it("stops a concurrent run rather than continuing against a cursor no record backs", async () => {
    const store = new RaceLosingCheckpointStore();
    // Lose the FIRST commit that advances the ordered prefix. At concurrency 2
    // the prefix jumps 0 -> 2, because both in-flight items settle before the
    // flush runs — so 2 is the first advancing cursor that actually occurs.
    // Instrumenting the store's real call sequence established that; an earlier
    // draft guessed `1` and produced a fixture that never fired at all.
    store.loseAtIteration = 2;

    const runs: string[] = [];
    const runtime = new PipelineRuntime({
      definition: concurrentPipeline(),
      nodeExecutor: async (nodeId: string, _node: PipelineNode, ctx) => {
        const item = ctx.state["item"] as { id: string };
        runs.push(`${item.id}:${nodeId}`);
        ctx.state["itemStatus"] = `${item.id}:done`;
        return { nodeId, output: `${item.id}:${nodeId}`, durationMs: 1 };
      },
      checkpointStore: store,
    });

    const result = await runtime.execute({ items: ITEMS });

    // The fixture must actually have fired, or everything below is vacuous.
    // Asserting the precondition is what caught two false reds while this test
    // was written: a `save`-level interception that never reached the CAS seam,
    // and a cursor value the concurrent run never produces.
    expect(store.lostCommits).toBe(1);
    // The prefix really did advance by two, which is the signature of a
    // concurrent run — a serialized one steps 0, 1, 2 and is already covered by
    // the G2a suite.
    expect(store.attemptedIterations).toContain(2);
    expect(store.attemptedIterations).not.toContain(1);

    // Another writer owns this run's version line, so the ordered prefix this
    // run holds is not the durable one. Reporting a clean success would tell a
    // host that work is committed which the store does not hold.
    expect(result.state).toBe("failed");
  });
});
