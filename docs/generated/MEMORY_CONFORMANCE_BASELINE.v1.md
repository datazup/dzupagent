# Memory conformance baseline v1

- Result: **passed**
- Source digest: `sha256:7a44ba8f153f47935201530d238ca2bf9a1abbbbfe8b77b055ccbb77bb7d145c` (151 files)
- Config digest: `sha256:936c9124f40283f5aef5793e2b3c641c6d28c95aeb26c0e08a84245756be0e4c`
- Profile digest: `sha256:28eeaef7b19af0f056ed15b3c2525fdd76ac4c02987a626194a4f5fe3ce77b21`
- Result digest: `sha256:5a1e5877c04d918b589ae0e850982178d94c79cddaafb00d344ebc3f894ff3ac`
- Provider-free: **passed**
- Live provider: **not-run**
- Production: **not-enabled**

## Suites

| Suite | Status | Passed | Failed | Expected red | Digest |
| --- | --- | ---: | ---: | ---: | --- |
| memory-record-conformance | passed | 5 | 0 | 0 | `sha256:15ea244d92433515f215047a671c8f4d210b191683918e9ef986310791d3b4fb` |
| memory-lifecycle-conformance | passed | 8 | 0 | 0 | `sha256:c98f637818a3c25d6bee02ddf562a78b60daced93a9d347d757df19634c7d102` |
| memory-store-conformance | passed | 8 | 0 | 0 | `sha256:bceb30a5a55d681d2e136c6b4d53da05ccc1228f7477f4b20bc0be0b2bf92a23` |
| memory-retrieval-conformance | passed | 9 | 0 | 0 | `sha256:af98c2f937c48bea1d174382e1ee7c9aade23be98e7a18ef25d661bda442c637` |
| memory-compaction-conformance | passed | 8 | 0 | 0 | `sha256:a49cf1b7545f96c4109cbd12b87c64083e5427a76f29b85942f81c31e829fde7` |
| memory-deletion-conformance | passed | 4 | 0 | 0 | `sha256:4f72c7f8573ac184e3f08d0435484f8422324f4066e282655640c2dcd8c83717` |
| memory-worker-conformance | passed | 15 | 0 | 0 | `sha256:38807f79d158d12d71a30d11401c8e2a1aa426f258d84576a6d0a3344d6d75e8` |

## Aggregate

- Cases: 57
- Passed: 57
- Failed: 0
- Expected red: 0
- Unexpected pass: 0
- History contract: `lifecycle-history-evaluated-at-query-as-of`
- Fixture policy: `invented-provider-free-only`

The loader conformance gate is supplemental and is qualified by its package test; this deterministic artifact does not claim aggregate, live-provider, deployment, or production evidence.
