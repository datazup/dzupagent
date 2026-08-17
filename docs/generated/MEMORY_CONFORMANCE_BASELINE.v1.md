# Memory conformance baseline v1

- Result: **passed**
- Source digest: `sha256:c15a5385c6b5b729d94c2ef8866f829e358b77f0515395e8aa97adfdba0eb6c8` (151 files)
- Config digest: `sha256:936c9124f40283f5aef5793e2b3c641c6d28c95aeb26c0e08a84245756be0e4c`
- Profile digest: `sha256:66404d4b083dfe8b4a3a1c32e16785f426ec41bf5dbcb386edd76cf588fb2967`
- Result digest: `sha256:de5d67ebb5aaec987825263e6c6c022a7f95b9a3fa9557f0ccc19f46fd223491`
- Provider-free: **passed**
- Live provider: **not-run**
- Production: **not-enabled**

## Suites

| Suite | Status | Passed | Failed | Expected red | Digest |
| --- | --- | ---: | ---: | ---: | --- |
| memory-record-conformance | passed | 5 | 0 | 0 | `sha256:6218160650fae98350b9f40c9d683b7ec0782567f26bf53fd3f216e3da9ab155` |
| memory-lifecycle-conformance | passed | 8 | 0 | 0 | `sha256:8f054354416e9cf927afe6251acae6bbe5dfd9f98cb93758fa23b61585f4ca95` |
| memory-store-conformance | passed | 8 | 0 | 0 | `sha256:4ee86e61ed3698b0da34cc91efb4b166bc47be406b42f7fc1c52d1745712a8d1` |
| memory-retrieval-conformance | passed | 9 | 0 | 0 | `sha256:acd460c3194df7924eed2b4d0f68f51de0b54df594d2a2989d20f5711ebb4b77` |
| memory-compaction-conformance | passed | 8 | 0 | 0 | `sha256:39f8dae84b1c156fe8260d7079ec82b80234bef2e15d9477b40aae0f220d1a6a` |
| memory-deletion-conformance | passed | 4 | 0 | 0 | `sha256:b98ff86872e544577d8cd6341c1cc11452069679c4c03ab14af2fdbace6c5e72` |
| memory-worker-conformance | passed | 15 | 0 | 0 | `sha256:feb6b7ac7e0a658f45a5ac272317f56353587acfc742dd659f9b8e6dd46a6e4f` |

## Aggregate

- Cases: 57
- Passed: 57
- Failed: 0
- Expected red: 0
- Unexpected pass: 0
- History contract: `lifecycle-history-evaluated-at-query-as-of`
- Fixture policy: `invented-provider-free-only`

The loader conformance gate is supplemental and is qualified by its package test; this deterministic artifact does not claim aggregate, live-provider, deployment, or production evidence.
