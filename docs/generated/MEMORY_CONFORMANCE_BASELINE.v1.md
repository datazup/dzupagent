# Memory conformance baseline v1

- Result: **passed**
- Source digest: `sha256:d70e6f6ad47aaf79c5b46353a3df95ef56129cc8fcec1816dcfb544e850c992c` (151 files)
- Config digest: `sha256:936c9124f40283f5aef5793e2b3c641c6d28c95aeb26c0e08a84245756be0e4c`
- Profile digest: `sha256:93a38b8ec86b8e5a9e575044bf4d676f632461f48fb46fb9909fd6c05301f290`
- Result digest: `sha256:72eb16d95927615d86076495880dfc5a1d5fa543f095a933087cab1ddceff55f`
- Provider-free: **passed**
- Live provider: **not-run**
- Production: **not-enabled**

## Suites

| Suite | Status | Passed | Failed | Expected red | Digest |
| --- | --- | ---: | ---: | ---: | --- |
| memory-record-conformance | passed | 5 | 0 | 0 | `sha256:5ba3fd23d87fc3c77a5fde98975864803be56117713d0c80505c405074eab1b7` |
| memory-lifecycle-conformance | passed | 8 | 0 | 0 | `sha256:413ac0bd0c21d1120b09087ea08ee64a08534418b8b08536fd5f05aa69f681db` |
| memory-store-conformance | passed | 8 | 0 | 0 | `sha256:fd0814abccf1242d7dc86c379bf07aa53787fd7c3470c60bb251abedd17e62b5` |
| memory-retrieval-conformance | passed | 9 | 0 | 0 | `sha256:5b62ed6b0d58e577dd9ddb1af9025916935f945c257628592a414e7faff28f1c` |
| memory-compaction-conformance | passed | 8 | 0 | 0 | `sha256:1dff3c9c870cc088c215b81a1df8948ba7555a98e0aa52d65b64934f3a0322da` |
| memory-deletion-conformance | passed | 4 | 0 | 0 | `sha256:0c89b74078d98c0040bc6d40f2419d4b2fbf0597315ad22c5569746cdd94af2c` |
| memory-worker-conformance | passed | 15 | 0 | 0 | `sha256:0f0ef064fb4dd960c5a80e6d70b02a8a2d7bbba93ba85d2564733f7c3910f71d` |

## Aggregate

- Cases: 57
- Passed: 57
- Failed: 0
- Expected red: 0
- Unexpected pass: 0
- History contract: `lifecycle-history-evaluated-at-query-as-of`
- Fixture policy: `invented-provider-free-only`

The loader conformance gate is supplemental and is qualified by its package test; this deterministic artifact does not claim aggregate, live-provider, deployment, or production evidence.
