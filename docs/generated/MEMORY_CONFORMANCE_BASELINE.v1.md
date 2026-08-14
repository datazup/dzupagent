# Memory conformance baseline v1

- Result: **passed**
- Source digest: `sha256:2dfcbfd546517b5f7a750972b85d07f4bbf5a87231c270ed4df6d07d1ff35189` (151 files)
- Config digest: `sha256:936c9124f40283f5aef5793e2b3c641c6d28c95aeb26c0e08a84245756be0e4c`
- Profile digest: `sha256:ad515dd103c6f40b55a7acfc7235c3ccd04978a40b25bd6a1718845497b17822`
- Result digest: `sha256:4eaa0ef127fc8d4cd8419552eaf4138ff3592a6c5afd2c6f5511ee4c95e43e63`
- Provider-free: **passed**
- Live provider: **not-run**
- Production: **not-enabled**

## Suites

| Suite | Status | Passed | Failed | Expected red | Digest |
| --- | --- | ---: | ---: | ---: | --- |
| memory-record-conformance | passed | 5 | 0 | 0 | `sha256:a685066715e2dab2b6147084a5e18953649ecf4839ce8902d91a4366cad5a175` |
| memory-lifecycle-conformance | passed | 8 | 0 | 0 | `sha256:5e6d15e70feacbf02a77f8a78597dbeb1d835f4f96d5607fa911f75a2668b1c0` |
| memory-store-conformance | passed | 8 | 0 | 0 | `sha256:03b4231bc512aff440ef6e4a44189bea1359066d1d68e33c0c82d71999bf84ba` |
| memory-retrieval-conformance | passed | 9 | 0 | 0 | `sha256:1f94f489b988558daa29a27a4e81e94daf465ee8af18e10db96fdb2c3f3dbca3` |
| memory-compaction-conformance | passed | 8 | 0 | 0 | `sha256:596f14ee76333debaa1406c54210e83f4dcb6fdf2e7c6ab15a4a5b6e6eb016e1` |
| memory-deletion-conformance | passed | 4 | 0 | 0 | `sha256:c7ddf96aaac5ba25977b49ba40f54320d122a0f7666c87f10970b2d9effec976` |
| memory-worker-conformance | passed | 15 | 0 | 0 | `sha256:5c48ae40101247ca49a1a2af17e9189742f38e6c59ceeb34fa67077f5c1955b4` |

## Aggregate

- Cases: 57
- Passed: 57
- Failed: 0
- Expected red: 0
- Unexpected pass: 0
- History contract: `lifecycle-history-evaluated-at-query-as-of`
- Fixture policy: `invented-provider-free-only`

The loader conformance gate is supplemental and is qualified by its package test; this deterministic artifact does not claim aggregate, live-provider, deployment, or production evidence.
