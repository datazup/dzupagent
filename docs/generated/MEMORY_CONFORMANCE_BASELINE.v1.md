# Memory conformance baseline v1

- Result: **passed**
- Source digest: `sha256:8b85743aa14f10be673c97d94864c108c4450ad4778d281fc3fd8512f1caf7ce` (151 files)
- Config digest: `sha256:936c9124f40283f5aef5793e2b3c641c6d28c95aeb26c0e08a84245756be0e4c`
- Profile digest: `sha256:591a984510efa3ff3a2c6c80abac1c9e676eae5b24c648da797bd63dedf18c1b`
- Result digest: `sha256:ebf623fc43ace624147ce4f56f3316c7acf7ed50687397a4e1b4e30a65097984`
- Provider-free: **passed**
- Live provider: **not-run**
- Production: **not-enabled**

## Suites

| Suite | Status | Passed | Failed | Expected red | Digest |
| --- | --- | ---: | ---: | ---: | --- |
| memory-record-conformance | passed | 5 | 0 | 0 | `sha256:70342e87ea3bf2a80c977295475bc00d43d15252d949d3ffa28335b5b38edab5` |
| memory-lifecycle-conformance | passed | 8 | 0 | 0 | `sha256:787486c5289c013e36e0092ec4934c947f7fb726260bcb8e434aff4039ab4b8c` |
| memory-store-conformance | passed | 8 | 0 | 0 | `sha256:91e8f4b703377ea665abd28602afbd0fda687d638dcf18e4244b2624fee06e28` |
| memory-retrieval-conformance | passed | 9 | 0 | 0 | `sha256:1e891acb6a53ab37b6a83203fd6bcf67fee5d01577e824e19d34b0c749ed0e88` |
| memory-compaction-conformance | passed | 8 | 0 | 0 | `sha256:d940dfdb29cdbe83df742e505430c7eef32a7f1ac75fda085559d15c2976a40c` |
| memory-deletion-conformance | passed | 4 | 0 | 0 | `sha256:76e679fad75012fd0e272c990aa1d1949a27e2a35ed058a2ba22df7723e16d20` |
| memory-worker-conformance | passed | 15 | 0 | 0 | `sha256:c368a3af405a1a0c7e804ad21d4b8c050beb533fcdd2ba4fa3c6b71432e4c351` |

## Aggregate

- Cases: 57
- Passed: 57
- Failed: 0
- Expected red: 0
- Unexpected pass: 0
- History contract: `lifecycle-history-evaluated-at-query-as-of`
- Fixture policy: `invented-provider-free-only`

The loader conformance gate is supplemental and is qualified by its package test; this deterministic artifact does not claim aggregate, live-provider, deployment, or production evidence.
