# Memory conformance baseline v1

- Result: **passed**
- Source digest: `sha256:7d03d7d2c363c54d7c34962c460ad1a17b4a53d620c60d3f45b35d5c02c8349b` (161 files)
- Config digest: `sha256:936c9124f40283f5aef5793e2b3c641c6d28c95aeb26c0e08a84245756be0e4c`
- Profile digest: `sha256:547104639cd1ca2d0e6ffeb5ef637d4938a48e5b2ad6280cbb77e088ab1ac3a8`
- Result digest: `sha256:b8a1c4940022bc504d891f917a564747a4a95d7e30add209c4baad9b7b926974`
- Provider-free: **passed**
- Live provider: **not-run**
- Production: **not-enabled**

## Suites

| Suite | Status | Passed | Failed | Expected red | Digest |
| --- | --- | ---: | ---: | ---: | --- |
| memory-record-conformance | passed | 5 | 0 | 0 | `sha256:a6da22c77bb8460c088269e5197057207291f0e6772421a21990e94b0b8e6b21` |
| memory-lifecycle-conformance | passed | 8 | 0 | 0 | `sha256:8203755fbf65b66b9fcbbf9ae5c18bd57368b553ba167ca07c971a8908b31449` |
| memory-store-conformance | passed | 8 | 0 | 0 | `sha256:003e078bea6bd872cbd00acaabb69f6a0da826510ad3f53004cbd605a16b66bf` |
| memory-retrieval-conformance | passed | 9 | 0 | 0 | `sha256:421dea1d4e4abedf162769f7119fc5e62de3595df65c5647093553ead0444c28` |
| memory-compaction-conformance | passed | 8 | 0 | 0 | `sha256:3a090273802f44dc6b2889a5f621ace118e6f12e20f856082d6aaa7addb929ba` |
| memory-deletion-conformance | passed | 4 | 0 | 0 | `sha256:7a6a46ced83fbdf4fb39f5391b843cb24a58b25e8eb17a7bfd62fd4d59261aaf` |
| memory-worker-conformance | passed | 15 | 0 | 0 | `sha256:01b6c429a053aa64f957e4cef7c3cd599610283d1df81d046741c6418eb2e879` |

## Aggregate

- Cases: 57
- Passed: 57
- Failed: 0
- Expected red: 0
- Unexpected pass: 0
- History contract: `lifecycle-history-evaluated-at-query-as-of`
- Fixture policy: `invented-provider-free-only`

The loader conformance gate is supplemental and is qualified by its package test; this deterministic artifact does not claim aggregate, live-provider, deployment, or production evidence.
