# Memory conformance baseline v1

- Result: **passed**
- Source digest: `sha256:ba859c338730d0d4fa2775b8efac4e3466bdc6806c54b1351d1d38c00468a7cc` (155 files)
- Config digest: `sha256:936c9124f40283f5aef5793e2b3c641c6d28c95aeb26c0e08a84245756be0e4c`
- Profile digest: `sha256:4ea9b39407343cdc85571a21e3ca32fe3ce471e236aff68de84f50fbde19e771`
- Result digest: `sha256:25588060619c8e018408c6861f95ad41610e69a05a423836e6bb629ac76ae688`
- Provider-free: **passed**
- Live provider: **not-run**
- Production: **not-enabled**

## Suites

| Suite | Status | Passed | Failed | Expected red | Digest |
| --- | --- | ---: | ---: | ---: | --- |
| memory-record-conformance | passed | 5 | 0 | 0 | `sha256:fb2d6f656413af8bba889c676db55fcf8cb0d88d0fc2c0199f06b562d8e421f0` |
| memory-lifecycle-conformance | passed | 8 | 0 | 0 | `sha256:d5992b01edf7d3d122650a29f585048f1332182987c924f170bffe266c2fde79` |
| memory-store-conformance | passed | 8 | 0 | 0 | `sha256:08f6a57add17d613f73dc76cfc6ba708519929969c2b849314b799346e961f21` |
| memory-retrieval-conformance | passed | 9 | 0 | 0 | `sha256:2bf405bad22c019e6fd1276e21cd3aa4be06e502e4bee24f64dcb65c8be126de` |
| memory-compaction-conformance | passed | 8 | 0 | 0 | `sha256:943afadce8b888cfebdbdae28c15f5b7501c1d6168eb7178efe2cd4fed780394` |
| memory-deletion-conformance | passed | 4 | 0 | 0 | `sha256:274fc152916b4f44f91557134f7e3dc90307d7fa841018b550b2f4cceee384cc` |
| memory-worker-conformance | passed | 15 | 0 | 0 | `sha256:af1bb2787af481497b92500c7ccdb60799374fda08a14db7ea8b4fd0f0eaed8e` |

## Aggregate

- Cases: 57
- Passed: 57
- Failed: 0
- Expected red: 0
- Unexpected pass: 0
- History contract: `lifecycle-history-evaluated-at-query-as-of`
- Fixture policy: `invented-provider-free-only`

The loader conformance gate is supplemental and is qualified by its package test; this deterministic artifact does not claim aggregate, live-provider, deployment, or production evidence.
