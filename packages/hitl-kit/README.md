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

## License

MIT
