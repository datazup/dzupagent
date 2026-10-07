# Memory conformance baseline v1

- Result: **passed**
- Source digest: `sha256:17d61e3f4933b1bf59130b76313f293ad3c50b41ae7f6f87e1e6bf487df68272` (155 files)
- Config digest: `sha256:936c9124f40283f5aef5793e2b3c641c6d28c95aeb26c0e08a84245756be0e4c`
- Profile digest: `sha256:ee44a8b7d69ef5c26ae2070f92c1946a183b0c55701095a718443fce3910bb8d`
- Result digest: `sha256:1d8761259c7389eb81d976d55b0ae3ccacfa230187c9be60f1d68d89f576d2e1`
- Provider-free: **passed**
- Live provider: **not-run**
- Production: **not-enabled**

## Suites

| Suite | Status | Passed | Failed | Expected red | Digest |
| --- | --- | ---: | ---: | ---: | --- |
| memory-record-conformance | passed | 5 | 0 | 0 | `sha256:587f7497a46c089980d9cbe59c1ce4dc6ea5d7aac02579e71454ac614b0d4c64` |
| memory-lifecycle-conformance | passed | 8 | 0 | 0 | `sha256:742a34a2f9e04ce296fec1f781dee376b6b4e86eb5aeea5082e603fd1909865b` |
| memory-store-conformance | passed | 8 | 0 | 0 | `sha256:a0954b02b6fee8aca01034ae10cb3d6e23f5b6aebc7251944b3724e931193c8f` |
| memory-retrieval-conformance | passed | 9 | 0 | 0 | `sha256:dbc2a8487719d2248f6958063392e8b639064ce66779f930f6c99aa7ce6d88d2` |
| memory-compaction-conformance | passed | 8 | 0 | 0 | `sha256:b267f4cbc04dd314cc8f06b20ba05ce495fc30f69c75ca62e097b074e8f062ab` |
| memory-deletion-conformance | passed | 4 | 0 | 0 | `sha256:21b65b77ce6d853cd5ccdb6c73b71a7f2a49460ad5833f53229d13ddbf59bb46` |
| memory-worker-conformance | passed | 15 | 0 | 0 | `sha256:f2009c02ef41667721bf4c180f09c03cce6a68660918dc64ddfa59be950cb082` |

## Aggregate

- Cases: 57
- Passed: 57
- Failed: 0
- Expected red: 0
- Unexpected pass: 0
- History contract: `lifecycle-history-evaluated-at-query-as-of`
- Fixture policy: `invented-provider-free-only`

The loader conformance gate is supplemental and is qualified by its package test; this deterministic artifact does not claim aggregate, live-provider, deployment, or production evidence.
