# Memory conformance baseline v1

- Result: **passed**
- Source digest: `sha256:dbb57745240bb1485278132f44b43a39a0979119795ccc87d842483b4b00eb86` (155 files)
- Config digest: `sha256:936c9124f40283f5aef5793e2b3c641c6d28c95aeb26c0e08a84245756be0e4c`
- Profile digest: `sha256:c77fb92dbeae93884f30fa05e25d9ff7c2c7da03f66ac7ba199d5b4e780268e0`
- Result digest: `sha256:90a625f9b7b8a3e36c39916b9507f35909aacc53d660013d842e87fe881b5284`
- Provider-free: **passed**
- Live provider: **not-run**
- Production: **not-enabled**

## Suites

| Suite | Status | Passed | Failed | Expected red | Digest |
| --- | --- | ---: | ---: | ---: | --- |
| memory-record-conformance | passed | 5 | 0 | 0 | `sha256:c0fa3a10369831e505fcab85ce2d7a38ee8d6730c68923031e9ca7a9a2867948` |
| memory-lifecycle-conformance | passed | 8 | 0 | 0 | `sha256:3b2e741ffe11c8884d000e993c47a32f87bf67e0e65b62a4871141b4b9f5350b` |
| memory-store-conformance | passed | 8 | 0 | 0 | `sha256:fcfc4cc3dbc805dfcddfeebaaadecbab1111b1c0d008dfc4cbe60bfc697967e8` |
| memory-retrieval-conformance | passed | 9 | 0 | 0 | `sha256:702f12c76057961126739aa4c6100cb28ce48e97a377bf2339a9bd9baf9c9a61` |
| memory-compaction-conformance | passed | 8 | 0 | 0 | `sha256:42fd65037ba38952274b11b06752689ac284b39eedb79b263c261c15788ed65f` |
| memory-deletion-conformance | passed | 4 | 0 | 0 | `sha256:6520f366c2e400eebf68a83e0955c3cf641243caed0274464d9d7cc236fd6776` |
| memory-worker-conformance | passed | 15 | 0 | 0 | `sha256:75740ca75feb3c1ec247e89e74bc396a6c4bc741f8f7b89b3ecdb2672b172edc` |

## Aggregate

- Cases: 57
- Passed: 57
- Failed: 0
- Expected red: 0
- Unexpected pass: 0
- History contract: `lifecycle-history-evaluated-at-query-as-of`
- Fixture policy: `invented-provider-free-only`

The loader conformance gate is supplemental and is qualified by its package test; this deterministic artifact does not claim aggregate, live-provider, deployment, or production evidence.
