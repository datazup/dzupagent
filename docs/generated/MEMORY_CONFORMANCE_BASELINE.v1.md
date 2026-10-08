# Memory conformance baseline v1

- Result: **passed**
- Source digest: `sha256:2e64009aad612c4b322f7ac4912d678b26fc3635e49dd3d332f69fc33411eb4b` (155 files)
- Config digest: `sha256:936c9124f40283f5aef5793e2b3c641c6d28c95aeb26c0e08a84245756be0e4c`
- Profile digest: `sha256:41a7dc5507f5d938c672ac6dbd0c37220970f8bcea0debc47c6ec22a4ffb7fcc`
- Result digest: `sha256:a701bde50c1b6418835e2a02e5e0eab77c59ba7a47b667d8cade55729b402a8d`
- Provider-free: **passed**
- Live provider: **not-run**
- Production: **not-enabled**

## Suites

| Suite | Status | Passed | Failed | Expected red | Digest |
| --- | --- | ---: | ---: | ---: | --- |
| memory-record-conformance | passed | 5 | 0 | 0 | `sha256:a2fa120d749ff44d1b802e57443e541462521a6f935fed2ac03ef22981c60b6e` |
| memory-lifecycle-conformance | passed | 8 | 0 | 0 | `sha256:4939c406c604498ff47e9c4a70fd66d80423ffb86a65ea92f0149d25f908026c` |
| memory-store-conformance | passed | 8 | 0 | 0 | `sha256:ac22d47eef5d350bc681205ff8cf7f96ce8ab34b4159a8d6dbd9150b9da0be7e` |
| memory-retrieval-conformance | passed | 9 | 0 | 0 | `sha256:e01eb81d0fc0b1e04a96c9328e3bd089259c34e36fce8aa61b1db2d423bad2d1` |
| memory-compaction-conformance | passed | 8 | 0 | 0 | `sha256:6a1ff77317dc352616c613b94f1d37d9e7f2041b5c3f3eef73d11a2357803d29` |
| memory-deletion-conformance | passed | 4 | 0 | 0 | `sha256:7317c830047d240dcef00e71a440f3cfd4b10d0d31df094ebec5f56c3239e7f2` |
| memory-worker-conformance | passed | 15 | 0 | 0 | `sha256:d0c59cb8f63ccd5b4a010a3031ff3a8fb3b20b1b2048f89a655952d9543cbbdd` |

## Aggregate

- Cases: 57
- Passed: 57
- Failed: 0
- Expected red: 0
- Unexpected pass: 0
- History contract: `lifecycle-history-evaluated-at-query-as-of`
- Fixture policy: `invented-provider-free-only`

The loader conformance gate is supplemental and is qualified by its package test; this deterministic artifact does not claim aggregate, live-provider, deployment, or production evidence.
