# Memory conformance baseline v1

- Result: **passed**
- Source digest: `sha256:29cc1cf9039b02aeef8a214dc924c77debd59476b9836db3613722b83beec044` (151 files)
- Config digest: `sha256:936c9124f40283f5aef5793e2b3c641c6d28c95aeb26c0e08a84245756be0e4c`
- Profile digest: `sha256:7792c53d8d2ad02146812eb191b5960c62057e2559f6bbea3a9e13ee6c23ccdc`
- Result digest: `sha256:5aa4d4f7f4071d71cb7af464870a06a74d3406873b38b58ae4a7166050ea5e0b`
- Provider-free: **passed**
- Live provider: **not-run**
- Production: **not-enabled**

## Suites

| Suite | Status | Passed | Failed | Expected red | Digest |
| --- | --- | ---: | ---: | ---: | --- |
| memory-record-conformance | passed | 5 | 0 | 0 | `sha256:57ef67a1d511af318fe80150f4c0d25679230ea4e4dce8945c22083656b9c435` |
| memory-lifecycle-conformance | passed | 8 | 0 | 0 | `sha256:6e6b46d75977417c3e738377cd6573b548d4f6594ae9cfee3f15b4f0f3a600c2` |
| memory-store-conformance | passed | 8 | 0 | 0 | `sha256:f4860f83930f23e0b09ebaba9da06101511fb7bcd68bbd3040e20f1981005564` |
| memory-retrieval-conformance | passed | 9 | 0 | 0 | `sha256:73ffde6b50828071ffb01d3ce1b92005bf2964ab2a5fb4615f7a45e9124aa349` |
| memory-compaction-conformance | passed | 8 | 0 | 0 | `sha256:52fcf275b8c4c5692ffa31afb7c2941ccc78734af687d49f1d3acfaccba6c963` |
| memory-deletion-conformance | passed | 4 | 0 | 0 | `sha256:ab5ce1035e2df2662f750ef42b2bbf9f5eb9bbaab46911bde1b929d9e97b7247` |
| memory-worker-conformance | passed | 15 | 0 | 0 | `sha256:8d08a657f742f037322578d466212872f0c59cf6322fb48a3f4d6befeffdf58e` |

## Aggregate

- Cases: 57
- Passed: 57
- Failed: 0
- Expected red: 0
- Unexpected pass: 0
- History contract: `lifecycle-history-evaluated-at-query-as-of`
- Fixture policy: `invented-provider-free-only`

The loader conformance gate is supplemental and is qualified by its package test; this deterministic artifact does not claim aggregate, live-provider, deployment, or production evidence.
