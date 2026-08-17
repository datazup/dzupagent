# Memory conformance baseline v1

- Result: **passed**
- Source digest: `sha256:501ebd0ca45a12b50f6a237815eff2fad001a9abfa86c2b7aee087a39fa4b8bf` (151 files)
- Config digest: `sha256:936c9124f40283f5aef5793e2b3c641c6d28c95aeb26c0e08a84245756be0e4c`
- Profile digest: `sha256:7d516e02a8ecec6a1bded444da8e1bc6270d365de7acc3a8396c1ff523cddb1f`
- Result digest: `sha256:7462c617c1737ca9769066ff43482c72700896dc592e824b7f2042b26da00e97`
- Provider-free: **passed**
- Live provider: **not-run**
- Production: **not-enabled**

## Suites

| Suite | Status | Passed | Failed | Expected red | Digest |
| --- | --- | ---: | ---: | ---: | --- |
| memory-record-conformance | passed | 5 | 0 | 0 | `sha256:757315febcabd69f802fab3c767136481097453a5933b58622b816972bb63a29` |
| memory-lifecycle-conformance | passed | 8 | 0 | 0 | `sha256:e315cc4a9ccf58b4813b971bb170dc5c9e84565b2beb3e50f0a0299d9ec74654` |
| memory-store-conformance | passed | 8 | 0 | 0 | `sha256:60ae00e08da7961912247c23399980fb9df55913c9497dcbdcff14d3992c4ab9` |
| memory-retrieval-conformance | passed | 9 | 0 | 0 | `sha256:5ed7938d18f651b3803e994c166b73ab5f33cb8d44623e155a1a32dfa1143e03` |
| memory-compaction-conformance | passed | 8 | 0 | 0 | `sha256:523cfe1411bc8e4478af666de7cf1128851bb68d37581e189dccb386daeb8942` |
| memory-deletion-conformance | passed | 4 | 0 | 0 | `sha256:bb0ed6a4456b263dd49f9112376554df93d7cf25a4cafa388dda33aaebc2fb67` |
| memory-worker-conformance | passed | 15 | 0 | 0 | `sha256:d351af4c80d4862b45f61fd0fd1783e31a4c07ad30a43a56409a0b31028dcfa8` |

## Aggregate

- Cases: 57
- Passed: 57
- Failed: 0
- Expected red: 0
- Unexpected pass: 0
- History contract: `lifecycle-history-evaluated-at-query-as-of`
- Fixture policy: `invented-provider-free-only`

The loader conformance gate is supplemental and is qualified by its package test; this deterministic artifact does not claim aggregate, live-provider, deployment, or production evidence.
