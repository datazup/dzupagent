import { describe, it, expect } from "vitest";
import type {
  FanoutRuntimeEvent,
  SubagentRuntimeEvent,
} from "@dzupagent/adapter-types";
import type {
  FanoutRuntimeDzupEvent,
  SubagentRuntimeDzupEvent,
} from "@dzupagent/core";

/**
 * Contract-drift guard (Spec 03 AC4b): the canonical event unions in
 * `@dzupagent/adapter-types` and their mirrors in `@dzupagent/core`
 * (`event-types-shared.ts`) are kept in sync BY INTENT, not by import —
 * core cannot depend on adapter-types. These type-level assertions fail
 * `tsc --noEmit` (per-package typecheck / root turbo typecheck) the moment
 * either copy gains, loses, or reshapes a member.
 */

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;
type ByType<U, T extends string> = Extract<U, { type: T }>;

// Whole-union structural identity, both directions.
type _wholeSubagent = Expect<
  Equal<SubagentRuntimeEvent, SubagentRuntimeDzupEvent>
>;
type _wholeFanout = Expect<Equal<FanoutRuntimeEvent, FanoutRuntimeDzupEvent>>;

// Member-wise identity — pinpoints the drifting member on failure.
type SubagentType = SubagentRuntimeEvent["type"];
type FanoutType = FanoutRuntimeEvent["type"];
type _subagentTypes = Expect<
  Equal<SubagentType, SubagentRuntimeDzupEvent["type"]>
>;
type _fanoutTypes = Expect<Equal<FanoutType, FanoutRuntimeDzupEvent["type"]>>;
type _memberSubagent = Expect<
  Equal<
    { [T in SubagentType]: ByType<SubagentRuntimeEvent, T> },
    { [T in SubagentType]: ByType<SubagentRuntimeDzupEvent, T> }
  >
>;
type _memberFanout = Expect<
  Equal<
    { [T in FanoutType]: ByType<FanoutRuntimeEvent, T> },
    { [T in FanoutType]: ByType<FanoutRuntimeDzupEvent, T> }
  >
>;

// Value-level canary: one object must satisfy BOTH copies of each union.
const spawned: SubagentRuntimeEvent & SubagentRuntimeDzupEvent = {
  type: "subagent:spawned",
  taskId: "t1",
  parentRunId: "run-1",
  agentId: "claude",
  batchId: "b1",
  depth: 1,
};
const settled: FanoutRuntimeEvent & FanoutRuntimeDzupEvent = {
  type: "fanout:item_settled",
  batchId: "b1",
  itemKey: "k",
  taskId: "t1",
  status: "succeeded",
  durationMs: 5,
};

describe("adapter-types ↔ core event-union sync (Spec 03 AC4b)", () => {
  it("compiles only while both copies are structurally identical", () => {
    // The real assertions are the type-level Expect<Equal<…>> aliases above —
    // any drift breaks typecheck/build. This runtime check is a canary that
    // the shared sample objects remain valid members of both unions.
    expect(spawned.type).toBe("subagent:spawned");
    expect(settled.type).toBe("fanout:item_settled");
  });
});
