# Memory conformance baseline v1

- Result: **passed**
- Source digest: `sha256:6af9ce7c0495b5969873f06d48318fd9a5563cb48d5b2fbb12bed439c21e9408` (151 files)
- Config digest: `sha256:936c9124f40283f5aef5793e2b3c641c6d28c95aeb26c0e08a84245756be0e4c`
- Profile digest: `sha256:2fb868de064cd7dc79a7b503dadda84819ca9e9468cbef4a44ce8edd546963d2`
- Result digest: `sha256:28d056361917b0ba244ce2bd0ae01af9434237cf69e6fd326aed61029db379ca`
- Provider-free: **passed**
- Live provider: **not-run**
- Production: **not-enabled**

## Suites

| Suite | Status | Passed | Failed | Expected red | Digest |
| --- | --- | ---: | ---: | ---: | --- |
| memory-record-conformance | passed | 5 | 0 | 0 | `sha256:66f074a0085b83b6653de41eaef120199798b6d819854af639276e60f2e317bf` |
| memory-lifecycle-conformance | passed | 8 | 0 | 0 | `sha256:0002ff66f099dd95f048d5310e952a59069f16f2f21d8ad4134965e1209accdb` |
| memory-store-conformance | passed | 8 | 0 | 0 | `sha256:b92ceb73393f51abf043f3e5ba72c5c5cf6ae46a72e4c270ffb8dc6635f757c0` |
| memory-retrieval-conformance | passed | 9 | 0 | 0 | `sha256:11614fe459b541a0623e391eb8a3915c7eca8993c3edea1587c3beca195364cd` |
| memory-compaction-conformance | passed | 8 | 0 | 0 | `sha256:6564bb1ed5b44fec67238bec254714bdc151bbea33037ba1aa51ca845f77686b` |
| memory-deletion-conformance | passed | 4 | 0 | 0 | `sha256:614ba6a1cbe6b92cc9e6bd4b03b4beb7dad356dec0afff54a13d18be451aebd6` |
| memory-worker-conformance | passed | 15 | 0 | 0 | `sha256:95ba6d0cdb1b1a5a742dd1aca23fd5d46bb377fe43b3618122ab9d95a36bdffd` |

## Aggregate

- Cases: 57
- Passed: 57
- Failed: 0
- Expected red: 0
- Unexpected pass: 0
- History contract: `lifecycle-history-evaluated-at-query-as-of`
- Fixture policy: `invented-provider-free-only`

The loader conformance gate is supplemental and is qualified by its package test; this deterministic artifact does not claim aggregate, live-provider, deployment, or production evidence.
