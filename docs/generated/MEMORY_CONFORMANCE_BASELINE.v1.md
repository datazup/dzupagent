# Memory conformance baseline v1

- Result: **passed**
- Source digest: `sha256:2861b6b07e722bc89bed8676f5ec24af24e6a4e81ea98f252f68dc619b7dec19` (155 files)
- Config digest: `sha256:936c9124f40283f5aef5793e2b3c641c6d28c95aeb26c0e08a84245756be0e4c`
- Profile digest: `sha256:9120a4bacce36c14574dfb04a13d601d4238ab2154bccd22270950310e814cc3`
- Result digest: `sha256:363aeafb65bf0d629130c00e8d826f939cebae8d8fe9b1a1292e91db687ab10e`
- Provider-free: **passed**
- Live provider: **not-run**
- Production: **not-enabled**

## Suites

| Suite | Status | Passed | Failed | Expected red | Digest |
| --- | --- | ---: | ---: | ---: | --- |
| memory-record-conformance | passed | 5 | 0 | 0 | `sha256:483683b7200b5dd37a2af2d41e5ca95fa222ae754d4a18ebd96595c107148869` |
| memory-lifecycle-conformance | passed | 8 | 0 | 0 | `sha256:8904e44d2e03320021afa21db4d68d151a8046c45d2c01875a00bdeef1994ca4` |
| memory-store-conformance | passed | 8 | 0 | 0 | `sha256:266c1b20aab6d4169fc78e924c37ad3cf35db88d7b0547a0601ee88be630c246` |
| memory-retrieval-conformance | passed | 9 | 0 | 0 | `sha256:52884825922208d09a83ca930231695a83ea2253138e997d3352f26bb8bbed76` |
| memory-compaction-conformance | passed | 8 | 0 | 0 | `sha256:2a19b004fcc037d32c1b9046d2fb529a1edbee6ff3c2d16b6f48be80ff028b09` |
| memory-deletion-conformance | passed | 4 | 0 | 0 | `sha256:cac1cc8620fbe89358600b7050023c70fc22fc3ea0328b980d3d8c6781ab755c` |
| memory-worker-conformance | passed | 15 | 0 | 0 | `sha256:481085002f462077f43017a515b31a6f5a748b508854d94380c2d3df046c6ebb` |

## Aggregate

- Cases: 57
- Passed: 57
- Failed: 0
- Expected red: 0
- Unexpected pass: 0
- History contract: `lifecycle-history-evaluated-at-query-as-of`
- Fixture policy: `invented-provider-free-only`

The loader conformance gate is supplemental and is qualified by its package test; this deterministic artifact does not claim aggregate, live-provider, deployment, or production evidence.
