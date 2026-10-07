/**
 * Shared contract suite for {@link QuorumVoteStore} adapters. Every adapter
 * calls `runQuorumVoteStoreContract` from its own test file with a factory
 * that returns a fresh, empty store.
 */
import { describe, expect, it } from "vitest";

import type { ApproverVote } from "../approval-quorum.js";
import {
  InvalidQuorumVoteError,
  type QuorumVoteStore,
} from "../quorum-vote-store.js";

export function runQuorumVoteStoreContract(
  name: string,
  factory: () => QuorumVoteStore | Promise<QuorumVoteStore>
): void {
  describe(`QuorumVoteStore contract: ${name}`, () => {
    it("returns [] for an unknown key", async () => {
      const store = await factory();
      expect(await store.listVotes("run-1", "appr-1")).toEqual([]);
    });

    it("returns votes in recording order with every field preserved", async () => {
      const store = await factory();
      const first: ApproverVote = {
        approverId: "bob",
        decision: "rejected",
        reason: "missing tests",
      };
      const second: ApproverVote = {
        approverId: "alice",
        decision: "granted",
        response: { note: "ok", level: 2 },
      };
      expect(await store.recordVote("run-1", "appr-1", first)).toBe(true);
      expect(await store.recordVote("run-1", "appr-1", second)).toBe(true);
      expect(await store.listVotes("run-1", "appr-1")).toEqual([first, second]);
    });

    it("keeps the first vote per approver and reports the duplicate", async () => {
      const store = await factory();
      await store.recordVote("run-1", "appr-1", {
        approverId: "alice",
        decision: "granted",
      });
      const again = await store.recordVote("run-1", "appr-1", {
        approverId: "alice",
        decision: "rejected",
        reason: "changed my mind",
      });
      expect(again).toBe(false);
      expect(await store.listVotes("run-1", "appr-1")).toEqual([
        { approverId: "alice", decision: "granted" },
      ]);
    });

    it("isolates keys, including separator collisions", async () => {
      const store = await factory();
      await store.recordVote("a::b", "c", {
        approverId: "alice",
        decision: "granted",
      });
      await store.recordVote("a", "b::c", {
        approverId: "alice",
        decision: "rejected",
      });
      await store.recordVote("a::b", "d", {
        approverId: "bob",
        decision: "granted",
      });
      expect(await store.listVotes("a::b", "c")).toEqual([
        { approverId: "alice", decision: "granted" },
      ]);
      expect(await store.listVotes("a", "b::c")).toEqual([
        { approverId: "alice", decision: "rejected" },
      ]);
      expect(await store.listVotes("a::b", "d")).toEqual([
        { approverId: "bob", decision: "granted" },
      ]);
    });

    it("is not affected by mutating the input or returned votes", async () => {
      const store = await factory();
      const vote: ApproverVote = { approverId: "alice", decision: "granted" };
      await store.recordVote("run-1", "appr-1", vote);
      vote.decision = "rejected";
      const listed = await store.listVotes("run-1", "appr-1");
      expect(listed[0]?.decision).toBe("granted");
      listed[0]!.decision = "rejected";
      listed.push({ approverId: "mallory", decision: "granted" });
      expect(await store.listVotes("run-1", "appr-1")).toEqual([
        { approverId: "alice", decision: "granted" },
      ]);
    });

    it("rejects a blank approver id and stores nothing", async () => {
      const store = await factory();
      await expect(
        store.recordVote("run-1", "appr-1", {
          approverId: "  ",
          decision: "granted",
        })
      ).rejects.toBeInstanceOf(InvalidQuorumVoteError);
      expect(await store.listVotes("run-1", "appr-1")).toEqual([]);
    });

    it("rejects an unknown decision and stores nothing", async () => {
      const store = await factory();
      await expect(
        store.recordVote("run-1", "appr-1", {
          approverId: "alice",
          decision: "maybe" as ApproverVote["decision"],
        })
      ).rejects.toBeInstanceOf(InvalidQuorumVoteError);
      expect(await store.listVotes("run-1", "appr-1")).toEqual([]);
    });

    it("clears one key only and ignores unknown keys", async () => {
      const store = await factory();
      await store.recordVote("run-1", "appr-1", {
        approverId: "alice",
        decision: "granted",
      });
      await store.recordVote("run-1", "appr-2", {
        approverId: "alice",
        decision: "rejected",
      });
      await store.clearVotes("run-1", "appr-1");
      await store.clearVotes("run-9", "appr-9");
      expect(await store.listVotes("run-1", "appr-1")).toEqual([]);
      expect(await store.listVotes("run-1", "appr-2")).toEqual([
        { approverId: "alice", decision: "rejected" },
      ]);
      // A cleared key accepts a fresh vote from the same approver.
      expect(
        await store.recordVote("run-1", "appr-1", {
          approverId: "alice",
          decision: "rejected",
        })
      ).toBe(true);
    });
  });
}
