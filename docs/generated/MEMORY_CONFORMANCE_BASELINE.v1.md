# Memory conformance baseline v1

- Result: **passed**
- Source digest: `sha256:4e860caf798e5a10bd16f8645938373047a10b00c87f6903f4ae77b5b253ecb5` (155 files)
- Config digest: `sha256:936c9124f40283f5aef5793e2b3c641c6d28c95aeb26c0e08a84245756be0e4c`
- Profile digest: `sha256:987871dee189da623fe511a304bdc043de7a22744ff6b0f9df2ababc417e5691`
- Result digest: `sha256:9c9214c4c61e73bdad0fd57963437d6588182c732b953b4e414f7a4c793b480a`
- Provider-free: **passed**
- Live provider: **not-run**
- Production: **not-enabled**

## Suites

| Suite | Status | Passed | Failed | Expected red | Digest |
| --- | --- | ---: | ---: | ---: | --- |
| memory-record-conformance | passed | 5 | 0 | 0 | `sha256:eaf3c24c00851c37b12b0dc28a013d5ad17a1e89f6b787aa72ac31c799ef007c` |
| memory-lifecycle-conformance | passed | 8 | 0 | 0 | `sha256:47da4f96fafde67a76eea951dce0bb48c59052fbd60f978dee35f1ad17a5815f` |
| memory-store-conformance | passed | 8 | 0 | 0 | `sha256:b53522da427bf906693fb237651b56cbcdcf027bbee303f9bf21ff98db5fa9f5` |
| memory-retrieval-conformance | passed | 9 | 0 | 0 | `sha256:d73dd3e94a302f98daaade41c78f7fcc462b43f9d1c5f25d8ebb5297f365bfdb` |
| memory-compaction-conformance | passed | 8 | 0 | 0 | `sha256:234949a1e8e5403fefe4cdb25f560eb34d7139d5fa4bfa7006357bd6797917cb` |
| memory-deletion-conformance | passed | 4 | 0 | 0 | `sha256:1c65ce075667fa82091df80adee23c0e91f09759b26f396b45dc90d7d37d541e` |
| memory-worker-conformance | passed | 15 | 0 | 0 | `sha256:8adef2eaaca3f10b0ff7870c4237ae01fff6d384830ba6744c48d3ead7ce1a63` |

## Aggregate

- Cases: 57
- Passed: 57
- Failed: 0
- Expected red: 0
- Unexpected pass: 0
- History contract: `lifecycle-history-evaluated-at-query-as-of`
- Fixture policy: `invented-provider-free-only`

The loader conformance gate is supplemental and is qualified by its package test; this deterministic artifact does not claim aggregate, live-provider, deployment, or production evidence.
