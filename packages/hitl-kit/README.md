# @dzupagent/hitl-kit

Human-in-the-loop payload and response types for DzupAgent — clarification and approval primitives shared across adapters

Part of the [DzupAgent](../../README.md) framework.

## Usage

```ts
import { ApprovalGate, InMemoryApprovalStateStore } from '@dzupagent/hitl-kit'
```

### Multi-approver quorum

`evaluateQuorum` is a pure evaluator for multi-approver decisions. It does not
store votes; callers pass the votes received so far.

```ts
import { evaluateQuorum } from '@dzupagent/hitl-kit'

const tally = evaluateQuorum(
  { strategy: 'majority', approvers: ['alice', 'bob', 'carol'] },
  [{ approverId: 'alice', decision: 'granted' }],
)
// tally.status === 'pending', tally.required === 2, tally.outstanding === ['bob', 'carol']
```

- `all`: every approver must grant; one rejection rejects.
- `any`: one grant is enough; rejected only when every approver rejects.
- `majority`: `floor(n / 2) + 1` grants; an even split is rejected.
- The first vote from each approver counts; later votes from that approver are ignored.
- A vote from an id outside `approvers` throws `UnknownApproverError`; an empty,
  duplicate or blank approver list throws `InvalidQuorumPolicyError`.

### Quorum vote storage

`QuorumVoteStore` keeps the votes for one `(runId, approvalId)` request.
`InMemoryQuorumVoteStore` is the single-process default; `recordQuorumVote`
stores a vote and returns the new tally.

```ts
import { InMemoryQuorumVoteStore, recordQuorumVote } from '@dzupagent/hitl-kit'

const store = new InMemoryQuorumVoteStore()
const policy = { strategy: 'majority', approvers: ['alice', 'bob', 'carol'] } as const
const tally = await recordQuorumVote(store, policy, 'run-1', 'deploy', {
  approverId: 'alice',
  decision: 'granted',
})
```

- Only the first vote from each approver is stored (`recordVote` returns `false` for a repeat).
- `recordQuorumVote` checks the policy and the voter before writing, and stores nothing
  once the tally is `granted` or `rejected`.
- A blank `approverId` or unknown `decision` throws `InvalidQuorumVoteError`. The in-memory
  store deep-copies `response`, so it must be structured-cloneable.
- Every adapter must pass `runQuorumVoteStoreContract` in
  `src/__tests__/quorum-vote-store-contract.ts`. A database adapter needs a unique
  `(runId, approvalId, approverId)` constraint for first-vote-wins.

### Escalation chain

`EscalationEngine` walks an ordered approver chain with a timeout per level.
It sets no timers; the host calls `tick()` and the clock is injectable.

```ts
import { EscalationEngine } from '@dzupagent/hitl-kit'

const engine = new EscalationEngine(
  {
    levels: [
      { approvers: ['lead'], timeoutMs: 60_000 },
      { approvers: ['manager', 'deputy'], timeoutMs: 300_000 },
    ],
    // onExhausted: 'reject' (default) | 'approve'
  },
  { onEvent: (event) => console.log(event.type) },
)

engine.tick() // escalates past any elapsed deadline
engine.decide('manager', 'granted') // throws ApproverNotActiveError unless level 1 is active
```

- Any one approver on the active level decides; the first decision wins.
- On timeout the next level starts at the previous deadline; earlier levels lose authority.
- When the last level times out, `onExhausted` applies (`reject` by default).
- Events: `level_started`, `level_timed_out`, `decided`, `exhausted`.
- A malformed policy (no levels, empty/blank/duplicate approvers in a level,
  non-positive-integer `timeoutMs`) throws `InvalidEscalationPolicyError`.

## License

MIT
