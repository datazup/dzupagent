# Memory conformance baseline v1

- Result: **passed**
- Source digest: `sha256:3b1bfda0458c57af2f0d9053ca066fdbf40d08619348e4dfe0455521de3f5cd8` (161 files)
- Config digest: `sha256:936c9124f40283f5aef5793e2b3c641c6d28c95aeb26c0e08a84245756be0e4c`
- Profile digest: `sha256:1d1701081438b0f21cf473c5b6bd0608d45b4f5f2edb597e3015e5863f2edaa8`
- Result digest: `sha256:f27edae5acf83bfa6eb084ced9ef415c2b5b93245713a707a8ff8814977b16cb`
- Provider-free: **passed**
- Live provider: **not-run**
- Production: **not-enabled**

## Suites

| Suite | Status | Passed | Failed | Expected red | Digest |
| --- | --- | ---: | ---: | ---: | --- |
| memory-record-conformance | passed | 5 | 0 | 0 | `sha256:5afc1486f3f31ea9b08ae1a9277c3e02fe2773603ff3e481521178fe331442c1` |
| memory-lifecycle-conformance | passed | 8 | 0 | 0 | `sha256:f56090e6689f17a9bca3db837d791532c915a44f17c8ec5283fc2ece1762068d` |
| memory-store-conformance | passed | 8 | 0 | 0 | `sha256:cf2a1fc0a26e103238d4eacbf882a96fa4d49c1c97eba4d58c3befa982df0d89` |
| memory-retrieval-conformance | passed | 9 | 0 | 0 | `sha256:54d80b52af08657f629885bfbba44fca80160ccc8e8ee79ecdd2666d3f7e5b2c` |
| memory-compaction-conformance | passed | 8 | 0 | 0 | `sha256:144c80c61d19c8368c38106875ad587ba71d6b5a551ffc788c495dcece59705e` |
| memory-deletion-conformance | passed | 4 | 0 | 0 | `sha256:d385122bf23df1230f9703b4e602af7563730c0ac87c1f5f255be663c66ecfff` |
| memory-worker-conformance | passed | 15 | 0 | 0 | `sha256:35f15075052f3f92fc62db13d5cf38a9e75d3b1a1fa111add6de6af0dabd8abe` |

## Aggregate

- Cases: 57
- Passed: 57
- Failed: 0
- Expected red: 0
- Unexpected pass: 0
- History contract: `lifecycle-history-evaluated-at-query-as-of`
- Fixture policy: `invented-provider-free-only`

The loader conformance gate is supplemental and is qualified by its package test; this deterministic artifact does not claim aggregate, live-provider, deployment, or production evidence.
