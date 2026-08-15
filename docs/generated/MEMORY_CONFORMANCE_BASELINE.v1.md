# Memory conformance baseline v1

- Result: **passed**
- Source digest: `sha256:57b7d77960caaf2f3f8f09aa6a8af3a03d617c9bd7a1820a8b084e895e693c1c` (151 files)
- Config digest: `sha256:936c9124f40283f5aef5793e2b3c641c6d28c95aeb26c0e08a84245756be0e4c`
- Profile digest: `sha256:4c54a527cbcf46085ec498f24552ca4b93052045f466b1022a25d51ce6ff6398`
- Result digest: `sha256:b434270def10e0cc908f5efa8324baac38f4c8689b8a3f7187e0b1cab668b321`
- Provider-free: **passed**
- Live provider: **not-run**
- Production: **not-enabled**

## Suites

| Suite | Status | Passed | Failed | Expected red | Digest |
| --- | --- | ---: | ---: | ---: | --- |
| memory-record-conformance | passed | 5 | 0 | 0 | `sha256:bcedf41abb573de5b27f3123052984296a1f3bc354377283d84bf02c379fd68c` |
| memory-lifecycle-conformance | passed | 8 | 0 | 0 | `sha256:f8cf2e991b72272d346e26c5a8096b313220a7e85a38d6b6fc73c502cacfa865` |
| memory-store-conformance | passed | 8 | 0 | 0 | `sha256:64fdb2b34f342c725f5c3cd208f066ed9295f2b9524c69de0506b0e88892e64d` |
| memory-retrieval-conformance | passed | 9 | 0 | 0 | `sha256:615e03755ee6bb9d5d9ea60d6ae20c90638ca6bc4b30d6b038c4e2949a76f76b` |
| memory-compaction-conformance | passed | 8 | 0 | 0 | `sha256:cea2aa5553f19c79fddefe13242077c5d19963bd2496d28860da84d51ff08d75` |
| memory-deletion-conformance | passed | 4 | 0 | 0 | `sha256:f1742831a51a4ceb5ecacd555c3705ea3aeb8d8fd15115b06c6b2d8f86dcef1c` |
| memory-worker-conformance | passed | 15 | 0 | 0 | `sha256:327d08a8ab6d873402fad14c14f567c6a06464a15b51c0fb556c1d7c12921776` |

## Aggregate

- Cases: 57
- Passed: 57
- Failed: 0
- Expected red: 0
- Unexpected pass: 0
- History contract: `lifecycle-history-evaluated-at-query-as-of`
- Fixture policy: `invented-provider-free-only`

The loader conformance gate is supplemental and is qualified by its package test; this deterministic artifact does not claim aggregate, live-provider, deployment, or production evidence.
