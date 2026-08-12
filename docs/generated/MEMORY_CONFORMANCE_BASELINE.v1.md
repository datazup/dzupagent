# Memory conformance baseline v1

- Result: **passed**
- Source digest: `sha256:78fb9441d226b9c5fc0404afae7b91c46aac0181d29ef2bf3158da5cadaaaf5b` (139 files)
- Config digest: `sha256:55f4858fd5d6e73cfc2f57988f8e8f5995e6009a0f6aa229799dfff5510e231a`
- Profile digest: `sha256:76932cfd14a182bce62dbebe0b1d58461590e43e983f0b3bbd9faa485ea615c6`
- Result digest: `sha256:6ca23c1ec7823f3bf48446ae196095949e78b908f45a0c7583aa2e8f68b18f0b`
- Provider-free: **passed**
- Live provider: **not-run**
- Production: **not-enabled**

## Suites

| Suite | Status | Passed | Failed | Expected red | Digest |
| --- | --- | ---: | ---: | ---: | --- |
| memory-record-conformance | passed | 5 | 0 | 0 | `sha256:1f259c819fd8b2234eef2b639b05be520b2acd79343f5818f415a82369704baa` |
| memory-lifecycle-conformance | passed | 8 | 0 | 0 | `sha256:8caee5e45fe84cf8c35fe40e42004edbe7865edc37e2ad497066e750dabe8c6b` |
| memory-store-conformance | passed | 8 | 0 | 0 | `sha256:7fbbb73fadb907e2eb4020a0de346f5b06a685baae9f473c539f8b7a3ce5a0ab` |
| memory-retrieval-conformance | passed | 9 | 0 | 0 | `sha256:6f29adc2ec6d0012e74171e21afd9a849d5895e63064b7188dbfe2bdab60b5fb` |
| memory-compaction-conformance | passed | 8 | 0 | 0 | `sha256:0b8642c4c927df2d8305461b7d4227ca7982c23d6e81dc7f3ee8efbfb933266e` |
| memory-deletion-conformance | passed | 4 | 0 | 0 | `sha256:cb23e7cd3c6657ebc161afe7e76f0b61312a1d0e572843cba5e3ac958c452e69` |
| memory-worker-conformance | passed | 15 | 0 | 0 | `sha256:196d51ed58c8bf45f60d549c6bf051081cb13579b4b7cbec27c058de54ab6ea7` |

## Aggregate

- Cases: 57
- Passed: 57
- Failed: 0
- Expected red: 0
- Unexpected pass: 0
- History contract: `lifecycle-history-evaluated-at-query-as-of`
- Fixture policy: `invented-provider-free-only`

The loader conformance gate is supplemental and is qualified by its package test; this deterministic artifact does not claim aggregate, live-provider, deployment, or production evidence.
