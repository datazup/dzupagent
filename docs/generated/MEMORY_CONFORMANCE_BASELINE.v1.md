# Memory conformance baseline v1

- Result: **passed**
- Source digest: `sha256:81b31492651c9816be1cd9cd9844d77d0a754c175c2a99f4d47a56f2eacd042a` (155 files)
- Config digest: `sha256:936c9124f40283f5aef5793e2b3c641c6d28c95aeb26c0e08a84245756be0e4c`
- Profile digest: `sha256:f0e161174a3e03d830fbc09ab02e898a82480c3aeba95a55b29d573a0974fe27`
- Result digest: `sha256:54a6b7bc69f27a24d5f54511a5487ed924ce9e5294ffc8eda0d7ea32bf934e4d`
- Provider-free: **passed**
- Live provider: **not-run**
- Production: **not-enabled**

## Suites

| Suite | Status | Passed | Failed | Expected red | Digest |
| --- | --- | ---: | ---: | ---: | --- |
| memory-record-conformance | passed | 5 | 0 | 0 | `sha256:18d74cb950127a1b7f4fd78f0dbf7c940205cdc3edc0897d0381d156d6248276` |
| memory-lifecycle-conformance | passed | 8 | 0 | 0 | `sha256:4f0051bc91552d954c24c2a9cea3419fa30b40140ad7d255a38afc950cb198c3` |
| memory-store-conformance | passed | 8 | 0 | 0 | `sha256:1d3582def1fc62add908766e6ee91f4c35dfe224485c3553c19b35aa7faf7d4d` |
| memory-retrieval-conformance | passed | 9 | 0 | 0 | `sha256:fc90418382e86c5d16c8c94d589155d3d55c2c99a6226601be874364f8867f03` |
| memory-compaction-conformance | passed | 8 | 0 | 0 | `sha256:2753ca64d416e8c23d3e33238e2ddb3805401c0f9181ae8fe1d0cd1b7980fd03` |
| memory-deletion-conformance | passed | 4 | 0 | 0 | `sha256:a99419e3da8bc5885e991bf4bafa3bd208cc23865beadbaf5442ab9f49e5f7d6` |
| memory-worker-conformance | passed | 15 | 0 | 0 | `sha256:bfb27e761ed8268fff4fabe7102ad272ffbf6933626afc03821015cc4a9d2cab` |

## Aggregate

- Cases: 57
- Passed: 57
- Failed: 0
- Expected red: 0
- Unexpected pass: 0
- History contract: `lifecycle-history-evaluated-at-query-as-of`
- Fixture policy: `invented-provider-free-only`

The loader conformance gate is supplemental and is qualified by its package test; this deterministic artifact does not claim aggregate, live-provider, deployment, or production evidence.
