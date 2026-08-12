# Memory conformance baseline v1

- Result: **passed**
- Source digest: `sha256:971cf51c82187c6e3be9f0827bb899f718521154f789a31470a84b64355fe73a` (151 files)
- Config digest: `sha256:936c9124f40283f5aef5793e2b3c641c6d28c95aeb26c0e08a84245756be0e4c`
- Profile digest: `sha256:bd2d29db53e379a81b82f261cb9749ba2ae63e48222b4c92c19c7d5314fe190d`
- Result digest: `sha256:080060413c694f0e3535ea99296cfeeeebd1bf61c3e197b5aaf3f1297f6716ba`
- Provider-free: **passed**
- Live provider: **not-run**
- Production: **not-enabled**

## Suites

| Suite | Status | Passed | Failed | Expected red | Digest |
| --- | --- | ---: | ---: | ---: | --- |
| memory-record-conformance | passed | 5 | 0 | 0 | `sha256:65d464fdb99a89123c6a0931242e2bf5a05d400006b1c6bf5d95fe78791891ab` |
| memory-lifecycle-conformance | passed | 8 | 0 | 0 | `sha256:7aae0791f75b0623ac2db03baf554459b29d74e93bcb07548e02e5f4173551af` |
| memory-store-conformance | passed | 8 | 0 | 0 | `sha256:2f3412d3b50a0bdb5a4ac8cb7b395528aec7fcebf2295c16be8438bf55fbf930` |
| memory-retrieval-conformance | passed | 9 | 0 | 0 | `sha256:50fd3611fa3e64a792328174b31384282f7fdf8804b3f54248edf20a6fd0e1bc` |
| memory-compaction-conformance | passed | 8 | 0 | 0 | `sha256:9982e9f3862a9c0d51aa58d9f8aabb8cc64fc551542902084c767688490d2c65` |
| memory-deletion-conformance | passed | 4 | 0 | 0 | `sha256:527d21fa3c84d0cd2bd8b8387b2e6b618b65e18545d1aea63ea38ed3a963796f` |
| memory-worker-conformance | passed | 15 | 0 | 0 | `sha256:adfee655de5ca39866f6a5c6d725aa4cfee3ded8e4f439ed1096f474fe234f76` |

## Aggregate

- Cases: 57
- Passed: 57
- Failed: 0
- Expected red: 0
- Unexpected pass: 0
- History contract: `lifecycle-history-evaluated-at-query-as-of`
- Fixture policy: `invented-provider-free-only`

The loader conformance gate is supplemental and is qualified by its package test; this deterministic artifact does not claim aggregate, live-provider, deployment, or production evidence.
