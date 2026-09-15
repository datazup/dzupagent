# Memory conformance baseline v1

- Result: **passed**
- Source digest: `sha256:98bfd7e7d4217d1efe9bbe5ba3edd1e23479f0aabdf5265877b0de8c97702b1d` (155 files)
- Config digest: `sha256:936c9124f40283f5aef5793e2b3c641c6d28c95aeb26c0e08a84245756be0e4c`
- Profile digest: `sha256:8303c1defbf08f97b0ce83a60bf61711d5a522ce85fcec92a36bdde4c773cffc`
- Result digest: `sha256:9ea1213f76d30d140793c621380ed2d4c4cafea52dcaebe65cbf4cb5732a8fa0`
- Provider-free: **passed**
- Live provider: **not-run**
- Production: **not-enabled**

## Suites

| Suite | Status | Passed | Failed | Expected red | Digest |
| --- | --- | ---: | ---: | ---: | --- |
| memory-record-conformance | passed | 5 | 0 | 0 | `sha256:63173a1ac7689e70176192f954dc149c8ccd8f9bb3b63b06106efc430dcee65a` |
| memory-lifecycle-conformance | passed | 8 | 0 | 0 | `sha256:74a54856c54056ab4f6160b4509350611af1afabd0fc193423c5f55d299aa950` |
| memory-store-conformance | passed | 8 | 0 | 0 | `sha256:4b33e5acf58f1ab32a6d6a605c8e4bc3e14d4ef8552c8671c3f4f5c7c28a685c` |
| memory-retrieval-conformance | passed | 9 | 0 | 0 | `sha256:b878936cd9a150e807ecff6a28232c2d84dbbb9d7957de64fe88bcad737ee724` |
| memory-compaction-conformance | passed | 8 | 0 | 0 | `sha256:7dc51f099ea4adfd59f235d6025e54f28162c8eccab568526792ceddad5e5547` |
| memory-deletion-conformance | passed | 4 | 0 | 0 | `sha256:12d1033123037dcf48dc72138e59923088ee7bbfb43ef1a8dcb4fecea0b0a285` |
| memory-worker-conformance | passed | 15 | 0 | 0 | `sha256:3743652e64e91cf3fcaf903ce8cdd92f14aa04fd48c00749ce045251fedac46c` |

## Aggregate

- Cases: 57
- Passed: 57
- Failed: 0
- Expected red: 0
- Unexpected pass: 0
- History contract: `lifecycle-history-evaluated-at-query-as-of`
- Fixture policy: `invented-provider-free-only`

The loader conformance gate is supplemental and is qualified by its package test; this deterministic artifact does not claim aggregate, live-provider, deployment, or production evidence.
