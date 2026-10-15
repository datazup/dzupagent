/**
 * Shared contract suite for {@link QuorumVoteStore} adapters, published on the
 * `@dzupagent/hitl-kit/testing` subpath so adapters outside this package can
 * run it (DZUPAGENT-TEST-M-25).
 *
 * The suite is test-framework agnostic: the caller passes its own `describe`
 * and `it` (vitest, jest and `node:test` all fit), and the assertions are
 * self-contained, so the published entry point carries no test-runner
 * dependency.
 *
 * ```ts
 * import { describe, it } from "vitest";
 * import { runQuorumVoteStoreContract } from "@dzupagent/hitl-kit/testing";
 *
 * runQuorumVoteStoreContract("PostgresQuorumVoteStore", () => makeStore(), {
 *   describe,
 *   it,
 * });
 * ```
 */
import type { ApproverVote } from "../approval-quorum.js";
import {
  InvalidQuorumVoteError,
  type QuorumVoteStore,
} from "../quorum-vote-store.js";

/** The two suite-building functions every mainstream test runner provides. */
export interface QuorumVoteStoreContractHarness {
  describe(name: string, body: () => void): unknown;
  it(name: string, body: () => Promise<void>): unknown;
}

/** Thrown by the contract suite when an adapter violates the contract. */
export class QuorumVoteStoreContractViolation extends Error {
  constructor(message: string) {
    super(`QuorumVoteStore contract violated: ${message}`);
    this.name = "QuorumVoteStoreContractViolation";
  }
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0
        )
      );
    }
    return entry;
  });
}

function assertEqual(actual: unknown, expected: unknown, what: string): void {
  if (canonical(actual) !== canonical(expected)) {
    throw new QuorumVoteStoreContractViolation(
      `${what}: expected ${canonical(expected)}, received ${canonical(actual)}`
    );
  }
}

async function assertRejectsInvalidVote(
  action: () => Promise<unknown>,
  what: string
): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof InvalidQuorumVoteError) return;
    throw new QuorumVoteStoreContractViolation(
      `${what}: expected InvalidQuorumVoteError, received ${String(error)}`
    );
  }
  throw new QuorumVoteStoreContractViolation(
    `${what}: expected InvalidQuorumVoteError, but the call resolved`
  );
}

export function runQuorumVoteStoreContract(
  name: string,
  factory: () => QuorumVoteStore | Promise<QuorumVoteStore>,
  harness: QuorumVoteStoreContractHarness
): void {
  const { describe, it } = harness;
  describe(`QuorumVoteStore contract: ${name}`, () => {
    it("returns [] for an unknown key", async () => {
      const store = await factory();
      assertEqual(await store.listVotes("run-1", "appr-1"), [], "unknown key");
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
      assertEqual(await store.recordVote("run-1", "appr-1", first), true, "first vote stored");
      assertEqual(await store.recordVote("run-1", "appr-1", second), true, "second vote stored");
      assertEqual(
        await store.listVotes("run-1", "appr-1"),
        [first, second],
        "votes in recording order"
      );
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
      assertEqual(again, false, "duplicate vote reported");
      assertEqual(
        await store.listVotes("run-1", "appr-1"),
        [{ approverId: "alice", decision: "granted" }],
        "first vote kept"
      );
    });

    it("keeps exactly one vote when the same approver votes concurrently", async () => {
      const store = await factory();
      const votes: ApproverVote[] = [
        { approverId: "alice", decision: "granted" },
        { approverId: "alice", decision: "rejected", reason: "raced" },
        { approverId: "alice", decision: "granted", reason: "raced again" },
      ];
      const results = await Promise.all(
        votes.map((vote) => store.recordVote("run-1", "appr-1", vote))
      );
      assertEqual(
        results.filter((stored) => stored).length,
        1,
        "concurrent first-vote-wins: exactly one recordVote returns true"
      );
      const winner = votes[results.indexOf(true)];
      assertEqual(
        await store.listVotes("run-1", "appr-1"),
        [winner],
        "concurrent first-vote-wins: only the winning vote is stored"
      );
    });

    it("stores concurrent votes from different approvers", async () => {
      const store = await factory();
      const results = await Promise.all(
        ["alice", "bob", "carol"].map((approverId) =>
          store.recordVote("run-1", "appr-1", { approverId, decision: "granted" })
        )
      );
      assertEqual(results, [true, true, true], "every distinct approver stored");
      const stored = await store.listVotes("run-1", "appr-1");
      assertEqual(
        stored.map((vote) => vote.approverId).sort(),
        ["alice", "bob", "carol"],
        "concurrent distinct approvers listed"
      );
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
      assertEqual(
        await store.listVotes("a::b", "c"),
        [{ approverId: "alice", decision: "granted" }],
        "key a::b/c"
      );
      assertEqual(
        await store.listVotes("a", "b::c"),
        [{ approverId: "alice", decision: "rejected" }],
        "key a/b::c"
      );
      assertEqual(
        await store.listVotes("a::b", "d"),
        [{ approverId: "bob", decision: "granted" }],
        "key a::b/d"
      );
    });

    it("is not affected by mutating the input or returned votes", async () => {
      const store = await factory();
      const vote: ApproverVote = { approverId: "alice", decision: "granted" };
      await store.recordVote("run-1", "appr-1", vote);
      vote.decision = "rejected";
      const listed = await store.listVotes("run-1", "appr-1");
      assertEqual(listed[0]?.decision, "granted", "input mutation isolated");
      listed[0]!.decision = "rejected";
      listed.push({ approverId: "mallory", decision: "granted" });
      assertEqual(
        await store.listVotes("run-1", "appr-1"),
        [{ approverId: "alice", decision: "granted" }],
        "returned-array mutation isolated"
      );
    });

    it("rejects a blank approver id and stores nothing", async () => {
      const store = await factory();
      await assertRejectsInvalidVote(
        () =>
          store.recordVote("run-1", "appr-1", {
            approverId: "  ",
            decision: "granted",
          }),
        "blank approver id"
      );
      assertEqual(await store.listVotes("run-1", "appr-1"), [], "nothing stored");
    });

    it("rejects an unknown decision and stores nothing", async () => {
      const store = await factory();
      await assertRejectsInvalidVote(
        () =>
          store.recordVote("run-1", "appr-1", {
            approverId: "alice",
            decision: "maybe" as ApproverVote["decision"],
          }),
        "unknown decision"
      );
      assertEqual(await store.listVotes("run-1", "appr-1"), [], "nothing stored");
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
      assertEqual(await store.listVotes("run-1", "appr-1"), [], "cleared key");
      assertEqual(
        await store.listVotes("run-1", "appr-2"),
        [{ approverId: "alice", decision: "rejected" }],
        "other key kept"
      );
      // A cleared key accepts a fresh vote from the same approver.
      assertEqual(
        await store.recordVote("run-1", "appr-1", {
          approverId: "alice",
          decision: "rejected",
        }),
        true,
        "cleared key accepts a fresh vote"
      );
    });
  });
}
