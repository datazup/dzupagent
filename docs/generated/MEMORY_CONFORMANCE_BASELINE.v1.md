# Memory conformance baseline v1

- Result: **passed**
- Source digest: `sha256:b841cf16cc50a2fcc54b55aefdaaf43ac3f43e2d243771821ca8aa160ea5d2ce` (155 files)
- Config digest: `sha256:936c9124f40283f5aef5793e2b3c641c6d28c95aeb26c0e08a84245756be0e4c`
- Profile digest: `sha256:de27dd8dc5f27f996cb70b5dea5088766bcbb0c810a9d6a78bdbfbcc5a5f5e78`
- Result digest: `sha256:ea4bc93e81463b1118332912952fc1bb72daebdc4547cb196a2fe25ca578c438`
- Provider-free: **passed**
- Live provider: **not-run**
- Production: **not-enabled**

## Suites

| Suite | Status | Passed | Failed | Expected red | Digest |
| --- | --- | ---: | ---: | ---: | --- |
| memory-record-conformance | passed | 5 | 0 | 0 | `sha256:71a767bab51aeafd3b4bcca8481990a02404ccb309d2bfc0af5e36d0ce6c2f4a` |
| memory-lifecycle-conformance | passed | 8 | 0 | 0 | `sha256:910a811f5550346770bf58705653f155674415ffc67387c3ab2a4563227b91dd` |
| memory-store-conformance | passed | 8 | 0 | 0 | `sha256:9ee958608be5e4564e7c287ad38ae8c5a330fb31e8e50eac978e738ccd506b0a` |
| memory-retrieval-conformance | passed | 9 | 0 | 0 | `sha256:ac49cc30ef8ff951bcb947ffc953e5001408400db89345f56f733328f7ed1cd3` |
| memory-compaction-conformance | passed | 8 | 0 | 0 | `sha256:ffff256a992a40fb012a3c21a5f25ff0db612be9656f5f97a17a13c7d279c62d` |
| memory-deletion-conformance | passed | 4 | 0 | 0 | `sha256:1f467802a1f143a9fd7eec1d678103ce0db711d260f50d2bb94d835c23444a2d` |
| memory-worker-conformance | passed | 15 | 0 | 0 | `sha256:ec0ffeee94885bbc81c238fea3eeae2c0201984e6e75ef8d3147fbfbf4f6e3f7` |

## Aggregate

- Cases: 57
- Passed: 57
- Failed: 0
- Expected red: 0
- Unexpected pass: 0
- History contract: `lifecycle-history-evaluated-at-query-as-of`
- Fixture policy: `invented-provider-free-only`

The loader conformance gate is supplemental and is qualified by its package test; this deterministic artifact does not claim aggregate, live-provider, deployment, or production evidence.
