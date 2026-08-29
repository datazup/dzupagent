# Memory conformance baseline v1

- Result: **passed**
- Source digest: `sha256:372e6901b914b9320817e5534156ae5636a20e5353b1fbaeafae3ba96ed52faf` (155 files)
- Config digest: `sha256:936c9124f40283f5aef5793e2b3c641c6d28c95aeb26c0e08a84245756be0e4c`
- Profile digest: `sha256:6894901049bd02706c2198fc68d5af6bf2bbc5f4718fc4685f0ca6302b397b1d`
- Result digest: `sha256:5504930d45ec82bd678270baf6e24b4a647a25d551b20deba2af8d0401026926`
- Provider-free: **passed**
- Live provider: **not-run**
- Production: **not-enabled**

## Suites

| Suite | Status | Passed | Failed | Expected red | Digest |
| --- | --- | ---: | ---: | ---: | --- |
| memory-record-conformance | passed | 5 | 0 | 0 | `sha256:c3b70414dcd515251000578dcdea04fec2490db31e381a98847d1735c27cfd4c` |
| memory-lifecycle-conformance | passed | 8 | 0 | 0 | `sha256:f5b0fdb25ddd4121a6ddf4220ef3fb0bc029d02a797315a050d7eae88a217e61` |
| memory-store-conformance | passed | 8 | 0 | 0 | `sha256:19a9f2e4c55422fca233623258941d01070f360f9a01a213d469a050dc5f0ab0` |
| memory-retrieval-conformance | passed | 9 | 0 | 0 | `sha256:8b037428d21ddaa56eadff9b3efc4d90a2efa8154afd02ec9fe2236eeb9ffc24` |
| memory-compaction-conformance | passed | 8 | 0 | 0 | `sha256:ec6a8c8e81f3db7ba21d398f62cd4c006521dcd10a8011b66475d9bc9e2ec7ba` |
| memory-deletion-conformance | passed | 4 | 0 | 0 | `sha256:f06a4a8f60fd8819098e45d5c1d5ccbeba7581840e5e17c71e8ba1d55023572a` |
| memory-worker-conformance | passed | 15 | 0 | 0 | `sha256:1cf4092136e4c07bcda213a424db14dcf2c0a6ac556240011c62f47a01aa0d19` |

## Aggregate

- Cases: 57
- Passed: 57
- Failed: 0
- Expected red: 0
- Unexpected pass: 0
- History contract: `lifecycle-history-evaluated-at-query-as-of`
- Fixture policy: `invented-provider-free-only`

The loader conformance gate is supplemental and is qualified by its package test; this deterministic artifact does not claim aggregate, live-provider, deployment, or production evidence.
