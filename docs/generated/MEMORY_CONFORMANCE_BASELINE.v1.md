# Memory conformance baseline v1

- Result: **passed**
- Source digest: `sha256:c9b00cce148f4af41f29c7195b5fa0edc6b4024d4430170972c4e94d8b6bacfb` (155 files)
- Config digest: `sha256:936c9124f40283f5aef5793e2b3c641c6d28c95aeb26c0e08a84245756be0e4c`
- Profile digest: `sha256:e358ac01665ce1f9c972e3ddfab8f89eaba47f4114568a395d07f3b0626a0d29`
- Result digest: `sha256:ea0aa95fd91834acfe97fcf420f35bded56de66de2a025d497a89c3eebc64f16`
- Provider-free: **passed**
- Live provider: **not-run**
- Production: **not-enabled**

## Suites

| Suite | Status | Passed | Failed | Expected red | Digest |
| --- | --- | ---: | ---: | ---: | --- |
| memory-record-conformance | passed | 5 | 0 | 0 | `sha256:859ba18c5c3b3ecd2666a9451bf774beadcf0ccb5f906c0daecc3918c1ca6497` |
| memory-lifecycle-conformance | passed | 8 | 0 | 0 | `sha256:8ddb2c1a23b7eb8864c6d6b5a769184252c20337d363bd57179ab245e666f48f` |
| memory-store-conformance | passed | 8 | 0 | 0 | `sha256:955d6d36316383571d633ac8f2c241ea9622eb0ca57be67b87fb2feb3a438b4e` |
| memory-retrieval-conformance | passed | 9 | 0 | 0 | `sha256:8e0c227634b7fae6359b61065bcc2ad1b2a2bf02dfb6e14849fc61678dcaa7dc` |
| memory-compaction-conformance | passed | 8 | 0 | 0 | `sha256:c58823600012e76b403f450d62c861214eb5deacf663cf7d79c9a23881dfd457` |
| memory-deletion-conformance | passed | 4 | 0 | 0 | `sha256:38906ae1649f4b4d4a9ba77e00a72fa87fdaf7a809949fdb8b0fd950e992bc0b` |
| memory-worker-conformance | passed | 15 | 0 | 0 | `sha256:b737059772653f212484c99dcbe74025d904ea41f5a77576bf587c68944d4d35` |

## Aggregate

- Cases: 57
- Passed: 57
- Failed: 0
- Expected red: 0
- Unexpected pass: 0
- History contract: `lifecycle-history-evaluated-at-query-as-of`
- Fixture policy: `invented-provider-free-only`

The loader conformance gate is supplemental and is qualified by its package test; this deterministic artifact does not claim aggregate, live-provider, deployment, or production evidence.
