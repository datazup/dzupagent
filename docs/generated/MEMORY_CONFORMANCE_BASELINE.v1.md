# Memory conformance baseline v1

- Result: **passed**
- Source digest: `sha256:627162b8e671e20638c3cc61e2cb823417c737b17f4159462210280b5f9172dd` (155 files)
- Config digest: `sha256:936c9124f40283f5aef5793e2b3c641c6d28c95aeb26c0e08a84245756be0e4c`
- Profile digest: `sha256:b55974510af5284b00a2ac14aedef4350732336c56e8650759b45f5dc1ffe20f`
- Result digest: `sha256:9f859df1c5278d0ad149c9698570489efe571aa21fe4f6b578ed5b09ef44305c`
- Provider-free: **passed**
- Live provider: **not-run**
- Production: **not-enabled**

## Suites

| Suite | Status | Passed | Failed | Expected red | Digest |
| --- | --- | ---: | ---: | ---: | --- |
| memory-record-conformance | passed | 5 | 0 | 0 | `sha256:a1fc8bae4908e75c4dcc8920b5957142baab357aa34b6c7a79d7e82e01a26367` |
| memory-lifecycle-conformance | passed | 8 | 0 | 0 | `sha256:e48d600e21c42103ad9f6c65dde80211aaf954e08b048a861c28dee929a4cd06` |
| memory-store-conformance | passed | 8 | 0 | 0 | `sha256:3d36f72d92b3bd2125dda6885a065348ab4210eb8a9afb2cb84dd8aa15974395` |
| memory-retrieval-conformance | passed | 9 | 0 | 0 | `sha256:042c82bb532eb8a3dc052ea0c3d5d3681de9c8ca3de68a6217a50c26def53b3d` |
| memory-compaction-conformance | passed | 8 | 0 | 0 | `sha256:5428bc02dc86ed77b6f3fcbcbb940fab0be7ee34a0c9e2298750818e1466d951` |
| memory-deletion-conformance | passed | 4 | 0 | 0 | `sha256:1a972c614cdb27171abbb9fa439603f1c4c46341098b15d028fa5c050ac197f1` |
| memory-worker-conformance | passed | 15 | 0 | 0 | `sha256:b876ea556f86d3445f669a5ef5751169404e1d949344830a6931e3ccc38c9612` |

## Aggregate

- Cases: 57
- Passed: 57
- Failed: 0
- Expected red: 0
- Unexpected pass: 0
- History contract: `lifecycle-history-evaluated-at-query-as-of`
- Fixture policy: `invented-provider-free-only`

The loader conformance gate is supplemental and is qualified by its package test; this deterministic artifact does not claim aggregate, live-provider, deployment, or production evidence.
