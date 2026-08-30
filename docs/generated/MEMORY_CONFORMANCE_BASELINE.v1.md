# Memory conformance baseline v1

- Result: **passed**
- Source digest: `sha256:743f1a30213c86c985d12de2149c7434ecc8eb4fc7c30c173c03244b1d237073` (155 files)
- Config digest: `sha256:936c9124f40283f5aef5793e2b3c641c6d28c95aeb26c0e08a84245756be0e4c`
- Profile digest: `sha256:92d3949c48c1d518f9097bbc24be1dbdfc1dafa056fc770fec97a785bee02192`
- Result digest: `sha256:f8103aedbb684092047f22e3dcef0bc3834836b0d290c25a59432ae6f77e7a3d`
- Provider-free: **passed**
- Live provider: **not-run**
- Production: **not-enabled**

## Suites

| Suite | Status | Passed | Failed | Expected red | Digest |
| --- | --- | ---: | ---: | ---: | --- |
| memory-record-conformance | passed | 5 | 0 | 0 | `sha256:1cb8bbee7bf35eb45e208ae023987200970eb29a05eb65f7e21243a85d9cde64` |
| memory-lifecycle-conformance | passed | 8 | 0 | 0 | `sha256:7092dd0615e083722b0aa0154a88305d5565ba9ea3a2a4b87c47b804ca6589a7` |
| memory-store-conformance | passed | 8 | 0 | 0 | `sha256:e30d3aae80040d91f7ebc2d575fb0a6bf7d28dae95ad7e7e1993295bb149399b` |
| memory-retrieval-conformance | passed | 9 | 0 | 0 | `sha256:cdd52fa5f6a69ce1913d112384bcf5a8039becba29e3aeec2c6aebdf33f34ad4` |
| memory-compaction-conformance | passed | 8 | 0 | 0 | `sha256:e33ce8d341cf20c76837f510efac1c7c95b5423adbdda4a8e54b030dedef20ae` |
| memory-deletion-conformance | passed | 4 | 0 | 0 | `sha256:7ef628f0380e3740ae575084787afba950e25b837205f673b42992278f2b8b57` |
| memory-worker-conformance | passed | 15 | 0 | 0 | `sha256:dddfb77870885bbe90175cffd737cb09a2286b42efdd5e549437978ebba363ef` |

## Aggregate

- Cases: 57
- Passed: 57
- Failed: 0
- Expected red: 0
- Unexpected pass: 0
- History contract: `lifecycle-history-evaluated-at-query-as-of`
- Fixture policy: `invented-provider-free-only`

The loader conformance gate is supplemental and is qualified by its package test; this deterministic artifact does not claim aggregate, live-provider, deployment, or production evidence.
