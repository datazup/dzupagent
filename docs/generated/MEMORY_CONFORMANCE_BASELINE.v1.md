# Memory conformance baseline v1

- Result: **passed**
- Source digest: `sha256:410fef690b0551e5d13912bcea1030b65a85f7fdd30febeb10d872c9f668c987` (161 files)
- Config digest: `sha256:936c9124f40283f5aef5793e2b3c641c6d28c95aeb26c0e08a84245756be0e4c`
- Profile digest: `sha256:1e15057205db0a0c36aa6425263227bee53e82e71315e7f6ef7271ae0058e898`
- Result digest: `sha256:9bb4b2acead3b7fd45a43760d692e97adfc4ae6cc1b111f254999b1bc897fb00`
- Provider-free: **passed**
- Live provider: **not-run**
- Production: **not-enabled**

## Suites

| Suite | Status | Passed | Failed | Expected red | Digest |
| --- | --- | ---: | ---: | ---: | --- |
| memory-record-conformance | passed | 5 | 0 | 0 | `sha256:d1fe805da9ef59052cf2469844a033a3514dd84c648d74115dc43fb5b6ed9c77` |
| memory-lifecycle-conformance | passed | 8 | 0 | 0 | `sha256:9d39fca9364881003938dc665bf81d7b696bc26bd3266cc46e0096d48fc76772` |
| memory-store-conformance | passed | 8 | 0 | 0 | `sha256:5981b917a4e3ae2b262bd0a26c9cf8597a26d6fa758305b5bc1ce5cd6038cc92` |
| memory-retrieval-conformance | passed | 9 | 0 | 0 | `sha256:18d9b8e1c32022c0452739d2d75824d33f416f9ca717bc771f0ce2d4d8c2778d` |
| memory-compaction-conformance | passed | 8 | 0 | 0 | `sha256:e7b259277cdbf8e817564ade7fa8224484e5d74a08ecbf45f6e5d20986f51e14` |
| memory-deletion-conformance | passed | 4 | 0 | 0 | `sha256:9ee16f9d5060d6bae9b989369da946a2d9e8f21b0fd6f76bf8c0ee886f299219` |
| memory-worker-conformance | passed | 15 | 0 | 0 | `sha256:3f8f6ad632ce1bf57680eddf9294c58abc3a69c49d551f3ef5d8d358aada5a52` |

## Aggregate

- Cases: 57
- Passed: 57
- Failed: 0
- Expected red: 0
- Unexpected pass: 0
- History contract: `lifecycle-history-evaluated-at-query-as-of`
- Fixture policy: `invented-provider-free-only`

The loader conformance gate is supplemental and is qualified by its package test; this deterministic artifact does not claim aggregate, live-provider, deployment, or production evidence.
