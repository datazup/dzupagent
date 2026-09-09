# Memory conformance baseline v1

- Result: **passed**
- Source digest: `sha256:b5798bbfef70d77208e1beee2805d62e445d71c7eea48a0f03b4b753357a38a2` (155 files)
- Config digest: `sha256:936c9124f40283f5aef5793e2b3c641c6d28c95aeb26c0e08a84245756be0e4c`
- Profile digest: `sha256:ca01ef19b9dd8ac816ce85284751ef8b67b7852941fb720704f5d8ed505681d6`
- Result digest: `sha256:0c1418a087cf1611195f2a9933b210a5ebc33328b44f9e1a7ea5d0904578cbb9`
- Provider-free: **passed**
- Live provider: **not-run**
- Production: **not-enabled**

## Suites

| Suite | Status | Passed | Failed | Expected red | Digest |
| --- | --- | ---: | ---: | ---: | --- |
| memory-record-conformance | passed | 5 | 0 | 0 | `sha256:03b1333dbac794d4b5449db099cf05c92daeb54a22d0ff7e5f7e32b0ace26f40` |
| memory-lifecycle-conformance | passed | 8 | 0 | 0 | `sha256:e2463c8233025cb638129702e6ddf13f7ba353046bd41a262f6ee4a087661bb8` |
| memory-store-conformance | passed | 8 | 0 | 0 | `sha256:08aefa7c166a6d2d8ed2a1de48b699b47c00737b9ab0d439f89d45d0aa08a8e8` |
| memory-retrieval-conformance | passed | 9 | 0 | 0 | `sha256:fc95ced1192dc713559ab66b1122a366d9a6a1c7691389db5b5cd3415711dc09` |
| memory-compaction-conformance | passed | 8 | 0 | 0 | `sha256:cea744209ab37dcf8e699863e5a90f01f63446d3c6cd8f285dd40422f0e46390` |
| memory-deletion-conformance | passed | 4 | 0 | 0 | `sha256:7244f7e1159ade02a04e84f3afe294bf46df59207f4810ddb50c1f578e996f75` |
| memory-worker-conformance | passed | 15 | 0 | 0 | `sha256:6b0431a0be49d4dfc588eec31b449148a31de0da58e27b889076e0009a445a63` |

## Aggregate

- Cases: 57
- Passed: 57
- Failed: 0
- Expected red: 0
- Unexpected pass: 0
- History contract: `lifecycle-history-evaluated-at-query-as-of`
- Fixture policy: `invented-provider-free-only`

The loader conformance gate is supplemental and is qualified by its package test; this deterministic artifact does not claim aggregate, live-provider, deployment, or production evidence.
