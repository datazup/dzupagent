import { describe, expect, it } from "vitest";

import {
  InvalidQuorumPolicyError,
  UnknownApproverError,
  type QuorumPolicy,
} from "../approval-quorum.js";
import {
  InMemoryQuorumVoteStore,
  recordQuorumVote,
} from "../quorum-vote-store.js";
import { runQuorumVoteStoreContract } from "./quorum-vote-store-contract.js";

runQuorumVoteStoreContract(
  "InMemoryQuorumVoteStore",
  () => new InMemoryQuorumVoteStore()
);

describe("recordQuorumVote", () => {
  const majority: QuorumPolicy = {
    strategy: "majority",
    approvers: ["alice", "bob", "carol"],
  };

  it("records the vote and returns the re-evaluated tally", async () => {
    const store = new InMemoryQuorumVoteStore();
    const tally = await recordQuorumVote(store, majority, "run-1", "appr-1", {
      approverId: "alice",
      decision: "granted",
    });
    expect(tally).toEqual({
      status: "pending",
      required: 2,
      granted: ["alice"],
      rejected: [],
      outstanding: ["bob", "carol"],
    });
    const second = await recordQuorumVote(
      store,
      majority,
      "run-1",
      "appr-1",
      { approverId: "carol", decision: "granted" }
    );
    expect(second.status).toBe("granted");
    expect(second.granted).toEqual(["alice", "carol"]);
  });

  it("refuses a non-member before storing anything", async () => {
    const store = new InMemoryQuorumVoteStore();
    await expect(
      recordQuorumVote(store, majority, "run-1", "appr-1", {
        approverId: "mallory",
        decision: "granted",
      })
    ).rejects.toBeInstanceOf(UnknownApproverError);
    expect(await store.listVotes("run-1", "appr-1")).toEqual([]);
  });

  it("refuses a malformed policy before storing anything", async () => {
    const store = new InMemoryQuorumVoteStore();
    await expect(
      recordQuorumVote(
        store,
        { strategy: "all", approvers: [] },
        "run-1",
        "appr-1",
        { approverId: "alice", decision: "granted" }
      )
    ).rejects.toBeInstanceOf(InvalidQuorumPolicyError);
    expect(await store.listVotes("run-1", "appr-1")).toEqual([]);
  });

  it("drops votes once the tally is terminal", async () => {
    const store = new InMemoryQuorumVoteStore();
    const policy: QuorumPolicy = {
      strategy: "all",
      approvers: ["alice", "bob"],
    };
    const rejected = await recordQuorumVote(store, policy, "run-1", "appr-1", {
      approverId: "alice",
      decision: "rejected",
      reason: "no",
    });
    expect(rejected.status).toBe("rejected");
    const late = await recordQuorumVote(store, policy, "run-1", "appr-1", {
      approverId: "bob",
      decision: "granted",
    });
    expect(late).toEqual(rejected);
    expect(await store.listVotes("run-1", "appr-1")).toEqual([
      { approverId: "alice", decision: "rejected", reason: "no" },
    ]);
  });

  it("ignores a repeat vote from the same approver", async () => {
    const store = new InMemoryQuorumVoteStore();
    await recordQuorumVote(store, majority, "run-1", "appr-1", {
      approverId: "alice",
      decision: "granted",
    });
    const repeat = await recordQuorumVote(store, majority, "run-1", "appr-1", {
      approverId: "alice",
      decision: "rejected",
    });
    expect(repeat.granted).toEqual(["alice"]);
    expect(repeat.rejected).toEqual([]);
    expect(repeat.status).toBe("pending");
  });
});
