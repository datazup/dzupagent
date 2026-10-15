/**
 * Binds the published, framework-agnostic contract suite
 * (`@dzupagent/hitl-kit/testing`, src/testing/quorum-vote-store-contract.ts)
 * to vitest for this package's own adapter tests.
 */
import { describe, it } from "vitest";

import type { QuorumVoteStore } from "../quorum-vote-store.js";
import { runQuorumVoteStoreContract as runPublishedContract } from "../testing.js";

export function runQuorumVoteStoreContract(
  name: string,
  factory: () => QuorumVoteStore | Promise<QuorumVoteStore>
): void {
  runPublishedContract(name, factory, { describe, it });
}
