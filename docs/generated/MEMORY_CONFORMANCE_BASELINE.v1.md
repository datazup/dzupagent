# Memory conformance baseline v1

- Result: **passed**
- Source digest: `sha256:f49cca382a061a1ada278a828b4bc0db18d8c24809f056f4dec5f6be1373582c` (155 files)
- Config digest: `sha256:936c9124f40283f5aef5793e2b3c641c6d28c95aeb26c0e08a84245756be0e4c`
- Profile digest: `sha256:82885b4bb79d0064daa35ec3a2230c4f3be4b06a3d46fdc0361cef688e39b936`
- Result digest: `sha256:925484120d2847d57d6019c4e1978737809fa44fceed524c0ed3e260d676ea8c`
- Provider-free: **passed**
- Live provider: **not-run**
- Production: **not-enabled**

## Suites

| Suite | Status | Passed | Failed | Expected red | Digest |
| --- | --- | ---: | ---: | ---: | --- |
| memory-record-conformance | passed | 5 | 0 | 0 | `sha256:271ec62284750a76204e3f8b9a77db732c0f2c520efede5d691672b906b24b94` |
| memory-lifecycle-conformance | passed | 8 | 0 | 0 | `sha256:16c7d0588ba2716991c4fb9e0271697b4bd3060648bd3d8e368ef354a0cbf6f5` |
| memory-store-conformance | passed | 8 | 0 | 0 | `sha256:44258aff0174aa9834e506bbdd93a5df4f0f8035214d93b892d1bba9764ad508` |
| memory-retrieval-conformance | passed | 9 | 0 | 0 | `sha256:e0cee5243cddf6b890c58cb060aae8336a526e1a3a52edda3ddf9038eec4438d` |
| memory-compaction-conformance | passed | 8 | 0 | 0 | `sha256:ad97963eddfb198c7bef21f7b7e220f3fc0eb8598ef7e782db21f6516035a949` |
| memory-deletion-conformance | passed | 4 | 0 | 0 | `sha256:edaaccd3d37fed72f64062e84c84566db5fa295ef58a57f6eb468189d06bc1df` |
| memory-worker-conformance | passed | 15 | 0 | 0 | `sha256:dbf702b344de4ead9e059f9d7e8a27324cc911c802008e912caafa19fc6f0b86` |

## Aggregate

- Cases: 57
- Passed: 57
- Failed: 0
- Expected red: 0
- Unexpected pass: 0
- History contract: `lifecycle-history-evaluated-at-query-as-of`
- Fixture policy: `invented-provider-free-only`

The loader conformance gate is supplemental and is qualified by its package test; this deterministic artifact does not claim aggregate, live-provider, deployment, or production evidence.
