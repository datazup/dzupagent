# Memory conformance baseline v1

- Result: **passed**
- Source digest: `sha256:acedccff1a0d6b81e442be27b9b13dd25d5cd4d47bca978c7e310686aa7b2f49` (155 files)
- Config digest: `sha256:936c9124f40283f5aef5793e2b3c641c6d28c95aeb26c0e08a84245756be0e4c`
- Profile digest: `sha256:8cc73c5c73f4ec685edad5d19d71b9f6066b587137e13f3044aad28a76cfabd4`
- Result digest: `sha256:5f5b5a82d0471601353513ec03c55bdc7736508e0f52f64aea41c4b41abf2a6c`
- Provider-free: **passed**
- Live provider: **not-run**
- Production: **not-enabled**

## Suites

| Suite | Status | Passed | Failed | Expected red | Digest |
| --- | --- | ---: | ---: | ---: | --- |
| memory-record-conformance | passed | 5 | 0 | 0 | `sha256:0631be8e4ca1cd98d8568999f1f6513f8f9e9b2318a8b4783451fc41003f5be0` |
| memory-lifecycle-conformance | passed | 8 | 0 | 0 | `sha256:c249f4d5970e179c8acb4a9dacd539e963980a1064659039baad37aafc527e33` |
| memory-store-conformance | passed | 8 | 0 | 0 | `sha256:ec234d4665b943f93fcf65f76d191d88c5fa5d4bdb515f05e3a833b15a69c8d2` |
| memory-retrieval-conformance | passed | 9 | 0 | 0 | `sha256:93073e59f001a899dbcd4ea9d7b5c957837c87f768bd8e07c999353b7c5a96e0` |
| memory-compaction-conformance | passed | 8 | 0 | 0 | `sha256:8371c742acfbcc7bb7780c018e2129a1482127946fa10e0428fa3e119124d93b` |
| memory-deletion-conformance | passed | 4 | 0 | 0 | `sha256:ff43b6c08b0b20a50358b89f074f7d92e734ec8d46ae4b9311f33090ad326010` |
| memory-worker-conformance | passed | 15 | 0 | 0 | `sha256:89052197aadd7193dc163ea910c0871aafedb4ef342ff6bef064c821e5ffed3a` |

## Aggregate

- Cases: 57
- Passed: 57
- Failed: 0
- Expected red: 0
- Unexpected pass: 0
- History contract: `lifecycle-history-evaluated-at-query-as-of`
- Fixture policy: `invented-provider-free-only`

The loader conformance gate is supplemental and is qualified by its package test; this deterministic artifact does not claim aggregate, live-provider, deployment, or production evidence.
