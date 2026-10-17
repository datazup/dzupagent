# Memory conformance baseline v1

- Result: **passed**
- Source digest: `sha256:f242aceab6ebec947e67c0b122c462c95ec3b07f66d7799f704e07473083c0fa` (161 files)
- Config digest: `sha256:936c9124f40283f5aef5793e2b3c641c6d28c95aeb26c0e08a84245756be0e4c`
- Profile digest: `sha256:8c7a1c7c8a7ca7d414c1c140366cb169c82a8298363c66010d7e415ffce029f2`
- Result digest: `sha256:2f070a54a3586576aa2ed1b114efce4754105a0a5d810ca4c137d56f8d482ca5`
- Provider-free: **passed**
- Live provider: **not-run**
- Production: **not-enabled**

## Suites

| Suite | Status | Passed | Failed | Expected red | Digest |
| --- | --- | ---: | ---: | ---: | --- |
| memory-record-conformance | passed | 5 | 0 | 0 | `sha256:07a2ce283cae351e5a1839b536b5c6ed7da0b716775156bb33c199279c626380` |
| memory-lifecycle-conformance | passed | 8 | 0 | 0 | `sha256:16b81cb4ea14ec0a1a86ad667aab96d88a1eb2a3a847ca2fea6ad593b01c4167` |
| memory-store-conformance | passed | 8 | 0 | 0 | `sha256:886da565458de37c487bcb9599bb9b22158b2e3e0e437d23e6409eaeb433eee5` |
| memory-retrieval-conformance | passed | 9 | 0 | 0 | `sha256:d8cf956843caf5d505c4ee679615042156c9797b24900917e5e763e9c4ed68db` |
| memory-compaction-conformance | passed | 8 | 0 | 0 | `sha256:73ae9704bc16c2ef5af70dee41c8d9da96634a80b4dc721deb03cd25d5613130` |
| memory-deletion-conformance | passed | 4 | 0 | 0 | `sha256:ca00759e39ee7c694dc6fc6bf74a3bf9479bad328ca5ff50186de48613e09d23` |
| memory-worker-conformance | passed | 15 | 0 | 0 | `sha256:697549ecf72f17cc77f8bff8a747c9f1f61a777c316d3d4f14d68aa6d48c6291` |

## Aggregate

- Cases: 57
- Passed: 57
- Failed: 0
- Expected red: 0
- Unexpected pass: 0
- History contract: `lifecycle-history-evaluated-at-query-as-of`
- Fixture policy: `invented-provider-free-only`

The loader conformance gate is supplemental and is qualified by its package test; this deterministic artifact does not claim aggregate, live-provider, deployment, or production evidence.
