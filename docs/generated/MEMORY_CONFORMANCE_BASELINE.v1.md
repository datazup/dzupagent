# Memory conformance baseline v1

- Result: **passed**
- Source digest: `sha256:b5acca6b05eb065e096f02265c7c15556281df51a9294191e9f62f77af4f836c` (161 files)
- Config digest: `sha256:936c9124f40283f5aef5793e2b3c641c6d28c95aeb26c0e08a84245756be0e4c`
- Profile digest: `sha256:0972a62c438457e07a004511e14f4d724832405749c17a22829f202d755d8001`
- Result digest: `sha256:4d5ce8208b0bc736ec406980af78aa49e795e704b56bda052888d273f94068c4`
- Provider-free: **passed**
- Live provider: **not-run**
- Production: **not-enabled**

## Suites

| Suite | Status | Passed | Failed | Expected red | Digest |
| --- | --- | ---: | ---: | ---: | --- |
| memory-record-conformance | passed | 5 | 0 | 0 | `sha256:9370b6e644b9d8e2bf28d51a6ed89d197037467ed4f01b308fb8b16c9559d338` |
| memory-lifecycle-conformance | passed | 8 | 0 | 0 | `sha256:3e40021aeb1fbf85caaab782416e674db827a6d5eaf71780eee646f94a548732` |
| memory-store-conformance | passed | 8 | 0 | 0 | `sha256:4e15ee775d60c07d62a5b634c4d42d3456636847bad6e5faf0e37d714b03e7c1` |
| memory-retrieval-conformance | passed | 9 | 0 | 0 | `sha256:2ad8593f45bc67245e7aae84ed1a52fa61c523a995a79017cf361d61650c4131` |
| memory-compaction-conformance | passed | 8 | 0 | 0 | `sha256:9b3c966ff966de0c5fd1b89cfd97e0634d423d9ef37ea89f4009bc6c9f03216b` |
| memory-deletion-conformance | passed | 4 | 0 | 0 | `sha256:ca85c4f9ccd57aedc6fc330fe6e8daabefce8a647e5507cf4e913f5963670596` |
| memory-worker-conformance | passed | 15 | 0 | 0 | `sha256:01c97bbca8dade2d934dd9dccf59d0f274abca820e375bd4ba8eb67605f0407f` |

## Aggregate

- Cases: 57
- Passed: 57
- Failed: 0
- Expected red: 0
- Unexpected pass: 0
- History contract: `lifecycle-history-evaluated-at-query-as-of`
- Fixture policy: `invented-provider-free-only`

The loader conformance gate is supplemental and is qualified by its package test; this deterministic artifact does not claim aggregate, live-provider, deployment, or production evidence.
