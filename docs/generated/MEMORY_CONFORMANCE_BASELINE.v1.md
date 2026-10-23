# Memory conformance baseline v1

- Result: **passed**
- Source digest: `sha256:bbb41d98d9013e8094160b8a43ce764e3fe158ec1bcbb6b7e1892f4dcb84e733` (161 files)
- Config digest: `sha256:936c9124f40283f5aef5793e2b3c641c6d28c95aeb26c0e08a84245756be0e4c`
- Profile digest: `sha256:bae5612d6bad5019d71e38fa53c939bc5dcc931cd7e8b27d5460d7ffe4e8cb1e`
- Result digest: `sha256:d3813e3cbd0d8d90732220e9ed69b6cd57486bafee38ccaee99be8414c372a37`
- Provider-free: **passed**
- Live provider: **not-run**
- Production: **not-enabled**

## Suites

| Suite | Status | Passed | Failed | Expected red | Digest |
| --- | --- | ---: | ---: | ---: | --- |
| memory-record-conformance | passed | 5 | 0 | 0 | `sha256:c1e73670bb23bdc02bef0a90330cdbd3075fa151b94a25312bc0882484b9faac` |
| memory-lifecycle-conformance | passed | 8 | 0 | 0 | `sha256:fa421334110c0bd5499651cb9efc5f5ad91f700115ce61579c3ab020b77db9de` |
| memory-store-conformance | passed | 8 | 0 | 0 | `sha256:23579a38cfa711395b5b104fb74aaf8b898f0f7221e4984be2d89173303b2c65` |
| memory-retrieval-conformance | passed | 9 | 0 | 0 | `sha256:76a58e954de02130055c449a02420be136725f41f4484687635a94ea0f06802d` |
| memory-compaction-conformance | passed | 8 | 0 | 0 | `sha256:fa4026a7ee35102354fbb30fd740af955ddb19a793e154e2139567ae8a344ed6` |
| memory-deletion-conformance | passed | 4 | 0 | 0 | `sha256:2344042ca2ed0507c7c57d6464a6ac4c91ed7e98565350f8e1f8856ad33c4c89` |
| memory-worker-conformance | passed | 15 | 0 | 0 | `sha256:14636f7a6a9f99e34e6bc244cb23c4160bbe1644a143e1dbf19241c3dba50ec2` |

## Aggregate

- Cases: 57
- Passed: 57
- Failed: 0
- Expected red: 0
- Unexpected pass: 0
- History contract: `lifecycle-history-evaluated-at-query-as-of`
- Fixture policy: `invented-provider-free-only`

The loader conformance gate is supplemental and is qualified by its package test; this deterministic artifact does not claim aggregate, live-provider, deployment, or production evidence.
