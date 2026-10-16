import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { ApproverVote } from "../approval-quorum.js";
import { InMemoryQuorumVoteStore, type QuorumVoteStore } from "../quorum-vote-store.js";
import {
  QuorumVoteStoreContractViolation,
  runQuorumVoteStoreContract,
} from "../testing.js";

/**
 * DZUPAGENT-TEST-M-25: the adapter contract suite lived under src/__tests__ and
 * was not published. It is now on the `./testing` subpath, framework-agnostic,
 * and includes a concurrent first-vote-wins case.
 */
type Case = { name: string; body: () => Promise<void> };

function collectCases(factory: () => QuorumVoteStore): Case[] {
  const cases: Case[] = [];
  runQuorumVoteStoreContract("collected", factory, {
    describe: (_name, body) => body(),
    it: (name, body) => {
      cases.push({ name, body });
    },
  });
  return cases;
}

/** A store with a check-then-write race: it yields between the two steps. */
class RacyQuorumVoteStore extends InMemoryQuorumVoteStore {
  private readonly racyVotes = new Map<string, ApproverVote[]>();

  override async recordVote(runId: string, approvalId: string, vote: ApproverVote): Promise<boolean> {
    const key = JSON.stringify([runId, approvalId]);
    const existing = this.racyVotes.get(key) ?? [];
    if (existing.some((v) => v.approverId === vote.approverId)) return false;
    await Promise.resolve();
    this.racyVotes.set(key, [...(this.racyVotes.get(key) ?? []), { ...vote }]);
    return true;
  }

  override async listVotes(runId: string, approvalId: string): Promise<ApproverVote[]> {
    return (this.racyVotes.get(JSON.stringify([runId, approvalId])) ?? []).map((v) => ({ ...v }));
  }
}

describe("@dzupagent/hitl-kit/testing", () => {
  it("package.json publishes the ./testing subpath", () => {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")
    ) as { exports: Record<string, unknown> };
    expect(manifest.exports["./testing"]).toEqual({
      import: "./dist/testing.js",
      types: "./dist/testing.d.ts",
    });
  });

  it("the in-memory store passes every case, including the concurrent one", async () => {
    const cases = collectCases(() => new InMemoryQuorumVoteStore());
    expect(cases.map((c) => c.name)).toContain(
      "keeps exactly one vote when the same approver votes concurrently"
    );
    for (const testCase of cases) {
      await expect(testCase.body(), testCase.name).resolves.toBeUndefined();
    }
  });

  it("a store with a check-then-write race fails the concurrent first-vote-wins case", async () => {
    const concurrent = collectCases(() => new RacyQuorumVoteStore()).find(
      (c) => c.name === "keeps exactly one vote when the same approver votes concurrently"
    );
    expect(concurrent).toBeDefined();
    await expect(concurrent!.body()).rejects.toBeInstanceOf(QuorumVoteStoreContractViolation);
  });
});
