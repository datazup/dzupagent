# Memory conformance baseline v1

- Result: **passed**
- Source digest: `sha256:5960ae0a1331853306a33d68aef477e098fb9ae16a929cc7e2ae6526d9f5103a` (151 files)
- Config digest: `sha256:936c9124f40283f5aef5793e2b3c641c6d28c95aeb26c0e08a84245756be0e4c`
- Profile digest: `sha256:e3c5b808dbd58891473745fb5a3a65da032fc0171c5315bb71caa18358ac3972`
- Result digest: `sha256:ca8b7da54c2ff02dbee80a56d0f2591bcc18f14440a87d832575a6e8efc3aca9`
- Provider-free: **passed**
- Live provider: **not-run**
- Production: **not-enabled**

## Suites

| Suite | Status | Passed | Failed | Expected red | Digest |
| --- | --- | ---: | ---: | ---: | --- |
| memory-record-conformance | passed | 5 | 0 | 0 | `sha256:525cccc4cbb8af7c20ea0c1a1e21aa714bdbee13e409f4195e75d2a18859e5a7` |
| memory-lifecycle-conformance | passed | 8 | 0 | 0 | `sha256:95ed7dd6f83e927a0d05823119dee2b377e94216075327dc7cff16f7f315c6cb` |
| memory-store-conformance | passed | 8 | 0 | 0 | `sha256:c5d57d8435c9a05df2271a7a50409206114a496e5dee0ad3818be85cf0170082` |
| memory-retrieval-conformance | passed | 9 | 0 | 0 | `sha256:fd03c35362032cad07af0166deabdfc6d7195646573805b776780acebe8df355` |
| memory-compaction-conformance | passed | 8 | 0 | 0 | `sha256:1bd5f86551537daf3880775583c7f8d4c03a6a92b102b8378ac644e7d63d8bab` |
| memory-deletion-conformance | passed | 4 | 0 | 0 | `sha256:f94943d166e6fcc1b75b9c17e81a5bebce91491132b3aa855800ea85b70daeb7` |
| memory-worker-conformance | passed | 15 | 0 | 0 | `sha256:a175c89c8bd0527915195099351e8fcb3534ef71c9aaa0b3a2c264bdf2ec8de4` |

## Aggregate

- Cases: 57
- Passed: 57
- Failed: 0
- Expected red: 0
- Unexpected pass: 0
- History contract: `lifecycle-history-evaluated-at-query-as-of`
- Fixture policy: `invented-provider-free-only`

The loader conformance gate is supplemental and is qualified by its package test; this deterministic artifact does not claim aggregate, live-provider, deployment, or production evidence.
