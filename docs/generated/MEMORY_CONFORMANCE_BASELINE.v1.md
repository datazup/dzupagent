# Memory conformance baseline v1

- Result: **passed**
- Source digest: `sha256:f5151e7ef5f94d17716e5b68c85a0dcf2994fd67ff9084b22c9573b80265d116` (155 files)
- Config digest: `sha256:936c9124f40283f5aef5793e2b3c641c6d28c95aeb26c0e08a84245756be0e4c`
- Profile digest: `sha256:2a8b03e18ce09de7f26259b9dbb11e0fae61aaf7b0003c2fec1c89011d7f2f40`
- Result digest: `sha256:92fc8ea31b023f76257b2925388854e447a2af7938e9b729c8b25ccec061fafa`
- Provider-free: **passed**
- Live provider: **not-run**
- Production: **not-enabled**

## Suites

| Suite | Status | Passed | Failed | Expected red | Digest |
| --- | --- | ---: | ---: | ---: | --- |
| memory-record-conformance | passed | 5 | 0 | 0 | `sha256:b96c8d788f940666971f792736473e92228184de24954c5fc357c0cb48d26510` |
| memory-lifecycle-conformance | passed | 8 | 0 | 0 | `sha256:c3366fa557c42b33fe48f0e50ac605d873e899d619a9f3ea2354b659797baf94` |
| memory-store-conformance | passed | 8 | 0 | 0 | `sha256:815c879ab5ace1d2c360724d859105babd149750be96616a596fad4661dc8cf2` |
| memory-retrieval-conformance | passed | 9 | 0 | 0 | `sha256:a6d4bf13ea743b4abd9bbacb8c9ce542d621ecba848648e8eeabb14984d2b1e7` |
| memory-compaction-conformance | passed | 8 | 0 | 0 | `sha256:935d86198cc6e0925cf06d9b83b989db6a0654f85516991baa4fa691a10c9d0f` |
| memory-deletion-conformance | passed | 4 | 0 | 0 | `sha256:58874b3e1801ccc43a321c48607ab42070fcd84d5e538a0743f051779d1742dd` |
| memory-worker-conformance | passed | 15 | 0 | 0 | `sha256:0aee25810aca2b9232d92c8c6a7d9e883897944a7b6be2c370353e7af90fdeed` |

## Aggregate

- Cases: 57
- Passed: 57
- Failed: 0
- Expected red: 0
- Unexpected pass: 0
- History contract: `lifecycle-history-evaluated-at-query-as-of`
- Fixture policy: `invented-provider-free-only`

The loader conformance gate is supplemental and is qualified by its package test; this deterministic artifact does not claim aggregate, live-provider, deployment, or production evidence.
