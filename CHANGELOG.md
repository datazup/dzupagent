# Changelog

## 2026-06-26

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:5259b0432600c0495baddee3e879873d162f214b:changelog:Added:4c7280f2a5ae repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=5259b0432600c0495baddee3e879873d162f214b date=2026-06-26 updatedAt=2026-06-27T01:43:55.289Z -->
- Add an in-process episodic event log for memory events. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:80a21c8f5d948b59e6a44a2619c23273f6906178:changelog:Added:bf98f856db70 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=80a21c8f5d948b59e6a44a2619c23273f6906178 date=2026-06-26 updatedAt=2026-06-27T01:43:55.289Z -->
- Add codegen refactor utilities, webhook connector support, and safety scoring. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->

## 2026-06-25

### Changed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:76ea5f0720826ad4552ac46757e79414bcbecf5c:changelog:Changed:74c36ed5def4 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=76ea5f0720826ad4552ac46757e79414bcbecf5c date=2026-06-25 updatedAt=2026-06-27T01:43:55.290Z -->
- **Breaking:** Require typed error codes or safe prefixes when mapping route errors to 4xx statuses. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:65762ccc81cd3fa9d666d5dd675eced47167e386:changelog:Changed:e2389de44411 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=65762ccc81cd3fa9d666d5dd675eced47167e386 date=2026-06-25 updatedAt=2026-06-27T01:43:55.290Z -->
- Persist workflow checkpoints after each node by default. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:07c6f6f30b6de4708fcc3b02f1c4dbe6ca109c99:changelog:Changed:e8296229fae9 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=07c6f6f30b6de4708fcc3b02f1c4dbe6ca109c99 date=2026-06-25 updatedAt=2026-06-27T01:43:55.290Z -->
- Warn when MCP filesystemRoot is empty and keep the filesystem jail disabled. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:e4c11e3c6b4657d3a60306cf5967ce7dc6f18903:changelog:Changed:40c31b37c242 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=e4c11e3c6b4657d3a60306cf5967ce7dc6f18903 date=2026-06-25 updatedAt=2026-06-27T01:43:55.290Z -->
- Document MCP path guard symlink limitations and container isolation guidance. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:340632a0abe48cbd10a1cfe77538511f651443c1:changelog:Added:1bcebaa3f085 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=340632a0abe48cbd10a1cfe77538511f651443c1 date=2026-06-25 updatedAt=2026-06-27T01:43:55.291Z -->
- Add a control-plane freeze gate and contraction schedule for server route families. ([packages/server/src/composition/CONTROL-PLANE-CONTRACTION.md](packages/server/src/composition/CONTROL-PLANE-CONTRACTION.md)) (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:ab1a30762755266e72eb9d90c61f7827a5f38d30:changelog:Added:8eff6e9b3b77 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=ab1a30762755266e72eb9d90c61f7827a5f38d30 date=2026-06-25 updatedAt=2026-06-27T01:43:55.291Z -->
- Add capability-aware LLM fallback selection and per-tool-call audit hooks. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:b6c67194a53b6fa960f69ab803582a0265c318a4:changelog:Added:c3dad293f468 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=b6c67194a53b6fa960f69ab803582a0265c318a4 date=2026-06-25 updatedAt=2026-06-27T01:43:55.291Z -->
- Export tool-call audit event types from the core events entrypoint. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:2f20d6f3ea615c6feba762a62c611b7a39e8ecd0:changelog:Added:389366252fd1 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=2f20d6f3ea615c6feba762a62c611b7a39e8ecd0 date=2026-06-25 updatedAt=2026-06-27T01:43:55.291Z -->
- Add custom shell tool inspection to the destructive command guard. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:2ccb6898c51528b12217fce01e5dd84ed5c4c537:changelog:Added:b01faccea446 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=2ccb6898c51528b12217fce01e5dd84ed5c4c537 date=2026-06-25 updatedAt=2026-06-27T01:43:55.291Z -->
- Add live FleetSupervisor pause, cancel, and reassign controls. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:1e0c6150e5c5b8e79062b11fb631f21f9be16a8e:changelog:Added:b6bc3b1343e2 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=1e0c6150e5c5b8e79062b11fb631f21f9be16a8e date=2026-06-25 updatedAt=2026-06-27T01:43:55.291Z -->
- Add structured MCP tool guard error codes for blocked commands and path escapes. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:5beea99ad68d87b57928812a8963942727b3f95c:changelog:Added:09b2e2edef8f repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=5beea99ad68d87b57928812a8963942727b3f95c date=2026-06-25 updatedAt=2026-06-27T01:43:55.291Z -->
- Add Slack Block Kit, event parsing, and reaction connector helpers. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:4e2348869ec374ae4f5c3e1b64312dde025f6828:changelog:Added:0239c1489447 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=4e2348869ec374ae4f5c3e1b64312dde025f6828 date=2026-06-25 updatedAt=2026-06-27T01:43:55.291Z -->
- Add a short-term memory buffer for recent context. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:dfe038e428053a2d0ab1768854bf502fc704102d:changelog:Added:793eeb96a8c9 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=dfe038e428053a2d0ab1768854bf502fc704102d date=2026-06-25 updatedAt=2026-06-27T01:43:55.291Z -->
- Add a structured output scorer for evals. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->

### Fixed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:3c51f1ac75517c86076afed454f346d0aee493ca:changelog:Fixed:f5cce9b5f036 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=3c51f1ac75517c86076afed454f346d0aee493ca date=2026-06-25 updatedAt=2026-06-27T01:43:55.292Z -->
- Fix multi-tenant WebSocket event bridge scoping to reject unscoped clients and ignore caller-supplied tenant overrides. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:5d153600ebaabaef0a618ba2a8ba46438294265c:changelog:Fixed:c921a56635c8 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=5d153600ebaabaef0a618ba2a8ba46438294265c date=2026-06-25 updatedAt=2026-06-27T01:43:55.292Z -->
- Fix Postgres audit-log integrity for batched and concurrent writes. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:a78b3775ee380d0d0251ad871182eb4ee58b90f0:changelog:Fixed:7962c42a6257 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=a78b3775ee380d0d0251ad871182eb4ee58b90f0 date=2026-06-25 updatedAt=2026-06-27T01:43:55.292Z -->
- Fix prompt-injection exposure by wrapping tool-result context as untrusted content. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:9230f57b832e6f652cc454532b881478fff6127a:changelog:Fixed:0c370c532d20 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=9230f57b832e6f652cc454532b881478fff6127a date=2026-06-25 updatedAt=2026-06-27T01:43:55.292Z -->
- Fix Docker sandbox command execution to pass argv without shell interpretation and drop container capabilities. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:35cddf1f5f4bbc0ddb893bf0906195a5aba9ddb6:changelog:Fixed:8d3fb8d082a5 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=35cddf1f5f4bbc0ddb893bf0906195a5aba9ddb6 date=2026-06-25 updatedAt=2026-06-27T01:43:55.292Z -->
- Fix agent adapter fidelity for scoped memory recall, system prompt-aware routing, and preflight budget enforcement. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:d6461db580cd4447f5566a092b9cc6e0e7f943b6:changelog:Fixed:3d925bb3756b repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=d6461db580cd4447f5566a092b9cc6e0e7f943b6 date=2026-06-25 updatedAt=2026-06-27T01:43:55.292Z -->
- Fix tool-call audit argument hashing and capability fallback errors. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:be08a655ab81e2290428e71d56228cd8f4012938:changelog:Fixed:a0def65e2b5c repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=be08a655ab81e2290428e71d56228cd8f4012938 date=2026-06-25 updatedAt=2026-06-27T01:43:55.292Z -->
- Fix adapter preflight failures to throw ForgeError validation errors. ([docs/PUBLIC_API_SURFACE_ALLOWLISTS.md](docs/PUBLIC_API_SURFACE_ALLOWLISTS.md), [docs/SERVER_API_SURFACE_INDEX.md](docs/SERVER_API_SURFACE_INDEX.md)) (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:ae6b02f65a75e797a97a16d84cbdacbc8ecf9d17:changelog:Fixed:74500bd6e792 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=ae6b02f65a75e797a97a16d84cbdacbc8ecf9d17 date=2026-06-25 updatedAt=2026-06-27T01:43:55.293Z -->
- Fix stream-failure tool-call audit records to keep the captured args hash. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:e8cb88dd198ae966becb2c59929dcc3d51a38381:changelog:Fixed:08ffc8dd147d repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=e8cb88dd198ae966becb2c59929dcc3d51a38381 date=2026-06-25 updatedAt=2026-06-27T01:43:55.293Z -->
- Fix leaked active run tracking during crash-recovery resume. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:e2cd4faecb72302c84a2a6ea5ffaf0ebd8b05e01:changelog:Fixed:71071b87120b repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=e2cd4faecb72302c84a2a6ea5ffaf0ebd8b05e01 date=2026-06-25 updatedAt=2026-06-27T01:43:55.293Z -->
- Fix destructive shell command detection for root wipes and curl/wget pipe execution. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:0540775317d83b1abc0edb3a80bd3841a7a94d77:changelog:Fixed:90b139474d40 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=0540775317d83b1abc0edb3a80bd3841a7a94d77 date=2026-06-25 updatedAt=2026-06-27T01:43:55.293Z -->
- Fix destructive command guard matching for root filesystem rm commands. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:fa5b4a712c43644157bfa1dee2103eec78e8a318:changelog:Fixed:c197e48fa275 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=fa5b4a712c43644157bfa1dee2103eec78e8a318 date=2026-06-25 updatedAt=2026-06-27T01:43:55.293Z -->
- Block destructive shell commands at the MCP client layer. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:3803214bf22d1ae91f29229477729d7179babc1e:changelog:Fixed:c54e6e9da411 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=3803214bf22d1ae91f29229477729d7179babc1e date=2026-06-25 updatedAt=2026-06-27T01:43:55.293Z -->
- Fix outbound URL DNS-rebinding protection under Node.js v22. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:7db57d62876036ee5196550e1b672989fc263d53:changelog:Fixed:d817ac2084f5 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=7db57d62876036ee5196550e1b672989fc263d53 date=2026-06-25 updatedAt=2026-06-27T01:43:55.293Z -->
- Fix destructive-command blocking for custom MCP shell tool names. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:74ad89d2bab5bd635e2ae916c6b2c793ee9b2505:changelog:Fixed:30286573a2f0 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=74ad89d2bab5bd635e2ae916c6b2c793ee9b2505 date=2026-06-25 updatedAt=2026-06-27T01:43:55.293Z -->
- Block additional destructive shell-pipe and root-rm command patterns. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:dbbe6933584081c9cb85b762e4a70b780907cf38:changelog:Fixed:1d08b3e0e6f4 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=dbbe6933584081c9cb85b762e4a70b780907cf38 date=2026-06-25 updatedAt=2026-06-27T01:43:55.293Z -->
- Report DESTRUCTIVE_COMMAND_BLOCKED in destructive command guard error messages. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:e273262d873dd083d994922249b1432c32c7ed70:changelog:Fixed:1918e4650585 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=e273262d873dd083d994922249b1432c32c7ed70 date=2026-06-25 updatedAt=2026-06-27T01:43:55.294Z -->
- Fix destructive-command guard errors to use a human-readable message without duplicating the error code. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:024aad99a0ec567b8a1e930789516ed9f855d7d7:changelog:Fixed:bdaea67519bd repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=024aad99a0ec567b8a1e930789516ed9f855d7d7 date=2026-06-25 updatedAt=2026-06-27T01:43:55.294Z -->
- Fix duplicate destructive-command block prefixes in MCP error responses. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

## 2026-06-24

### Changed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:7e9d2fa6f5c02f63d7442118920cbc81de25bd24:changelog:Changed:1a89cb0f1cb7 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=7e9d2fa6f5c02f63d7442118920cbc81de25bd24 date=2026-06-24 updatedAt=2026-06-27T01:43:55.294Z -->
- **Breaking:** Move Postgres server stores from the root server barrel to the ops subpath. ([docs/PUBLIC_API_SURFACE_ALLOWLISTS.md](docs/PUBLIC_API_SURFACE_ALLOWLISTS.md), [docs/SERVER_API_SURFACE_INDEX.md](docs/SERVER_API_SURFACE_INDEX.md), [docs/CAPABILITY_MATRIX.md](docs/CAPABILITY_MATRIX.md)) (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:7cb48a98114c4cf9b0235bd94dd419d06d057883:changelog:Changed:7d0fe0242b4a repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=7cb48a98114c4cf9b0235bd94dd419d06d057883 date=2026-06-24 updatedAt=2026-06-27T01:43:55.295Z -->
- **Breaking:** Narrow server route plugin context, enforce internal root import governance, and split flow shape validation into data-driven rules. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:669c32a0e51fc55f2a4d3aaf0efcc2fcea1678e7:changelog:Added:4d20b1e4610f repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=669c32a0e51fc55f2a4d3aaf0efcc2fcea1678e7 date=2026-06-24 updatedAt=2026-06-27T01:43:55.295Z -->
- Add structured subagent logging and stable failure codes. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->

### Fixed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:18a337ff408ab23b0130c1b6157337819a488b05:changelog:Fixed:d0d09bdab058 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=18a337ff408ab23b0130c1b6157337819a488b05 date=2026-06-24 updatedAt=2026-06-27T01:43:55.295Z -->
- Fix agent runtime reliability and security audit gaps across handoff context, ID generation, queue limits, cleanup, and error logging. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:2698fdadf7ad70951d2ce147575918414b17c9b6:changelog:Fixed:af57ebb2d831 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=2698fdadf7ad70951d2ce147575918414b17c9b6 date=2026-06-24 updatedAt=2026-06-27T01:43:55.295Z -->
- Pin undici to fix high-severity audit findings. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:0aa5f67af6ed39a1ae8a44f752f2287b20b907ca:changelog:Fixed:20ffb6205c1b repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=0aa5f67af6ed39a1ae8a44f752f2287b20b907ca date=2026-06-24 updatedAt=2026-06-27T01:43:55.296Z -->
- Fix output filter failures with opt-in fail-closed redaction and add integration test lanes. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:62b875b9e1f4db40b49a8bfc5c9cf760f6f02d33:changelog:Fixed:450a368dcbfd repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=62b875b9e1f4db40b49a8bfc5c9cf760f6f02d33 date=2026-06-24 updatedAt=2026-06-27T01:43:55.296Z -->
- Normalize provider and vector-store HTTP failures into structured ForgeError codes and keep raw response bodies out of surfaced messages. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:fda10c41658feb831c882de1e20b05021c34539c:changelog:Fixed:aa9461603dc8 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=fda10c41658feb831c882de1e20b05021c34539c date=2026-06-24 updatedAt=2026-06-27T01:43:55.296Z -->
- **Breaking:** Harden server request validation, production auth defaults, body-size handling, runtime lifecycle control, and run cancellation. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->

## 2026-06-23

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:e4324f0aaa88779371cd9c654e358b9a5e984d0a:changelog:Added:d90073c5cbd9 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=e4324f0aaa88779371cd9c654e358b9a5e984d0a date=2026-06-23 updatedAt=2026-06-27T01:43:55.297Z -->
- Expose distributed cost ledger APIs from the agent runtime subpath. (ninel.hodzic)
<!-- /workspace-changelog:entry -->

### Fixed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:57110db626e20bef44f129a5b51b2044fe5e02e1:changelog:Fixed:bb82313c3897 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=57110db626e20bef44f129a5b51b2044fe5e02e1 date=2026-06-23 updatedAt=2026-06-27T01:43:55.297Z -->
- Fix OpenAI-compatible completion errors to log internal details and return sanitized client messages. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:8b0423cfb9d52dcb71f564b11983856d0354dbad:changelog:Fixed:858ea3a5e3e5 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=8b0423cfb9d52dcb71f564b11983856d0354dbad date=2026-06-23 updatedAt=2026-06-27T01:43:55.297Z -->
- Fix audit-reported leaks by sanitizing HTTP errors, failing redaction closed, and denying subagent spawn by default. (Ninel Hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->

## 2026-06-20

### Fixed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:c6fc4e12de5ebddb1946f5798e2ae9a6c38601f2:changelog:Fixed:8a1a5fc5628b repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=c6fc4e12de5ebddb1946f5798e2ae9a6c38601f2 date=2026-06-20 updatedAt=2026-06-27T01:43:55.298Z -->
- Fix MCP ping requests to return an empty result. (Ninel Hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->

## 2026-06-19

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:2d4923c096ee3a8a200ba96bb5f1df897241fb2e:changelog:Added:f488c58f8555 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=2d4923c096ee3a8a200ba96bb5f1df897241fb2e date=2026-06-19 updatedAt=2026-06-27T01:43:55.299Z -->
- Add explicit Redis and scheduler parser package dependencies. (ninel.hodzic)
<!-- /workspace-changelog:entry -->

## 2026-06-18

### Changed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:fa9aa03412d66ffa1c9c3ba233cb22b52699403a:changelog:Changed:fa43e90f7808 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=fa9aa03412d66ffa1c9c3ba233cb22b52699403a date=2026-06-18 updatedAt=2026-06-27T01:43:55.299Z -->
- Add required tenant_id defaults across server persistence tables. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:f5be6becdb508cd8a4de462b0bbd2344e2b7fc98:changelog:Changed:dd2f95ba85b3 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=f5be6becdb508cd8a4de462b0bbd2344e2b7fc98 date=2026-06-18 updatedAt=2026-06-27T01:43:55.299Z -->
- Add provider-aware worker capacity reporting and fair shared-worker queue claims. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:624abf382782ddcf37189427c023b2be864e2ab8:changelog:Changed:77285b4d1183 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=624abf382782ddcf37189427c023b2be864e2ab8 date=2026-06-18 updatedAt=2026-06-27T01:43:55.300Z -->
- **Breaking:** Change runtime node idempotency keys to the canonical contract format. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:6ab1a5ef5180e3d7e25a17dc36e9b7d84b75e91b:changelog:Changed:88fba07c8b8b repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=6ab1a5ef5180e3d7e25a17dc36e9b7d84b75e91b date=2026-06-18 updatedAt=2026-06-27T01:43:55.300Z -->
- Include flow fingerprints, attempt policies, and node inputs in agent node idempotency keys. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:0fc6addaaa0258e1d1f0f7e52d057c1c5329a820:changelog:Added:255d19e9a18c repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=0fc6addaaa0258e1d1f0f7e52d057c1c5329a820 date=2026-06-18 updatedAt=2026-06-27T01:43:55.300Z -->
- Add Redis-backed guardrail client wiring for distributed rate limits and cost recording. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:ad0591f7371b67657071377db782d15bab2d4d3a:changelog:Added:f7e458375952 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=ad0591f7371b67657071377db782d15bab2d4d3a date=2026-06-18 updatedAt=2026-06-27T01:43:55.300Z -->
- Add package API surface allowlists and server API index documentation. ([docs/PUBLIC_API_SURFACE_ALLOWLISTS.md](docs/PUBLIC_API_SURFACE_ALLOWLISTS.md), [docs/SERVER_API_SURFACE_INDEX.md](docs/SERVER_API_SURFACE_INDEX.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:4708654db772cb1e219d5c5fbbf827977f22d05b:changelog:Added:fa60463a8602 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=4708654db772cb1e219d5c5fbbf827977f22d05b date=2026-06-18 updatedAt=2026-06-27T01:43:55.301Z -->
- Add resume-point durability checks and a Postgres flow jobs schema. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:64396505dc0d31152d07afd8c7f1688df8848339:changelog:Added:9523a8eac09d repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=64396505dc0d31152d07afd8c7f1688df8848339 date=2026-06-18 updatedAt=2026-06-27T01:43:55.301Z -->
- Add a Postgres-backed run queue for flow_jobs workers without Redis. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:599f7312b746c98d45d56570206597802c9f9f19:changelog:Added:ee5d1b0dbb38 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=599f7312b746c98d45d56570206597802c9f9f19 date=2026-06-18 updatedAt=2026-06-27T01:43:55.301Z -->
- Add tenant IDs to run jobs and scope Postgres queue claims by configured tenant. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:2956aeb802eae2281ccd3f72ba8820ee2c1792ca:changelog:Added:8f001a461690 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=2956aeb802eae2281ccd3f72ba8820ee2c1792ca date=2026-06-18 updatedAt=2026-06-27T01:43:55.301Z -->
- Add tenant run quotas, cost showback routes, and autoscaling queue signals. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:1f6dc6e2d851b8b8deba0b1400f54752609e464a:changelog:Added:da6f4200cabb repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=1f6dc6e2d851b8b8deba0b1400f54752609e464a date=2026-06-18 updatedAt=2026-06-27T01:43:55.302Z -->
- Add TENANT_QUOTA_EXCEEDED for tenant run quota failures. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:73b70c00f0186dec7c8efc2d33af4ad0632131c5:changelog:Added:25edef8db9df repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=73b70c00f0186dec7c8efc2d33af4ad0632131c5 date=2026-06-18 updatedAt=2026-06-27T01:43:55.302Z -->
- Add a durability diagnostic for mutating durable flows without a resume point. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:05cafd1a9efdf15599ef0555e189099686913c55:changelog:Added:5643c6a26c13 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=05cafd1a9efdf15599ef0555e189099686913c55 date=2026-06-18 updatedAt=2026-06-27T01:43:55.302Z -->
- Add canonical idempotency digest and key materialization helpers to runtime contracts. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:765f2f3e5eb009915dfa0498a6b5bdd593f098ce:changelog:Added:78553a509c87 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=765f2f3e5eb009915dfa0498a6b5bdd593f098ce date=2026-06-18 updatedAt=2026-06-27T01:43:55.302Z -->
- Add per-node adapter resume metadata storage for provider resume context. ([CHANGELOG.md](CHANGELOG.md)) (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:904ba4be8b0c74bfe263a9d941a412628da82b90:changelog:Added:f1521ae0e7cc repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=904ba4be8b0c74bfe263a9d941a412628da82b90 date=2026-06-18 updatedAt=2026-06-27T01:43:55.302Z -->
- Add opt-in event-history replay runtime backed by an append-only flow event store. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:510f28519f5659a7b3f81cef32a7f40b1c49701a:changelog:Added:087579b3f9de repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=510f28519f5659a7b3f81cef32a7f40b1c49701a date=2026-06-18 updatedAt=2026-06-27T01:43:55.302Z -->
- Export PostgresRunStore from the server package entrypoint. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:f44b18e1e769436810bb0ed945676dc7b67f84d1:changelog:Added:a2eb93398949 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=f44b18e1e769436810bb0ed945676dc7b67f84d1 date=2026-06-18 updatedAt=2026-06-27T01:43:55.303Z -->
- Add the Postgres agent store to the server package exports. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:339cecfbf0b01cba2657828b11574a87d3efb1b5:changelog:Added:79e7a30a23c1 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=339cecfbf0b01cba2657828b11574a87d3efb1b5 date=2026-06-18 updatedAt=2026-06-27T01:43:55.303Z -->
- Add a server database migration command. (ninel.hodzic)
<!-- /workspace-changelog:entry -->

## 2026-06-17

### Changed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:d37451ac09facb714a36ba1d08f193fdf4b5dc7e:changelog:Changed:bc5ca2a12a9e repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=d37451ac09facb714a36ba1d08f193fdf4b5dc7e date=2026-06-17 updatedAt=2026-06-27T01:43:55.304Z -->
- Add durable ledger fencing to fork branch execution. (ninel.hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:0b5f6a2202119db01c3513a4467963eb53642e77:changelog:Changed:2c77ed3d705a repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=0b5f6a2202119db01c3513a4467963eb53642e77 date=2026-06-17 updatedAt=2026-06-27T01:43:55.304Z -->
- **Breaking:** Add durable Postgres flow stores and shared run guardrails. (ninel.hodzic)
<!-- /workspace-changelog:entry -->

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:c2e1bd4aea074b0345535f04ba6e342380da3767:changelog:Added:5a6c4a065cc7 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=c2e1bd4aea074b0345535f04ba6e342380da3767 date=2026-06-17 updatedAt=2026-06-27T01:43:55.304Z -->
- Add flow-ast parsing and validation for `adapter.run` nodes. (ninel.hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:d6bacb9ec79b6d1d622784110dbf6df2faeaa1ca:changelog:Added:57e26e4c62bc repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=d6bacb9ec79b6d1d622784110dbf6df2faeaa1ca date=2026-06-17 updatedAt=2026-06-27T01:43:55.305Z -->
- Add adapter.run DSL normalization, formatting, graph projection, and compile-time handling. (Ninel Hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:9b543c40a7de0a001427c127ec013388ddd10375:changelog:Added:504371649b50 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=9b543c40a7de0a001427c127ec013388ddd10375 date=2026-06-17 updatedAt=2026-06-27T01:43:55.305Z -->
- Add adapter.race Flow DSL support across AST, DSL, graph projection, and compiler validation. (Ninel Hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:4e1c19038bb539c0d1521c6ece75757a761c80ec:changelog:Added:f12930b8fdba repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=4e1c19038bb539c0d1521c6ece75757a761c80ec date=2026-06-17 updatedAt=2026-06-27T01:43:55.305Z -->
- Add adapter.parallel authoring, validation, DSL formatting, and compiler shape support. (Ninel Hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:e23c2c0298558ebe7f872f95f1596350c6f57594:changelog:Added:bcc2fda56cf2 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=e23c2c0298558ebe7f872f95f1596350c6f57594 date=2026-06-17 updatedAt=2026-06-27T01:43:55.305Z -->
- Add adapter.supervisor flow AST and DSL support. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:91a9769e5527cb603c178c8b7542ba3399180138:changelog:Added:1b06b4b2f4a0 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=91a9769e5527cb603c178c8b7542ba3399180138 date=2026-06-17 updatedAt=2026-06-27T01:43:55.305Z -->
- Add adapter.supervisor node support across flow AST parsing, validation, DSL normalization, formatting, and graph projection. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:5e0c3dedbaac926aa9b4bd70aa096a4927997ae1:changelog:Added:92d37842398e repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=5e0c3dedbaac926aa9b4bd70aa096a4927997ae1 date=2026-06-17 updatedAt=2026-06-27T01:43:55.306Z -->
- Add flow-compiler handling and shape validation for adapter.supervisor runtime leaf nodes. (ninel.hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:4515cc8babaafb1c4282c1e9068073bfb227eaf0:changelog:Added:90ca805675c0 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=4515cc8babaafb1c4282c1e9068073bfb227eaf0 date=2026-06-17 updatedAt=2026-06-27T01:43:55.306Z -->
- Add crash-safe DSL durability policy validation, round-tripping, and compiler diagnostics. (ninel.hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:8009be0acfdd2bce013f200160b58c3bbd826a04:changelog:Added:6003a55eb548 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=8009be0acfdd2bce013f200160b58c3bbd826a04 date=2026-06-17 updatedAt=2026-06-27T01:43:55.306Z -->
- Add worker fleet registration and Redis-backed distributed guardrail coordination. ([workspace-docs/repos/dzupagent/docs/architecture/plans/P1-worker-fleet-registry.md](workspace-docs/repos/dzupagent/docs/architecture/plans/P1-worker-fleet-registry.md), [workspace-docs/repos/dzupagent/docs/architecture/plans/P3-distributed-guardrails-redis.md](workspace-docs/repos/dzupagent/docs/architecture/plans/P3-distributed-guardrails-redis.md)) (ninel.hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:8330f99489851df30904f678cade9d2e0b14b024:changelog:Added:581c84369b4c repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=8330f99489851df30904f678cade9d2e0b14b024 date=2026-06-17 updatedAt=2026-06-27T01:43:55.307Z -->
- Add node-level durability fields and advisory idempotency diagnostics. (ninel.hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:234583fa9516656638f5f12b939f6fcd11a580ac:changelog:Added:09d35e572e8b repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=234583fa9516656638f5f12b939f6fcd11a580ac date=2026-06-17 updatedAt=2026-06-27T01:43:55.307Z -->
- Add a durable node ledger API with in-memory leasing, fencing, replay, and reclaim semantics. ([workspace-docs/repos/dzupagent/docs/architecture/plans/P2-run-leasing-and-fencing.md](workspace-docs/repos/dzupagent/docs/architecture/plans/P2-run-leasing-and-fencing.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:3d6f13db46f7750e26dc81c4bd0e75da7a20ba6a:changelog:Added:35bd90030914 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=3d6f13db46f7750e26dc81c4bd0e75da7a20ba6a date=2026-06-17 updatedAt=2026-06-27T01:43:55.310Z -->
- Add normalized reasoning intent mapping to SystemPromptBuilder. (ninel.hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:e9e1d7a3e73b0dcd6614dd17dd9ef80c450c1644:changelog:Added:c35c5f8203e1 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=e9e1d7a3e73b0dcd6614dd17dd9ef80c450c1644 date=2026-06-17 updatedAt=2026-06-27T01:43:55.311Z -->
- Add provider-native structured-output config and raw passthrough controls to SystemPromptBuilder. (Ninel Hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:7ce051dd308d1f713086151b6f3683e354f6c891:changelog:Added:d8ff71ecaede repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=7ce051dd308d1f713086151b6f3683e354f6c891 date=2026-06-17 updatedAt=2026-06-27T01:43:55.311Z -->
- Add opt-in `<think>` block stripping for recorded conversation history. (Ninel Hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:d87608096b20c91d8b6e25b924fd718fc96ee6b3:changelog:Added:749bb793318e repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=d87608096b20c91d8b6e25b924fd718fc96ee6b3 date=2026-06-17 updatedAt=2026-06-27T01:43:55.311Z -->
- Add opt-in durable node ledger integration to pipeline runtime. ([workspace-docs/repos/dzupagent/docs/architecture/plans/P2-run-leasing-and-fencing.md](workspace-docs/repos/dzupagent/docs/architecture/plans/P2-run-leasing-and-fencing.md)) (Ninel Hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:215967386e116d61445e9bfb5f0d6bd98843885a:changelog:Added:c48dd8180518 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=215967386e116d61445e9bfb5f0d6bd98843885a date=2026-06-17 updatedAt=2026-06-27T01:43:55.311Z -->
- Add a Postgres-backed durable node ledger for crash-safe node leasing and fencing. ([README.md](README.md)) (Ninel Hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:a8d22cb3729816db905c15aae279bbbcd353cc37:changelog:Added:a1fd9aba2091 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=a8d22cb3729816db905c15aae279bbbcd353cc37 date=2026-06-17 updatedAt=2026-06-27T01:43:55.311Z -->
- Add opt-in node lease heartbeats that renew long-running pipeline nodes and abort execution on lease loss. ([P2-run-leasing-and-fencing.md](P2-run-leasing-and-fencing.md)) (Ninel Hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:d52fb2a1c9cd0f4a34ade12da9d430c86ab082f5:changelog:Added:1402e1187ae1 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=d52fb2a1c9cd0f4a34ade12da9d430c86ab082f5 date=2026-06-17 updatedAt=2026-06-27T01:43:55.311Z -->
- Add node ledger stale-lease reclaimer for durable run resume. ([workspace-docs/repos/dzupagent/docs/architecture/plans/P2-run-leasing-and-fencing.md](workspace-docs/repos/dzupagent/docs/architecture/plans/P2-run-leasing-and-fencing.md)) (ninel.hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:fd7e08c62ebf57aa6e7f1b323cd5f978b9693177:changelog:Added:990ccab18a49 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=fd7e08c62ebf57aa6e7f1b323cd5f978b9693177 date=2026-06-17 updatedAt=2026-06-27T01:43:55.312Z -->
- Start the node-ledger reclaimer from server bootstrap when a durable ledger and run queue are configured. (Ninel Hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:2a6d1e8b3f86f719b6afaf7e90977c30f05cdfe6:changelog:Added:c744e5f7591f repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=2a6d1e8b3f86f719b6afaf7e90977c30f05cdfe6 date=2026-06-17 updatedAt=2026-06-27T01:43:55.312Z -->
- **Breaking:** Add durable schedule claiming and a tick worker for single-fire cron scheduling across server nodes. (ninel.hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:da66da621e59c5507bc1060bcd251e68f3536258:changelog:Added:eace7517debe repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=da66da621e59c5507bc1060bcd251e68f3536258 date=2026-06-17 updatedAt=2026-06-27T01:43:55.312Z -->
- Add HA schedule tick worker startup to server bootstrap. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:84040a336d547d6d89ebe71cb4d800f94ae6d8c5:changelog:Added:a6002a94a5e2 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=84040a336d547d6d89ebe71cb4d800f94ae6d8c5 date=2026-06-17 updatedAt=2026-06-27T01:43:55.312Z -->
- Add schedule tick worker startup to the server bootstrap. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:410d620f9e951fefe7d28d4249fd210d22e7f4b0:changelog:Added:4fd7467b404c repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=410d620f9e951fefe7d28d4249fd210d22e7f4b0 date=2026-06-17 updatedAt=2026-06-27T01:43:55.313Z -->
- Add high-availability scheduling columns to schedule_configs. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:b07484d8e58dddd8d66575aca37500067f6777a9:changelog:Added:d5224a5202be repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=b07484d8e58dddd8d66575aca37500067f6777a9 date=2026-06-17 updatedAt=2026-06-27T01:43:55.313Z -->
- Add public Postgres node ledger factory for server wiring. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:e5c0b0ff280fcaa7c6ad47c2531b6e60edcabfe5:changelog:Added:82a20c98f208 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=e5c0b0ff280fcaa7c6ad47c2531b6e60edcabfe5 date=2026-06-17 updatedAt=2026-06-27T01:43:55.313Z -->
- Add flow artifact and approval persistence tables and in-memory stores. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:931f314dc2069271a14bbf7736dba1a3b627edb0:changelog:Added:4b8864fcff21 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=931f314dc2069271a14bbf7736dba1a3b627edb0 date=2026-06-17 updatedAt=2026-06-27T01:43:55.314Z -->
- Add a Drizzle-backed worker node registry for fleet heartbeats and stale-node reaping. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:53aaf491db9956e4ea2a93a74226e7d8cb47afd0:changelog:Added:b042a1fa1b62 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=53aaf491db9956e4ea2a93a74226e7d8cb47afd0 date=2026-06-17 updatedAt=2026-06-27T01:43:55.314Z -->
- Add worker fleet registration and Prometheus fleet gauge helpers. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:2cc5ce8677775cd0e9ccf1c0dc2fb01fa9bd398c:changelog:Added:baba36fe2555 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=2cc5ce8677775cd0e9ccf1c0dc2fb01fa9bd398c date=2026-06-17 updatedAt=2026-06-27T01:43:55.314Z -->
- Expose worker fleet gauges on Prometheus metrics scrapes. (ninel.hodzic)
<!-- /workspace-changelog:entry -->

### Fixed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:f50fc93039bb1db12b566681c1b69f973d0d27d7:changelog:Fixed:385c98000b69 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=f50fc93039bb1db12b566681c1b69f973d0d27d7 date=2026-06-17 updatedAt=2026-06-27T01:43:55.314Z -->
- Reject validation command cwd values that escape the task repo. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

## 2026-06-16

### Changed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:9d06aa1436fae3edbad5cf08e68cc60f5c927777:changelog:Changed:7cae954ad5c9 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=9d06aa1436fae3edbad5cf08e68cc60f5c927777 date=2026-06-16 updatedAt=2026-06-27T01:43:55.315Z -->
- Run Codex fleet workers through JSON exec stdin prompts. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:36c77d9bbb543c8b1d84d0287193a1fa3d6111fc:changelog:Changed:184340c8ff6c repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=36c77d9bbb543c8b1d84d0287193a1fa3d6111fc date=2026-06-16 updatedAt=2026-06-27T01:43:55.315Z -->
- **Breaking:** Configure Codex subprocess exec options and reject live message sends after the initial prompt. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:286d5705ae7f7260e08b9320f473df4690b34d39:changelog:Changed:fd73b7870637 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=286d5705ae7f7260e08b9320f473df4690b34d39 date=2026-06-16 updatedAt=2026-06-27T01:43:55.315Z -->
- **Breaking:** Require implementation repository instructions as arrays and map missing instructions to an empty array. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:abcc91e9e1b9b6f6f2d650884dfd4b408372c333:changelog:Changed:fcc6c643c142 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=abcc91e9e1b9b6f6f2d650884dfd4b408372c333 date=2026-06-16 updatedAt=2026-06-27T01:43:55.316Z -->
- Report unknown implementation task repositories with a task-specific validation issue code. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:eee8bead388c348d51609da1746e44416aa4669d:changelog:Added:e5e5578938b5 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=eee8bead388c348d51609da1746e44416aa4669d date=2026-06-16 updatedAt=2026-06-27T01:43:55.316Z -->
- Add adapter-backed fleet execution contracts. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:d158dcac92ba24ab3cd69cf48cfb95b61879b989:changelog:Added:7fa6e635a5fb repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=d158dcac92ba24ab3cd69cf48cfb95b61879b989 date=2026-06-16 updatedAt=2026-06-27T01:43:55.316Z -->
- Add implementation orchestration contract exports. ([packages/agent-types/src/orchestration/implementation/PLACEMENT.md](packages/agent-types/src/orchestration/implementation/PLACEMENT.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:ec35974644fed4763da8d61df5719c3496dfea5b:changelog:Added:5eaecfcbd39f repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=ec35974644fed4763da8d61df5719c3496dfea5b date=2026-06-16 updatedAt=2026-06-27T01:43:55.316Z -->
- Add versioned implementation plan contract types. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:28b60c8e768a857ffe5353d13067644ae0d99d7c:changelog:Added:819e9183609a repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=28b60c8e768a857ffe5353d13067644ae0d99d7c date=2026-06-16 updatedAt=2026-06-27T01:43:55.316Z -->
- Add implementation task mapping to agent tasks. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:1c18b1ab5cbf51ced478b48fe09e2fc0f53c1309:changelog:Added:435bbb7a8e8e repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=1c18b1ab5cbf51ced478b48fe09e2fc0f53c1309 date=2026-06-16 updatedAt=2026-06-27T01:43:55.317Z -->
- Add implementation plan validation. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:38d564b8dd1bf30be5687a16a716ba9539e2da6e:changelog:Added:07cc7f26a568 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=38d564b8dd1bf30be5687a16a716ba9539e2da6e date=2026-06-16 updatedAt=2026-06-27T01:43:55.317Z -->
- Add implementation plan scheduling by batch and repository lane. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:0339a6970b216f9a868b3aeb7204b98479e700bc:changelog:Added:09468263f7e2 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=0339a6970b216f9a868b3aeb7204b98479e700bc date=2026-06-16 updatedAt=2026-06-27T01:43:55.317Z -->
- Add Qwen reasoning soft-switch support to SystemPromptBuilder. (Ninel Hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->

### Fixed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:fc8fed2ae0f91893d478b74a5137e1a4d1dbaa58:changelog:Fixed:a6890e47304c repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=fc8fed2ae0f91893d478b74a5137e1a4d1dbaa58 date=2026-06-16 updatedAt=2026-06-27T01:43:55.317Z -->
- Fix implementation plan batch graph validation. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:7c47a33c26d28953962385ce656060c0a8facb0d:changelog:Fixed:e06d2ff508dc repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=7c47a33c26d28953962385ce656060c0a8facb0d date=2026-06-16 updatedAt=2026-06-27T01:43:55.317Z -->
- Fix implementation schedules to honor batch gates and serial task order. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:9798f670d7f97439eff8f507b8a6faad802ac053:changelog:Fixed:58ccefe4e28e repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=9798f670d7f97439eff8f507b8a6faad802ac053 date=2026-06-16 updatedAt=2026-06-27T01:43:55.318Z -->
- Accept dzupflow/v1alpha-agent documents in flow AST validation. (ninel.hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->

## 2026-06-14

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:958f6d648eb5f376366158f6124ece679049da71:changelog:Added:122023d1a696 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=958f6d648eb5f376366158f6124ece679049da71 date=2026-06-14 updatedAt=2026-06-27T01:43:55.318Z -->
- Add optional `resultSchema` support to `worker.dispatch` flow AST and DSL parsing/formatting. (Ninel Hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:2f64d433ac415a9f5a37284fe3153fbc699da51e:changelog:Added:cbf27aaad57e repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=2f64d433ac415a9f5a37284fe3153fbc699da51e date=2026-06-14 updatedAt=2026-06-27T01:43:55.319Z -->
- Add flow-compiler validation and runtime-node handling for worker.dispatch. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

### Fixed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:c9eca0923e93a18e088a60dd4aa17e74796b65ad:changelog:Fixed:ea54ed791411 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=c9eca0923e93a18e088a60dd4aa17e74796b65ad date=2026-06-14 updatedAt=2026-06-27T01:43:55.319Z -->
- Fix dotted worker.dispatch YAML wrapper keys in the flow DSL parser. (Ninel Hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:7623e37d208fc274cce82f09059a9451b3543006:changelog:Fixed:d8bbeb42dd4e repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=7623e37d208fc274cce82f09059a9451b3543006 date=2026-06-14 updatedAt=2026-06-27T01:43:55.319Z -->
- Fix YAML round-trips for fleet and knowledge DSL nodes. (ninel.hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->

## 2026-06-13

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:96b15a6b057b836891c6cd5a5586d3212f9d07a6:changelog:Added:cabe11c0e07f repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=96b15a6b057b836891c6cd5a5586d3212f9d07a6 date=2026-06-13 updatedAt=2026-06-27T01:43:55.320Z -->
- Add OTel GenAI agent and codev execution profile span attributes. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:a5e82faf1f33e281fb603465d66760705873ef7c:changelog:Added:d4a730388410 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=a5e82faf1f33e281fb603465d66760705873ef7c date=2026-06-13 updatedAt=2026-06-27T01:43:55.320Z -->
- Add worker.dispatch flow nodes for CLI worker dispatch in flow AST and DSL. (Ninel Hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->

## 2026-06-12

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:eca1c4a180435e78fed944c0cba6954dd46048a9:changelog:Added:b306214efa2b repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=eca1c4a180435e78fed944c0cba6954dd46048a9 date=2026-06-12 updatedAt=2026-06-27T01:43:55.321Z -->
- Add optional global identity fields to ApiKeyContext. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->

## 2026-06-11

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:b58d79a802aae81a30fa4c244027509d26e57fc6:changelog:Added:1f0829c3fc0e repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=b58d79a802aae81a30fa4c244027509d26e57fc6 date=2026-06-11 updatedAt=2026-06-27T01:43:55.322Z -->
- Add GitHub Packages publish configuration to publishable packages. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:bc724f788ab13cb7f4c516fcc240697706570fe3:changelog:Added:3e79b37746ef repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=bc724f788ab13cb7f4c516fcc240697706570fe3 date=2026-06-11 updatedAt=2026-06-27T01:43:55.323Z -->
- Add vision model tier support to core LLM model configuration. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

### Fixed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:176e1a8a2ce2592807eb0defbbcc3b107e9a91ca:changelog:Fixed:947ac4eed576 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=176e1a8a2ce2592807eb0defbbcc3b107e9a91ca date=2026-06-11 updatedAt=2026-06-27T01:43:55.323Z -->
- Fix MCP Express router auth so shared-prefix mounts do not 401 sibling routes. (Ninel Hodzic, Claude Fable 5)
<!-- /workspace-changelog:entry -->

## 2026-06-08

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:a4cd7102f0d494eb63761239bd8492f207189df9:changelog:Added:46343adcec87 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=a4cd7102f0d494eb63761239bd8492f207189df9 date=2026-06-08 updatedAt=2026-06-27T01:43:55.324Z -->
- Add dynamic workflow schema types and provider routing primitives for agent packages. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

## 2026-06-06

### Fixed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:aafb08a527a230e78f3d9f4444fe34ef9a4b55c9:changelog:Fixed:af9d438b7092 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=aafb08a527a230e78f3d9f4444fe34ef9a4b55c9 date=2026-06-06 updatedAt=2026-06-27T01:43:55.326Z -->
- Fix Express agent router handling of pre-parsed request bodies. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:877592a21096e57338b135f8063e34130a6059e4:changelog:Fixed:7a97076aa9a2 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=877592a21096e57338b135f8063e34130a6059e4 date=2026-06-06 updatedAt=2026-06-27T01:43:55.326Z -->
- Fix executor completion, OpenAI compatibility RBAC gating, and maxTokens metadata handling. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

## 2026-06-05

### Changed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:f739fa66b2a01ca460e6c773d5a9d7148a89a926:changelog:Changed:66ff423e5346 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=f739fa66b2a01ca460e6c773d5a9d7148a89a926 date=2026-06-05 updatedAt=2026-06-27T01:43:55.327Z -->
- Use gpt-5.5 and medium reasoning effort as Codex adapter fallback defaults. (ninel.hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:5620e656fa72afae83936fafe874c182f1b49dcc:changelog:Added:fdb8bce29951 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=5620e656fa72afae83936fafe874c182f1b49dcc date=2026-06-05 updatedAt=2026-06-27T01:43:55.327Z -->
- Export BaseChatModel from the core package barrel. (ninel.hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:db26c99e7912325ec20e7e2d81308acb655d75a1:changelog:Added:17f4af0880bd repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=db26c99e7912325ec20e7e2d81308acb655d75a1 date=2026-06-05 updatedAt=2026-06-27T01:43:55.327Z -->
- Add provider-neutral dialogue orchestration core package. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:1119b660dc6ecdf905509048a3ac2a40c3c9944e:changelog:Added:0ca305c3065e repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=1119b660dc6ecdf905509048a3ac2a40c3c9944e date=2026-06-05 updatedAt=2026-06-27T01:43:55.328Z -->
- Add dialogue-core contract freeze documentation for downstream Run B/C/D adapters. ([packages/dialogue-core/CONTRACT_FREEZE.md](packages/dialogue-core/CONTRACT_FREEZE.md)) (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:dc726ba7fda6787a324bc1f8c0504cfc4e6dc8bc:changelog:Added:0bc805ce761e repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=dc726ba7fda6787a324bc1f8c0504cfc4e6dc8bc date=2026-06-05 updatedAt=2026-06-27T01:43:55.328Z -->
- Add @dzupagent/dialogue-core contract freeze for adapter and downstream run interfaces. ([CONTRACT_FREEZE.md](CONTRACT_FREEZE.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:67d47a7af36eabfb5c8b69052b4bea7c7bc51168:changelog:Added:ad6f90153e71 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=67d47a7af36eabfb5c8b69052b4bea7c7bc51168 date=2026-06-05 updatedAt=2026-06-27T01:43:55.328Z -->
- Add deterministic dialogue-core replay harness ports. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:c5ef080c981b3e3f91a446527657d325df0071df:changelog:Added:b362e89512e2 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=c5ef080c981b3e3f91a446527657d325df0071df date=2026-06-05 updatedAt=2026-06-27T01:43:55.329Z -->
- Add GoldenTrace dialogue replay with fixture validation and Turbo test coverage. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->

### Fixed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:77196112e778369c23a1cf146d2c1b3d6f560ca7:changelog:Fixed:2a67895c5c83 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=77196112e778369c23a1cf146d2c1b3d6f560ca7 date=2026-06-05 updatedAt=2026-06-27T01:43:55.329Z -->
- Fix Codex adapter failure reporting for turn.failed and stream error events. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:1f41b14048ae116540431165f57e3aa4beb375f4:changelog:Fixed:f060218745e6 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=1f41b14048ae116540431165f57e3aa4beb375f4 date=2026-06-05 updatedAt=2026-06-27T01:43:55.329Z -->
- Fix DialogueScheduler failure statuses and loop stop reasons. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->

## 2026-06-04

### Changed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:5ea17f08e48e0abb443aaa52eedcc22c048dab2c:changelog:Changed:e0ca5f179406 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=5ea17f08e48e0abb443aaa52eedcc22c048dab2c date=2026-06-04 updatedAt=2026-06-27T01:43:55.330Z -->
- Use the package-name bin shorthand for the create-dzupagent CLI. (ninel.hodzic)
<!-- /workspace-changelog:entry -->

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:b5fc257cc192debdfcf00b2a84840790bcd0d4dc:changelog:Added:e05cc00cb741 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=b5fc257cc192debdfcf00b2a84840790bcd0d4dc date=2026-06-04 updatedAt=2026-06-27T01:43:55.331Z -->
- Add the Deep Dialogue Engine design specification. ([docs/specs/2026-06-04-dialogue-core-deep-dialogue-engine-design.md](docs/specs/2026-06-04-dialogue-core-deep-dialogue-engine-design.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->

### Fixed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:92e5dbda6a04797c3656da883dcdfb969fde3fe5:changelog:Fixed:73870511f67f repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=92e5dbda6a04797c3656da883dcdfb969fde3fe5 date=2026-06-04 updatedAt=2026-06-27T01:43:55.331Z -->
- Restore the explicit create-dzupagent CLI bin mapping. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

## 2026-06-03

### Changed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:032ac081ff79bbeb389a837d152a1de87d759612:changelog:Changed:ddb114c5f19d repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=032ac081ff79bbeb389a837d152a1de87d759612 date=2026-06-03 updatedAt=2026-06-27T01:43:55.332Z -->
- **Breaking:** Require explicit wired subagent spawn policies and bound subagent runs with token and timeout limits. (ninel.hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:bcb1873be72f4934db2b2ef39f046a5c7dce0207:changelog:Changed:24a7ab3109a5 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=bcb1873be72f4934db2b2ef39f046a5c7dce0207 date=2026-06-03 updatedAt=2026-06-27T01:43:55.332Z -->
- Clarify W9 circuit breaker backoff guard and test requirements. ([docs/superpowers/specs/2026-06-03-w9-circuit-breaker-backoff-design.md](docs/superpowers/specs/2026-06-03-w9-circuit-breaker-backoff-design.md)) (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:213a8814afbed52377d2beeaa0c06e366aa6a350:changelog:Changed:2fbeced2af12 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=213a8814afbed52377d2beeaa0c06e366aa6a350 date=2026-06-03 updatedAt=2026-06-27T01:43:55.333Z -->
- Use capped exponential re-open backoff in the LLM circuit breaker. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:e40e2db1c0fd32cac10c01b0d042beee957b4e78:changelog:Changed:486bec52588b repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=e40e2db1c0fd32cac10c01b0d042beee957b4e78 date=2026-06-03 updatedAt=2026-06-27T01:43:55.333Z -->
- Block destructive shell commands before adapter tool execution. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:4084a4d5299c3b4c857c09cca0c2472021ff4ede:changelog:Added:7faed3faf42f repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=4084a4d5299c3b4c857c09cca0c2472021ff4ede date=2026-06-03 updatedAt=2026-06-27T01:43:55.333Z -->
- Add durable loop resume checkpoints for pipeline loop iterations. (ninel.hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:5ada34d4f307d80e8d519f1d248d8971b60d403b:changelog:Added:e0fa5531c5b0 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=5ada34d4f307d80e8d519f1d248d8971b60d403b date=2026-06-03 updatedAt=2026-06-27T01:43:55.334Z -->
- Add per-file source line ceilings to barrel budget configuration. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:b8f1e41b40fa1056c80b2b2294e2be3af65cf2f9:changelog:Added:918dbec7ebfa repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=b8f1e41b40fa1056c80b2b2294e2be3af65cf2f9 date=2026-06-03 updatedAt=2026-06-27T01:43:55.336Z -->
- Add optional forkState to pipeline checkpoints for branch resume data. (ninel.hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:2ddd53bbbce36a56d8303adf98c2556cf72cf9e2:changelog:Added:7d11db760689 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=2ddd53bbbce36a56d8303adf98c2556cf72cf9e2 date=2026-06-03 updatedAt=2026-06-27T01:43:55.337Z -->
- Preserve fork branch progress in pipeline checkpoints. (ninel.hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:8d72d81f8410887533d8f912a1fb24a2e4f3eb4a:changelog:Added:d6b681b177ed repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=8d72d81f8410887533d8f912a1fb24a2e4f3eb4a date=2026-06-03 updatedAt=2026-06-27T01:43:55.337Z -->
- **Breaking:** Add durable fork branch resume support and stable branch node idempotency keys. (Ninel Hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:6c528d16ce7fc988825511fc6d7f0d3b4a1382d9:changelog:Added:35bb412430de repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=6c528d16ce7fc988825511fc6d7f0d3b4a1382d9 date=2026-06-03 updatedAt=2026-06-27T01:43:55.337Z -->
- Add durable per-branch resume checkpoints for pipeline forks. (ninel.hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:a1cc9f2bfa941a38c75b6139cb778e3d17d11e63:changelog:Added:abbd796c9412 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=a1cc9f2bfa941a38c75b6139cb778e3d17d11e63 date=2026-06-03 updatedAt=2026-06-27T01:43:55.337Z -->
- Persist pipeline fork state in Postgres checkpoints. (Ninel Hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:871b4afbc576bd044391698f445174f0976748ce:changelog:Added:4a17e57ee8e9 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=871b4afbc576bd044391698f445174f0976748ce date=2026-06-03 updatedAt=2026-06-27T01:43:55.338Z -->
- Add approved design for circuit-breaker re-open backoff. ([docs/superpowers/specs/2026-06-03-w9-circuit-breaker-backoff-design.md](docs/superpowers/specs/2026-06-03-w9-circuit-breaker-backoff-design.md)) (ninel.hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:5182af0ded79d513d791ca53006f71b04db442b1:changelog:Added:7a6b6b056aba repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=5182af0ded79d513d791ca53006f71b04db442b1 date=2026-06-03 updatedAt=2026-06-27T01:43:55.338Z -->
- Add routing decision IDs and rejection reasons to supervisor routing diagnostics. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:5758151ec312cfbc3668ed33611d2235bcbfab3d:changelog:Added:278c95fda983 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=5758151ec312cfbc3668ed33611d2235bcbfab3d date=2026-06-03 updatedAt=2026-06-27T01:43:55.338Z -->
- Add MCP filesystem-root path validation helpers. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:78196d4f5075c1e0a5ebaf41b40dc4b5dbfb64e2:changelog:Added:68071b260c3a repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=78196d4f5075c1e0a5ebaf41b40dc4b5dbfb64e2 date=2026-06-03 updatedAt=2026-06-27T01:43:55.338Z -->
- Add a destructive shell command guard for agent adapter tools. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:5ad7ef8aa9dce0c7a9cfc13d849a707b9e027f0a:changelog:Added:bd0aa4ba0967 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=5ad7ef8aa9dce0c7a9cfc13d849a707b9e027f0a date=2026-06-03 updatedAt=2026-06-27T01:43:55.338Z -->
- Add routing decision IDs to supervisor results. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:9c6b7682e88ce8817d70efd64cd94389e84f5d69:changelog:Added:21c659b30b02 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=9c6b7682e88ce8817d70efd64cd94389e84f5d69 date=2026-06-03 updatedAt=2026-06-27T01:43:55.338Z -->
- Persist routing decision IDs on supervisor run results and hierarchical topology metrics. (Ninel Hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->

### Fixed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:58515de25fdae823cb5169027c5be1a580a7dcb7:changelog:Fixed:3326e1e989ff repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=58515de25fdae823cb5169027c5be1a580a7dcb7 date=2026-06-03 updatedAt=2026-06-27T01:43:55.339Z -->
- Sanitize memory browse route errors and map failures to route-specific HTTP statuses. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:bd633bf15220b49cf071ec1845865193da01144e:changelog:Fixed:18bc8f0228ff repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=bd633bf15220b49cf071ec1845865193da01144e date=2026-06-03 updatedAt=2026-06-27T01:43:55.339Z -->
- Fix publish gate metadata for route-family review and the create-dzupagent binary mapping. (ninelhodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:8147cfa961e3affc9098263563073008819dfb95:changelog:Fixed:6df9b6404163 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=8147cfa961e3affc9098263563073008819dfb95 date=2026-06-03 updatedAt=2026-06-27T01:43:55.339Z -->
- Resume mid-flight fork pipeline runs from saved branch progress. (Ninel Hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:beb7bf5c44f9262205dde15760d54362d00cea99:changelog:Fixed:fb81b2630ce1 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=beb7bf5c44f9262205dde15760d54362d00cea99 date=2026-06-03 updatedAt=2026-06-27T01:43:55.340Z -->
- Fix mid-flight fork resume so completed branches are restored without rerunning. (Ninel Hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:90eb1a6d6bce3c460c0244041309f17447b71d0b:changelog:Fixed:ead5ca7ede98 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=90eb1a6d6bce3c460c0244041309f17447b71d0b date=2026-06-03 updatedAt=2026-06-27T01:43:55.340Z -->
- Fix fork resume to re-run errored branches instead of restoring them. (ninel.hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:5919f5f14f01ab1aa9e631ddf7e67ea473f4ad9f:changelog:Fixed:51c9e67a1fb6 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=5919f5f14f01ab1aa9e631ddf7e67ea473f4ad9f date=2026-06-03 updatedAt=2026-06-27T01:43:55.340Z -->
- Prevent subagent check, await, and cancel tools from reading or cancelling tasks owned by another run. (ninel.hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:5abfd96a359490d1e5e07906b263e5fc63def03b:changelog:Fixed:0399fc26a30e repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=5abfd96a359490d1e5e07906b263e5fc63def03b date=2026-06-03 updatedAt=2026-06-27T01:43:55.341Z -->
- Sanitize benchmark route error responses to prevent raw internal 4xx messages from reaching clients. (ninel.hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:4df3d2b5d4ef8a2225ccbe88949cedbea9cac0ca:changelog:Fixed:14596bda8b30 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=4df3d2b5d4ef8a2225ccbe88949cedbea9cac0ca date=2026-06-03 updatedAt=2026-06-27T01:43:55.341Z -->
- Fix server API surface parsing for double-quoted barrel exports. ([docs/PUBLIC_API_SURFACE_ALLOWLISTS.md](docs/PUBLIC_API_SURFACE_ALLOWLISTS.md), [docs/SERVER_API_SURFACE_INDEX.md](docs/SERVER_API_SURFACE_INDEX.md)) (ninelhodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:3ef5cb06d743773a2d57e0291ef8bb9c63dac9f6:changelog:Fixed:79e7f741564e repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=3ef5cb06d743773a2d57e0291ef8bb9c63dac9f6 date=2026-06-03 updatedAt=2026-06-27T01:43:55.341Z -->
- Preserve safe 404 messages for tenant-scoped benchmark lookups. (ninel.hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:d2688f9c69ac8ef580fad751d598d0310ac9d84f:changelog:Fixed:db4a63305828 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=d2688f9c69ac8ef580fad751d598d0310ac9d84f date=2026-06-03 updatedAt=2026-06-27T01:43:55.341Z -->
- Preserve safe tenant-scope 404 messages for benchmark run and baseline lookups. (Ninel Hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:f38ce47fd814f37a256882305f30887e5bff99a0:changelog:Fixed:b4300bb9a411 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=f38ce47fd814f37a256882305f30887e5bff99a0 date=2026-06-03 updatedAt=2026-06-27T01:43:55.342Z -->
- Fix Gemini SDK adapter missing Google API key errors. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:58fa694a8ec87891d928a66f713c29003e0a6b85:changelog:Fixed:21ff8689d2da repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=58fa694a8ec87891d928a66f713c29003e0a6b85 date=2026-06-03 updatedAt=2026-06-27T01:43:55.342Z -->
- Fix Gemini SDK client initialization error handling. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:b26060b580b2da0995e62b6b1a592bffbf9bf44f:changelog:Fixed:d22be7e401cc repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=b26060b580b2da0995e62b6b1a592bffbf9bf44f date=2026-06-03 updatedAt=2026-06-27T01:43:55.342Z -->
- Reject MCP tool path arguments that escape a configured filesystem root. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:49fae9d86f45b601c738c6367933df296c306c9d:changelog:Fixed:5909fb47c892 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=49fae9d86f45b601c738c6367933df296c306c9d date=2026-06-03 updatedAt=2026-06-27T01:43:55.342Z -->
- Fix destructive command blocking for NVMe devices, split rm flags, and multiple tool input keys. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:943438d3fdbda12930e0a9f8762bc68d9c3d3766:changelog:Fixed:5174bb8bf01e repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=943438d3fdbda12930e0a9f8762bc68d9c3d3766 date=2026-06-03 updatedAt=2026-06-27T01:43:55.343Z -->
- Fix Claude conversation interrupts with Claude Agent SDK 0.3.x. ([packages/agent-adapters/ARCHITECTURE.md](packages/agent-adapters/ARCHITECTURE.md), [packages/agent-adapters/docs/ARCHITECTURE.md](packages/agent-adapters/docs/ARCHITECTURE.md)) (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:2a897a45de645aacdca74d8316c0a5dd9ae3ded2:changelog:Fixed:bf7e8ffb2d25 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=2a897a45de645aacdca74d8316c0a5dd9ae3ded2 date=2026-06-03 updatedAt=2026-06-27T01:43:55.343Z -->
- Fix Postgres checkpoint recovery attempt persistence across process restarts. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

## 2026-06-02

### Changed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:8c8652cf609c6d7b261f25b543413510e1533dcc:changelog:Changed:75279bff906a repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=8c8652cf609c6d7b261f25b543413510e1533dcc date=2026-06-02 updatedAt=2026-06-27T01:43:55.344Z -->
- Replace unsafe heterogeneous tool casts with a shared executable tool collection type. ([README.md](README.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:c61bb40782e05e73d2054dd2202e838424a4cc9e:changelog:Changed:b86ea87cd8c6 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=c61bb40782e05e73d2054dd2202e838424a4cc9e date=2026-06-02 updatedAt=2026-06-27T01:43:55.344Z -->
- **Breaking:** Make unimplemented fleet control methods fail loudly with non-recoverable CAPABILITY_NOT_FOUND errors. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:3c8d93751e8f2d26ecc51a08141cc107c48376cc:changelog:Changed:6129755ef0b5 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=3c8d93751e8f2d26ecc51a08141cc107c48376cc date=2026-06-02 updatedAt=2026-06-27T01:43:55.344Z -->
- Propagate cancellation through parallel orchestration runners. (Ninel Hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:d45cbaeb4d1156ee979541c7ecf418a3dbc3f9be:changelog:Added:aaa9e5867f79 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=d45cbaeb4d1156ee979541c7ecf418a3dbc3f9be date=2026-06-02 updatedAt=2026-06-27T01:43:55.345Z -->
- Add governed subagent runtime contracts and adapter export wiring. ([docs/PUBLIC_API_SURFACE_ALLOWLISTS.md](docs/PUBLIC_API_SURFACE_ALLOWLISTS.md), [docs/SERVER_API_SURFACE_INDEX.md](docs/SERVER_API_SURFACE_INDEX.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:4d40009784b6e6cff6ae591f155ffb4d47fa19b1:changelog:Added:e3d088b7ff54 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=4d40009784b6e6cff6ae591f155ffb4d47fa19b1 date=2026-06-02 updatedAt=2026-06-27T01:43:55.345Z -->
- Add governed background subagents design and boundary documentation. ([docs/superpowers/specs/2026-06-01-governed-async-background-subagents-design.md](docs/superpowers/specs/2026-06-01-governed-async-background-subagents-design.md), [packages/subagents/OWN-WRAP-CONVERGE.md](packages/subagents/OWN-WRAP-CONVERGE.md), [packages/subagents/README.md](packages/subagents/README.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:40735992ba8db28b1a2beed445dbe398c0fbeecb:changelog:Added:b68270331471 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=40735992ba8db28b1a2beed445dbe398c0fbeecb date=2026-06-02 updatedAt=2026-06-27T01:43:55.345Z -->
- Add governed background subagent runtime package and agent-adapter wiring. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:c061ad43caf3d4b6d502f92a6d0de19e224323c4:changelog:Added:76b9e33369ec repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=c061ad43caf3d4b6d502f92a6d0de19e224323c4 date=2026-06-02 updatedAt=2026-06-27T01:43:55.346Z -->
- Export the AnyExecutableDomainTool type from app-tools. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:454a477c89fc9487e1da7faa57f8b3b2fcebfb0a:changelog:Added:1e1a34377740 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=454a477c89fc9487e1da7faa57f8b3b2fcebfb0a date=2026-06-02 updatedAt=2026-06-27T01:43:55.346Z -->
- Add root barrel growth budgets for public API export surfaces. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:dad6b969a237d324b24ef85a23a836324fff69a0:changelog:Added:78d34f05aaa8 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=dad6b969a237d324b24ef85a23a836324fff69a0 date=2026-06-02 updatedAt=2026-06-27T01:43:55.346Z -->
- Add optional pipeline checkpoint idempotency key metadata. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:d210ae7af30a8bd871b78138bc3ab01bbf201e3d:changelog:Added:e0d8de008d6b repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=d210ae7af30a8bd871b78138bc3ab01bbf201e3d date=2026-06-02 updatedAt=2026-06-27T01:43:55.346Z -->
- Add stable node idempotency keys to pipeline execution checkpoints. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:0d6057bca35f1cb29188301aeb6afa22d3cb1b51:changelog:Added:83d074e73c35 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=0d6057bca35f1cb29188301aeb6afa22d3cb1b51 date=2026-06-02 updatedAt=2026-06-27T01:43:55.347Z -->
- Add node idempotency keys to pipeline runtime context and checkpoints. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:09f0f2daf88474cd454902b2db90a619f0492bc8:changelog:Added:86e6fc09da5b repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=09f0f2daf88474cd454902b2db90a619f0492bc8 date=2026-06-02 updatedAt=2026-06-27T01:43:55.347Z -->
- Add per-node pipeline idempotency keys for checkpointed resume. (ninel.hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->

### Fixed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:a005d9b2a8ccd582b9ec8824134ac1d26dd2c96e:changelog:Fixed:6239a7356254 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=a005d9b2a8ccd582b9ec8824134ac1d26dd2c96e date=2026-06-02 updatedAt=2026-06-27T01:43:55.347Z -->
- Fix subagent execution to validate registered providers before recording adapter health. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:0d021ed3953c1d588bff2150ec236927d1ed21bb:changelog:Fixed:38ef41c3a585 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=0d021ed3953c1d588bff2150ec236927d1ed21bb date=2026-06-02 updatedAt=2026-06-27T01:43:55.348Z -->
- **Breaking:** Block MCP stdio arg-injection vectors and private-network browser navigation targets. ([README.md](README.md)) (Ninel Hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:409ba4a131d3c8fadef18037aa0b472614772a2a:changelog:Fixed:c382f259c32c repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=409ba4a131d3c8fadef18037aa0b472614772a2a date=2026-06-02 updatedAt=2026-06-27T01:43:55.348Z -->
- Fix cross-tenant access checks for deployment history and evaluation runs. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:5d714cecf72df806491d7f0857b05080fa5aac54:changelog:Fixed:d17bd664afb1 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=5d714cecf72df806491d7f0857b05080fa5aac54 date=2026-06-02 updatedAt=2026-06-27T01:43:55.348Z -->
- **Breaking:** Fail closed by default when tool result safety scanning fails. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:cb492cd7a36c31243f14b780a84971b028b3af21:changelog:Fixed:6368fa5609e3 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=cb492cd7a36c31243f14b780a84971b028b3af21 date=2026-06-02 updatedAt=2026-06-27T01:43:55.348Z -->
- Block MCP stdio argument-injection RCE and private browser navigation targets. ([docs/CAPABILITY_MATRIX.md](docs/CAPABILITY_MATRIX.md)) (ninelhodzic)
<!-- /workspace-changelog:entry -->

## 2026-06-01

### Changed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:7fe9de770ded30ef60bd9112a79cc553a028a179:changelog:Changed:5e3c02e37f29 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=7fe9de770ded30ef60bd9112a79cc553a028a179 date=2026-06-01 updatedAt=2026-06-27T01:43:55.349Z -->
- **Breaking:** Centralize policy number guards and sanitize route error telemetry. ([README.md](README.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->

### Removed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:b44150a2e2cd01129db2a12a7c881eb0416d45ab:changelog:Removed:da4a27833b7d repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=b44150a2e2cd01129db2a12a7c881eb0416d45ab date=2026-06-01 updatedAt=2026-06-27T01:43:55.350Z -->
- **Breaking:** Remove legacy database connector, WebSocket server, and shared skill-config validation modules while tightening agent maxToolCalls validation. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

### Fixed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:303249991e3b03fdc347edf60b2ba12736aa5448:changelog:Fixed:6dc7ca8ef497 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=303249991e3b03fdc347edf60b2ba12736aa5448 date=2026-06-01 updatedAt=2026-06-27T01:43:55.350Z -->
- Fix routing-stats telemetry scoping for legacy ownerless runs and bound stuck-detector buffers. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

## 2026-05-31

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:e368a4bc163b49a4fcad7da5e36e45e6b888ebaf:changelog:Added:7de22a0e92f7 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=e368a4bc163b49a4fcad7da5e36e45e6b888ebaf date=2026-05-31 updatedAt=2026-06-27T01:43:55.351Z -->
- Expose MCP sharing mode metadata, watcher activation state, and OpenAI tool call IDs in agent adapters. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:85b54336770bf5031b122ccb1ae24a6ab0c10539:changelog:Added:9b17068d30c7 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=85b54336770bf5031b122ccb1ae24a6ab0c10539 date=2026-05-31 updatedAt=2026-06-27T01:43:55.351Z -->
- Add raw provider stream emission and persistence to agent adapters. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:819792f52ddb164571cd2e4bdff5f727b3f8b77b:changelog:Added:2d5525db12e5 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=819792f52ddb164571cd2e4bdff5f727b3f8b77b date=2026-05-31 updatedAt=2026-06-27T01:43:55.351Z -->
- Add fleet orchestration and fleet executor package subpath exports. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->

## 2026-05-30

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:db1df5540a13b10b129295ad937bec05dc6025d0:changelog:Added:3549960fe4c1 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=db1df5540a13b10b129295ad937bec05dc6025d0 date=2026-05-30 updatedAt=2026-06-27T01:43:55.352Z -->
- Add fleet and knowledge flow node support with declaration-only package build fixes. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

### Fixed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:0cc693a92317c84d023309cb9e3f67aebfb47164:changelog:Fixed:923ddeea9409 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=0cc693a92317c84d023309cb9e3f67aebfb47164 date=2026-05-30 updatedAt=2026-06-27T01:43:55.352Z -->
- Fix fleet subpath packaging for agent types. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

## 2026-05-29

### Changed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:bf53e18a65b26f0e3954623f446ee3763197ed39:changelog:Changed:6104cb9fc8bd repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=bf53e18a65b26f0e3954623f446ee3763197ed39 date=2026-05-29 updatedAt=2026-06-27T01:43:55.354Z -->
- Include a worker-specific suffix in fleet task-state versions. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:1f15017ca1fe30ac1246569e6f10f483e7efcb1b:changelog:Changed:f0d21d95f802 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=1f15017ca1fe30ac1246569e6f10f483e7efcb1b date=2026-05-29 updatedAt=2026-06-27T01:43:55.354Z -->
- **Breaking:** Attach executable, normalized fleet and knowledge steps to compiled flow artifacts. ([README.md](README.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:6ce35f0d030c6d693d72e2b5826985988aa985c9:changelog:Added:6100510a7733 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=6ce35f0d030c6d693d72e2b5826985988aa985c9 date=2026-05-29 updatedAt=2026-06-27T01:43:55.354Z -->
- Add RepoAgent fleet dispatch with task-state lifecycle recording. (Ninel Hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:735c441685ad83457c16b36dfb7ebafb67365f94:changelog:Added:328b9553cc5d repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=735c441685ad83457c16b36dfb7ebafb67365f94 date=2026-05-29 updatedAt=2026-06-27T01:43:55.354Z -->
- Add FanOutPolicy for first-idle fleet task assignment. (Ninel Hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:d6613bd4194120c516c22bda8b87a89235b1c995:changelog:Added:043aeb315c06 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=d6613bd4194120c516c22bda8b87a89235b1c995 date=2026-05-29 updatedAt=2026-06-27T01:43:55.355Z -->
- Add dependency-aware fleet task assignment policy. (Ninel Hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:5d27bba904b241834d239db95941188150f3cdd0:changelog:Added:b13c1b201762 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=5d27bba904b241834d239db95941188150f3cdd0 date=2026-05-29 updatedAt=2026-06-27T01:43:55.355Z -->
- Add SupervisorPolicy fleet assignment and contract reconciliation. (Ninel Hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:15e34953c6f5b45c7661e1d60a277b2222361c19:changelog:Added:983fb448de74 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=15e34953c6f5b45c7661e1d60a277b2222361c19 date=2026-05-29 updatedAt=2026-06-27T01:43:55.355Z -->
- Add a contract-net fleet policy for highest-bid task assignment. (Ninel Hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:2839bfe2909576552b2118fc40b6e6fb18ece787:changelog:Added:e87215cbcbc4 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=2839bfe2909576552b2118fc40b6e6fb18ece787 date=2026-05-29 updatedAt=2026-06-27T01:43:55.355Z -->
- Add FleetSupervisor for fan-out and policy-assigned fleet runs. (ninel.hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:894d9ede9098290ab3cd8da0b5d4ad7aade876f4:changelog:Added:074000ec216b repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=894d9ede9098290ab3cd8da0b5d4ad7aade876f4 date=2026-05-29 updatedAt=2026-06-27T01:43:55.356Z -->
- Add fleet resume plan computation from task-state history. (Ninel Hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:fc649ac07b8769135d9c68b12093dc6a9e349de6:changelog:Added:1ab302bca269 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=fc649ac07b8769135d9c68b12093dc6a9e349de6 date=2026-05-29 updatedAt=2026-06-27T01:43:55.356Z -->
- Add Flow DSL normalization and AST recognition for fleet and knowledge nodes. (ninel.hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:a74d23fcb888cf74c6a3231d5651b2feeec811ce:changelog:Added:1bf2cfeb37f2 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=a74d23fcb888cf74c6a3231d5651b2feeec811ce date=2026-05-29 updatedAt=2026-06-27T01:43:55.356Z -->
- Add flow compiler lowering for fleet and knowledge nodes. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:78188bdb23e8a8a5001c9ac50a51eeb037770f9c:changelog:Added:94a6485b23ba repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=78188bdb23e8a8a5001c9ac50a51eeb037770f9c date=2026-05-29 updatedAt=2026-06-27T01:43:55.356Z -->
- Add fleet-aware flow artifacts and fleet presets. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:8a71381edd973f0476ba92a7c4f454b6e78529b3:changelog:Added:f91eed4c8ef6 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=8a71381edd973f0476ba92a7c4f454b6e78529b3 date=2026-05-29 updatedAt=2026-06-27T01:43:55.356Z -->
- Add exported fleet scenario preset paths for four flows. (ninel.hodzic, Claude Opus 4.8 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:a0fe4249afd008400e51d14c8514e3135b5e70be:changelog:Added:3777c85cee93 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=a0fe4249afd008400e51d14c8514e3135b5e70be date=2026-05-29 updatedAt=2026-06-27T01:43:55.357Z -->
- Add fleet orchestration primitives to the agent orchestration entry point. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:d32fc4a6a7c217f685489fcf347a070d180a69fc:changelog:Added:faf68a0e2d27 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=d32fc4a6a7c217f685489fcf347a070d180a69fc date=2026-05-29 updatedAt=2026-06-27T01:43:55.357Z -->
- Add fleet workflow skills for design runs, contract reconciliation, and postmortems. ([.claude/skills/fleet/design-run.md](.claude/skills/fleet/design-run.md), [.claude/skills/fleet/postmortem.md](.claude/skills/fleet/postmortem.md), [.claude/skills/fleet/reconcile-contracts.md](.claude/skills/fleet/reconcile-contracts.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:4ca2fd788db3bbf97033b4a68bb07d6a792f80ed:changelog:Added:4ead6de4d424 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=4ca2fd788db3bbf97033b4a68bb07d6a792f80ed date=2026-05-29 updatedAt=2026-06-27T01:43:55.357Z -->
- Add fleet orchestration module documentation. ([packages/agent/src/orchestration/fleet/README.md](packages/agent/src/orchestration/fleet/README.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

### Fixed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:91a75ffddcee9e5f598413dfeed0cb1adc4e40bf:changelog:Fixed:6259b7d073d7 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=91a75ffddcee9e5f598413dfeed0cb1adc4e40bf date=2026-05-29 updatedAt=2026-06-27T01:43:55.358Z -->
- Fix fleet executor event handling and retry-safe knowledge snapshot recovery. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:8ab9ba6284a51e95696cdc09988714a012e5b295:changelog:Fixed:49c4bde75a89 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=8ab9ba6284a51e95696cdc09988714a012e5b295 date=2026-05-29 updatedAt=2026-06-27T01:43:55.358Z -->
- Accept fleet and knowledge flow node kinds in parsing and validation. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:d7eb487b0c36e14d70d562fda3b6df56b98953c0:changelog:Fixed:c6e40221be4d repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=d7eb487b0c36e14d70d562fda3b6df56b98953c0 date=2026-05-29 updatedAt=2026-06-27T01:43:55.358Z -->
- Fix flow DSL graph projection and formatting for fleet and knowledge nodes. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

## 2026-05-28

### Changed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:b08431cb9d8be619aef517a01995d0649a296214:changelog:Changed:d5c4835b93c1 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=b08431cb9d8be619aef517a01995d0649a296214 date=2026-05-28 updatedAt=2026-06-27T01:43:55.359Z -->
- Allow local HTTP OpenAI base URLs in the default outbound policy. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:5d3c19782f9476c5eab84fa0f93d68d0618ad75e:changelog:Changed:fb4b11d0b134 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=5d3c19782f9476c5eab84fa0f93d68d0618ad75e date=2026-05-28 updatedAt=2026-06-27T01:43:55.359Z -->
- **Breaking:** Move fleet primitives from @dzupagent/agent to @dzupagent/agent-types. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:b01a20f53dbfe7cc2e4af4a112154c308e417573:changelog:Added:c4df23bc28a6 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=b01a20f53dbfe7cc2e4af4a112154c308e417573 date=2026-05-28 updatedAt=2026-06-27T01:43:55.359Z -->
- Add OpenAI tool call IDs to adapter tool call events. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:bd8b69c2ac5121e4fb1f78a2b0ee4f2ec0def36e:changelog:Added:5ac5aa770bbd repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=bd8b69c2ac5121e4fb1f78a2b0ee4f2ec0def36e date=2026-05-28 updatedAt=2026-06-27T01:43:55.360Z -->
- Add Codex adapter boundary architecture documentation. ([docs/ADAPTER_ARCHITECTURE.md](docs/ADAPTER_ARCHITECTURE.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:e1f23d38fd2db3ba028af6a7addb8e8f1f74b626:changelog:Added:d2b39047092f repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=e1f23d38fd2db3ba028af6a7addb8e8f1f74b626 date=2026-05-28 updatedAt=2026-06-27T01:43:55.360Z -->
- Add exported fleet orchestration types and runtime guards. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:dbe4503fb78bec07a358558060faf59dd8414208:changelog:Added:25a33d335ab7 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=dbe4503fb78bec07a358558060faf59dd8414208 date=2026-05-28 updatedAt=2026-06-27T01:43:55.360Z -->
- Add a KnowledgeStore interface and contract test for fleet orchestration. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:124652caba5c3b444624456f3b49741cae0f744c:changelog:Added:f77d0c6ddf8c repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=124652caba5c3b444624456f3b49741cae0f744c date=2026-05-28 updatedAt=2026-06-27T01:43:55.360Z -->
- Add fleet executor and worker handle interfaces. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:3fa81bb3a0b8f6ae07f959a0593c888674554c6f:changelog:Added:0d3ba5b13cc2 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=3fa81bb3a0b8f6ae07f959a0593c888674554c6f date=2026-05-28 updatedAt=2026-06-27T01:43:55.361Z -->
- Add a fleet policy contract for task assignment, contract reconciliation, completion handling, and escalations. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:dffbf1c6924455330736595d03f528582cc1c295:changelog:Added:255fcecea219 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=dffbf1c6924455330736595d03f528582cc1c295 date=2026-05-28 updatedAt=2026-06-27T01:43:55.361Z -->
- Add a filesystem-backed KnowledgeStore export for memory packages. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:0d8ebf19064f180ec57f10a36de17ee4579d5569:changelog:Added:44c6696df685 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=0d8ebf19064f180ec57f10a36de17ee4579d5569 date=2026-05-28 updatedAt=2026-06-27T01:43:55.361Z -->
- Add knowledge snapshot rebuilding from NDJSON entries. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:e8b9f218840687ab2bdbaf3a054c55e50397697d:changelog:Added:3ca46319e911 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=e8b9f218840687ab2bdbaf3a054c55e50397697d date=2026-05-28 updatedAt=2026-06-27T01:43:55.361Z -->
- Add Codex CLI worker event parsing for fleet executor events. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:e0677e406a623a7103aaa672b8e9aebaf97b53df:changelog:Added:a75807c16376 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=e0677e406a623a7103aaa672b8e9aebaf97b53df date=2026-05-28 updatedAt=2026-06-27T01:43:55.362Z -->
- Add in-process fleet executors for scripted worker fixtures. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:ffa554572ea8dfde73e023effe2875493048e69b:changelog:Added:64ac469a957a repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=ffa554572ea8dfde73e023effe2875493048e69b date=2026-05-28 updatedAt=2026-06-27T01:43:55.362Z -->
- Add Codex subprocess executor for fleet workers. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

### Fixed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:a0f44171059a48ba96f979803c1a30e4fdec58e2:changelog:Fixed:72ac99f52f4a repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=a0f44171059a48ba96f979803c1a30e4fdec58e2 date=2026-05-28 updatedAt=2026-06-27T01:43:55.363Z -->
- **Breaking:** Fix filesystem knowledge namespaces to prevent run, repo, and global scope collisions. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

## 2026-05-27

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:ee24673bc4c62f18f8ca092b36c2a73a74dfcc26:changelog:Added:6d173d6ab417 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=ee24673bc4c62f18f8ca092b36c2a73a74dfcc26 date=2026-05-27 updatedAt=2026-06-27T01:43:55.363Z -->
- Add loop progressKey support to flow AST and DSL normalization. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:744632d07d456749479d479945614575379f1fcb:changelog:Added:0eaf7e27b4c7 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=744632d07d456749479d479945614575379f1fcb date=2026-05-27 updatedAt=2026-06-27T01:43:55.364Z -->
- Add adapter monitor dashboard contracts, tiered DzupAgent configuration, and raw CLI event capture. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:6fa77ccf3cbee3b96bf9756e23dd9fce2bed1776:changelog:Added:5fa16e0f31eb repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=6fa77ccf3cbee3b96bf9756e23dd9fce2bed1776 date=2026-05-27 updatedAt=2026-06-27T01:43:55.364Z -->
- Add optional toolCallId propagation to adapter tool call and result events. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->

### Fixed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:4fd8853b13f2ba39157bdbb157d5c1d94080b71b:changelog:Fixed:ce2cfe803336 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=4fd8853b13f2ba39157bdbb157d5c1d94080b71b date=2026-05-27 updatedAt=2026-06-27T01:43:55.365Z -->
- Warn when searchable memory search fails before falling back to scoped memory recall. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->

## 2026-05-26

### Changed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:4581c86f04dc190a46abe587e9c9e1b0a89e426e:changelog:Changed:b4e3614993a4 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=4581c86f04dc190a46abe587e9c9e1b0a89e426e date=2026-05-26 updatedAt=2026-06-27T01:43:55.366Z -->
- Decouple adapter registry health monitoring from the core advanced circuit breaker. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:9e3828906d3bf0b5ab817739d945b6292c59ce3a:changelog:Changed:ee212dc7227b repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=9e3828906d3bf0b5ab817739d945b6292c59ce3a date=2026-05-26 updatedAt=2026-06-27T01:43:55.366Z -->
- Prioritize standard memory context with query-ranked memory search. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:cf5aa938788d2cca6a3af1259b7beb8ba288d734:changelog:Added:d9cae934f397 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=cf5aa938788d2cca6a3af1259b7beb8ba288d734 date=2026-05-26 updatedAt=2026-06-27T01:43:55.367Z -->
- Add local security-lite helpers for agent adapters. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

### Fixed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:9bcedf7dc8b713a74388aa15dcb5ecf6c3a22306:changelog:Fixed:94491875a026 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=9bcedf7dc8b713a74388aa15dcb5ecf6c3a22306 date=2026-05-26 updatedAt=2026-06-27T01:43:55.367Z -->
- Fix tenant isolation for eval runs and deployment history records. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:b1a93ca0da7838d5d7e4196e41540a45489bb4ae:changelog:Fixed:4be982614217 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=b1a93ca0da7838d5d7e4196e41540a45489bb4ae date=2026-05-26 updatedAt=2026-06-27T01:43:55.368Z -->
- Harden browser navigation policy against private-network requests across all resource types. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:316d6fca51b71e222ef6249fb8549afb94078381:changelog:Fixed:8cac66105c9c repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=316d6fca51b71e222ef6249fb8549afb94078381 date=2026-05-26 updatedAt=2026-06-27T01:43:55.368Z -->
- Tighten route authorization and modularize database connector and flow compiler internals. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:f4fddc2869efd2bff25c71eb2c970e45dbb42d8a:changelog:Fixed:f3f820b2741a repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=f4fddc2869efd2bff25c71eb2c970e45dbb42d8a date=2026-05-26 updatedAt=2026-06-27T01:43:55.369Z -->
- Fix Codex adapter timeout classification by preserving abort reasons across adapter signals. (ninel.hodzic)
<!-- /workspace-changelog:entry -->

## 2026-05-25

### Changed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:9fdd6ab79defab6e41e6db6a132865b429f60530:changelog:Changed:d44475e29ac0 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=9fdd6ab79defab6e41e6db6a132865b429f60530 date=2026-05-25 updatedAt=2026-06-27T01:43:55.369Z -->
- Reject unsupported runtime nodes during flow compilation. ([README.md](README.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:25c6127e681514a618f0b8ce9ab8e15b21d28128:changelog:Changed:9df76a6a100a repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=25c6127e681514a618f0b8ce9ab8e15b21d28128 date=2026-05-25 updatedAt=2026-06-27T01:43:55.370Z -->
- **Breaking:** Require positive integer agent tool-call limits and emit memory threat detection events. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:9661de83c36b04fa288a0c1879954044262fedf9:changelog:Changed:5f026e3e4342 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=9661de83c36b04fa288a0c1879954044262fedf9 date=2026-05-25 updatedAt=2026-06-27T01:43:55.370Z -->
- Jitter circuit breaker reset windows to reduce synchronized LLM retry bursts. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:89d3fdf9c2572555ef953c47932c307f17922337:changelog:Changed:7f2913273c79 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=89d3fdf9c2572555ef953c47932c307f17922337 date=2026-05-25 updatedAt=2026-06-27T01:43:55.371Z -->
- Fail closed on production input scanner errors and rate limit A2A discovery routes. (ninel.hodzic)
<!-- /workspace-changelog:entry -->

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:431bf733bc6b9d878d355e8e60d8c579035e9b9b:changelog:Added:f50c09551c3b repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=431bf733bc6b9d878d355e8e60d8c579035e9b9b date=2026-05-25 updatedAt=2026-06-27T01:43:55.371Z -->
- Add Flow DSL normalization and compiler propagation for document policies, agent templates, and validate blocks. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

### Fixed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:fa2e0e5eff52cf4020c3d3cbb7f0df0490da3f28:changelog:Fixed:5baf2e51b926 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=fa2e0e5eff52cf4020c3d3cbb7f0df0490da3f28 date=2026-05-25 updatedAt=2026-06-27T01:43:55.372Z -->
- Restrict legacy ownerless routing stats runs to operator roles. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:1d9a1f0c3f103757334622d7e23ec2a7d14cdf16:changelog:Fixed:488fdb925c93 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=1d9a1f0c3f103757334622d7e23ec2a7d14cdf16 date=2026-05-25 updatedAt=2026-06-27T01:43:55.372Z -->
- Fix continuation wiring for branched flow tails in the flow compiler. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:b0b215f81fe952ceb74dde575e989d275089fc4d:changelog:Fixed:c97c9c8ca7d2 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=b0b215f81fe952ceb74dde575e989d275089fc4d date=2026-05-25 updatedAt=2026-06-27T01:43:55.372Z -->
- **Breaking:** Default tool result scanner failures to fail-closed to prevent scanner crashes from leaking tool output. (ninel.hodzic)
<!-- /workspace-changelog:entry -->

## 2026-05-22

### Changed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:1ab4705190f57d956498a265fd1e33f352ea881a:changelog:Changed:cffac51504c2 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=1ab4705190f57d956498a265fd1e33f352ea881a date=2026-05-22 updatedAt=2026-06-27T01:43:55.374Z -->
- Generate package declarations with tsc across workspace packages. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:changelog-group:Added:29e12af6098c repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=abe78d3895333a772f8abe3fe70dcd8960f464b8 date=2026-05-22 sourceCommits=abe78d3895333a772f8abe3fe70dcd8960f464b8,1a17bbcb057f7d58ff2c090595048e0b3b761525 updatedAt=2026-06-27T01:43:55.375Z -->
- Add generated DzupAgent capability matrix. ([docs/CAPABILITY_MATRIX.md](docs/CAPABILITY_MATRIX.md)) (Ninel Hodzic, ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:988aa13d1a77d136050fe9f10292e2d774173207:changelog:Added:55eb59b4aa31 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=988aa13d1a77d136050fe9f10292e2d774173207 date=2026-05-22 updatedAt=2026-06-27T01:43:55.375Z -->
- Add DTS declaration emit duration measurement and budget checks. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:823e37af66dbd3593be008d524d527a1b339390f:changelog:Added:1cf58c7bafda repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=823e37af66dbd3593be008d524d527a1b339390f date=2026-05-22 updatedAt=2026-06-27T01:43:55.376Z -->
- Add flow and orchestration authoring surface guidance. ([docs/flow-orchestration-authoring-surfaces.md](docs/flow-orchestration-authoring-surfaces.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:448a9a6b4152c0e5163b1c5d3ec5a3e7dfb334d7:changelog:Added:141c68e38afc repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=448a9a6b4152c0e5163b1c5d3ec5a3e7dfb334d7 date=2026-05-22 updatedAt=2026-06-27T01:43:55.376Z -->
- Add measurement labels and compact diagnostics summaries to the DTS build measurement script. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:dd21f7f8a657427fa8631ba3ec0b73b98c99a31d:changelog:Added:5d2f5ac0f933 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=dd21f7f8a657427fa8631ba3ec0b73b98c99a31d date=2026-05-22 updatedAt=2026-06-27T01:43:55.377Z -->
- Add DTS benchmark JSONL summary and delta reporting to the measurement script. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

### Fixed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:61f4c362103515d011afd271cf820d111620e3f6:changelog:Fixed:378ce6f50059 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=61f4c362103515d011afd271cf820d111620e3f6 date=2026-05-22 updatedAt=2026-06-27T01:43:55.378Z -->
- Reject invalid agent timeout and budget policy limits. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

## 2026-05-21

### Changed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:8408cec57659271d754ca31e0e3bfa87a30fd05d:changelog:Changed:512fb390bff0 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=8408cec57659271d754ca31e0e3bfa87a30fd05d date=2026-05-21 updatedAt=2026-06-27T01:43:55.379Z -->
- Promote @dzupagent/connectors-documents to tier 1 and allow its validation and types public API entries. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:5c20c2d85a804b78a4fb59cbcb791dfe0849d80f:changelog:Changed:695885415af4 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=5c20c2d85a804b78a4fb59cbcb791dfe0849d80f date=2026-05-21 updatedAt=2026-06-27T01:43:55.379Z -->
- Promote connectors-documents to tier 1 and allowlist its validation and type exports. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:d9178c561ea2b3c23bf7f0326cba9067245db1e0:changelog:Changed:58049589a360 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=d9178c561ea2b3c23bf7f0326cba9067245db1e0 date=2026-05-21 updatedAt=2026-06-27T01:43:55.380Z -->
- Split tooling architecture boundaries into base tooling and top-level shim layers. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:833fa4dbb9b051a5db47f6d59cb154458190092d:changelog:Changed:4a946968d518 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=833fa4dbb9b051a5db47f6d59cb154458190092d date=2026-05-21 updatedAt=2026-06-27T01:43:55.380Z -->
- Deprecate @dzupagent/test-utils as a compatibility shim around @dzupagent/testing and route adapter events through shared factories. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:1251413324ebe207fc9183e8ef7e43935b4fbe9e:changelog:Changed:06707a6910a5 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=1251413324ebe207fc9183e8ef7e43935b4fbe9e date=2026-05-21 updatedAt=2026-06-27T01:43:55.381Z -->
- **Breaking:** Deprecate test-utils as a compatibility shim for @dzupagent/testing and standardize adapter event creation through shared factories. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:eec4eab88a195e7b679a68fd7f10db22a69930ca:changelog:Changed:6f69c7a9e829 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=eec4eab88a195e7b679a68fd7f10db22a69930ca date=2026-05-21 updatedAt=2026-06-27T01:43:55.381Z -->
- **Breaking:** Change codegen sampling results to a discriminated union and deprecate legacy server composition aliases. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:4f43ed4d9bcfe25c6d6f6f7dffca538111f74bd8:changelog:Changed:bd596ba506b6 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=4f43ed4d9bcfe25c6d6f6f7dffca538111f74bd8 date=2026-05-21 updatedAt=2026-06-27T01:43:55.382Z -->
- **Breaking:** Change codegen parallel sampling results to a discriminated union and deprecate legacy server composition aliases. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:1f8ab0206d6b3ae94e6147bb457156ca2800c77a:changelog:Added:24c8003a6361 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=1f8ab0206d6b3ae94e6147bb457156ca2800c77a date=2026-05-21 updatedAt=2026-06-27T01:43:55.382Z -->
- Add public API allowlist rules for connectors-documents exports. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:a0234bfb94f87c65cae313b41a51f1050b0f6560:changelog:Added:76d51404394a repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=a0234bfb94f87c65cae313b41a51f1050b0f6560 date=2026-05-21 updatedAt=2026-06-27T01:43:55.383Z -->
- Add agent template references and drain pending audit writes on server shutdown. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:7f4fc183b3f20180f17be42c0894a0082a5166c4:changelog:Added:88b82234f5f9 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=7f4fc183b3f20180f17be42c0894a0082a5166c4 date=2026-05-21 updatedAt=2026-06-27T01:43:55.384Z -->
- Add agent template references and drain audit writes during shutdown. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:d996709e50ed3cc458a203177756247f3d8a1094:changelog:Added:b91d8e83ce01 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=d996709e50ed3cc458a203177756247f3d8a1094 date=2026-05-21 updatedAt=2026-06-27T01:43:55.384Z -->
- Document the connectors-documents public API allowlist. ([docs/PUBLIC_API_SURFACE_ALLOWLISTS.md](docs/PUBLIC_API_SURFACE_ALLOWLISTS.md), [docs/SERVER_API_SURFACE_INDEX.md](docs/SERVER_API_SURFACE_INDEX.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:766a13e10ed642009982a04b99372b2f10e6ee78:changelog:Added:f18da8b1c09f repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=766a13e10ed642009982a04b99372b2f10e6ee78 date=2026-05-21 updatedAt=2026-06-27T01:43:55.385Z -->
- Add the connectors-documents public API surface allowlist. ([docs/PUBLIC_API_SURFACE_ALLOWLISTS.md](docs/PUBLIC_API_SURFACE_ALLOWLISTS.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:9849678ba32629c516ec852fe71578eb70f09fe3:changelog:Added:3eb2e7743f53 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=9849678ba32629c516ec852fe71578eb70f09fe3 date=2026-05-21 updatedAt=2026-06-27T01:43:55.386Z -->
- Add audit redaction policy types for observability configuration. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:fe515f8489ceb7bdbd8152f28eb9fbd632749691:changelog:Added:ee4dd6fcb178 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=fe515f8489ceb7bdbd8152f28eb9fbd632749691 date=2026-05-21 updatedAt=2026-06-27T01:43:55.386Z -->
- Add observability audit redaction policy types. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:90ea66a1d9caa8ee71adb10517aefcee42b4fabc:changelog:Added:9ae678d6eb57 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=90ea66a1d9caa8ee71adb10517aefcee42b4fabc date=2026-05-21 updatedAt=2026-06-27T01:43:55.387Z -->
- Add redacted failure events and metrics for memory write-back and LLM audit sinks. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:50d1a79f0c7def20656b092ce3ca0218f4e93759:changelog:Added:0379fd653050 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=50d1a79f0c7def20656b092ce3ca0218f4e93759 date=2026-05-21 updatedAt=2026-06-27T01:43:55.387Z -->
- Add metrics for memory write-back and LLM audit sink failures with redacted audit details. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:0ab3428b5ce7b069c17c3dc81527090c5d908273:changelog:Added:a33ccd92b8bb repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=0ab3428b5ce7b069c17c3dc81527090c5d908273 date=2026-05-21 updatedAt=2026-06-27T01:43:55.388Z -->
- Add typed adapter event factories and emit core declarations with tsc. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:c31bb5ddc68a5ab6a3325796c91825eabfbc17e9:changelog:Added:0cf81bf4fdbf repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=c31bb5ddc68a5ab6a3325796c91825eabfbc17e9 date=2026-05-21 updatedAt=2026-06-27T01:43:55.389Z -->
- Add exported typed adapter event factories and emit core declarations with tsc. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:3dac85037b619b1931be525dadb6b15f6e9dd2f2:changelog:Added:53838928348c repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=3dac85037b619b1931be525dadb6b15f6e9dd2f2 date=2026-05-21 updatedAt=2026-06-27T01:43:55.389Z -->
- Add core package TypeScript build overrides. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:37353c5407498c62f89b73f54574c8750294bbf6:changelog:Added:028d20ba809c repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=37353c5407498c62f89b73f54574c8750294bbf6 date=2026-05-21 updatedAt=2026-06-27T01:43:55.390Z -->
- Add modular agent and agent-adapters subpath exports and align internal imports. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:c4cf2d224b5bda3f66234a355e561622e55d2b69:changelog:Added:a04c343b56d4 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=c4cf2d224b5bda3f66234a355e561622e55d2b69 date=2026-05-21 updatedAt=2026-06-27T01:43:55.390Z -->
- Add modular subpath exports for agent and adapter packages. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:9ccc8bf643660124dd7528c027fa9a9ca9a7b631:changelog:Added:5e3661519b73 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=9ccc8bf643660124dd7528c027fa9a9ca9a7b631 date=2026-05-21 updatedAt=2026-06-27T01:43:55.391Z -->
- Add server-dispatched agent policy forwarding and generate package declarations with tsup. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:5c863b38bd517e3ee55b28e0aa2bc929605bbd4c:changelog:Added:c0b9ceef2234 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=5c863b38bd517e3ee55b28e0aa2bc929605bbd4c date=2026-05-21 updatedAt=2026-06-27T01:43:55.391Z -->
- Add server-run governance forwarding and package declaration builds. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->

### Fixed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:2472e7ccc5802d0409aa4a3475d80fc352b4d099:changelog:Fixed:86870a8d7eb2 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=2472e7ccc5802d0409aa4a3475d80fc352b4d099 date=2026-05-21 updatedAt=2026-06-27T01:43:55.392Z -->
- Fix DNS-rebinding exposure in outbound fetches and centralize tolerant JSONL parsing. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:f625f60c8832a9f665f189fdcc7599bafce2e873:changelog:Fixed:ab391d65befa repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=f625f60c8832a9f665f189fdcc7599bafce2e873 date=2026-05-21 updatedAt=2026-06-27T01:43:55.392Z -->
- Fix DNS-rebinding exposure in secure outbound fetches and centralize tolerant JSONL parsing. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:ef228e8c2d8b7f84397534b65dd920f197419e7b:changelog:Fixed:b279799059b7 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=ef228e8c2d8b7f84397534b65dd920f197419e7b date=2026-05-21 updatedAt=2026-06-27T01:43:55.393Z -->
- Fix agent adapter Semaphore imports to use the core utils export. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:cae95da93be17c0821a43b603bb0a07b81dd7839:changelog:Fixed:8e394a81757a repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=cae95da93be17c0821a43b603bb0a07b81dd7839 date=2026-05-21 updatedAt=2026-06-27T01:43:55.394Z -->
- Fix Semaphore imports in agent adapter orchestration and testing modules. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:6ae29849c9017f26f8e993b13645b19ad163d40c:changelog:Fixed:f92c1310a460 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=6ae29849c9017f26f8e993b13645b19ad163d40c date=2026-05-21 updatedAt=2026-06-27T01:43:55.394Z -->
- Fix Semaphore imports to use the core utils subpath. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:eac233bffd238bcf6af26469ab2fe099c8fc191b:changelog:Fixed:41fb29f6a5c7 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=eac233bffd238bcf6af26469ab2fe099c8fc191b date=2026-05-21 updatedAt=2026-06-27T01:43:55.395Z -->
- Fix package declaration builds by emitting .d.ts files with tsc. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:0b567707ca62a81ffeeed0ca0977d2c646f6e1fe:changelog:Fixed:185712171950 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=0b567707ca62a81ffeeed0ca0977d2c646f6e1fe date=2026-05-21 updatedAt=2026-06-27T01:43:55.395Z -->
- Fix package declaration generation to use tsc after tsup. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:090d9f6431510a97b2d96d9aa58798021a4b81d5:changelog:Fixed:20e62a753190 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=090d9f6431510a97b2d96d9aa58798021a4b81d5 date=2026-05-21 updatedAt=2026-06-27T01:43:55.396Z -->
- Fix agent package declaration type resolution in tsup output. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:c293081324951bb427beec8461b7f1cdc183fb75:changelog:Fixed:4627974a3be6 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=c293081324951bb427beec8461b7f1cdc183fb75 date=2026-05-21 updatedAt=2026-06-27T01:43:55.396Z -->
- Fix agent package declaration type resolution in build output. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:61573fe7e1431e0e18d2c0703d9f58282cbecc3c:changelog:Fixed:d9c7cac9662d repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=61573fe7e1431e0e18d2c0703d9f58282cbecc3c date=2026-05-21 updatedAt=2026-06-27T01:43:55.397Z -->
- Fix Express adapter declaration generation by using a local DzupAgent-compatible type contract. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:1b02df7ad1376d0d5ddbf025643b71c1c38bb39e:changelog:Fixed:bda3e321c9bd repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=1b02df7ad1376d0d5ddbf025643b71c1c38bb39e date=2026-05-21 updatedAt=2026-06-27T01:43:55.397Z -->
- Fix Express adapter declaration generation by using local agent-compatible types. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:b8cb9b2681b54c58d3eed0c2902f4ca0d075b1ab:changelog:Fixed:bf39a5b3f607 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=b8cb9b2681b54c58d3eed0c2902f4ca0d075b1ab date=2026-05-21 updatedAt=2026-06-27T01:43:55.398Z -->
- Fix declaration coupling in Express router types and agent adapter builds. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:611e7652d09f395a12e0824550db53ffe9e71c0b:changelog:Fixed:aa43dee1c68d repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=611e7652d09f395a12e0824550db53ffe9e71c0b date=2026-05-21 updatedAt=2026-06-27T01:43:55.399Z -->
- Fix package build/type coupling between agent adapters, Express, and LangChain. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:8eecb0007f643b2d0c1e685a0f8995d0a0a5653f:changelog:Fixed:066092762521 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=8eecb0007f643b2d0c1e685a0f8995d0a0a5653f date=2026-05-21 updatedAt=2026-06-27T01:43:55.399Z -->
- Fix package declaration generation for agent-adapters and codegen builds. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:750b97e517d93ffdb61479021571408b10093e4c:changelog:Fixed:6f6446838ad5 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=750b97e517d93ffdb61479021571408b10093e4c date=2026-05-21 updatedAt=2026-06-27T01:43:55.400Z -->
- Fix package builds to emit TypeScript declarations after tsup. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

## 2026-05-20

### Changed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:c2ebe5d8a559d3ac35663577a8d2e46261b6f99e:changelog:Changed:12dea48ab207 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=c2ebe5d8a559d3ac35663577a8d2e46261b6f99e date=2026-05-20 updatedAt=2026-06-27T01:43:55.402Z -->
- **Breaking:** Require Bearer API authorization and add flow document policy threading with configurable input scanner failure handling. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:90105c67b24665281bf221e448ab7d09d6758b69:changelog:Changed:f5a3ce4ab16f repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=90105c67b24665281bf221e448ab7d09d6758b69 date=2026-05-20 updatedAt=2026-06-27T01:43:55.403Z -->
- **Breaking:** Require Bearer authorization headers and add flow document policy threading with safer input-scan failure handling. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:0be732937b673828c05eaa1332a04f8291a47d1a:changelog:Changed:80bb617d0645 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=0be732937b673828c05eaa1332a04f8291a47d1a date=2026-05-20 updatedAt=2026-06-27T01:43:55.403Z -->
- Enforce approval-aware tool scheduling and default frame/CSP protections. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:5f8a76d509b5eeb22bd2782fd4cc93204ad852f8:changelog:Changed:12fef81c5b97 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=5f8a76d509b5eeb22bd2782fd4cc93204ad852f8 date=2026-05-20 updatedAt=2026-06-27T01:43:55.404Z -->
- Track native structured-output token usage, gate approval-required parallel tool batches, and harden default server security headers. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:changelog-group:Added:8d1c5a623d07 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=9fdab7a917e8b6067531f0c99734e6cdb69d8db4 date=2026-05-20 sourceCommits=9fdab7a917e8b6067531f0c99734e6cdb69d8db4,d3e7186cfd4edc5b7a498dd823e06904365c2aac updatedAt=2026-06-27T01:43:55.404Z -->
- Add public and server API surface indexes. ([docs/PUBLIC_API_SURFACE_ALLOWLISTS.md](docs/PUBLIC_API_SURFACE_ALLOWLISTS.md), [docs/SERVER_API_SURFACE_INDEX.md](docs/SERVER_API_SURFACE_INDEX.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:a5081d950e3aa00eda81b6407e58bef7fad7dddf:changelog:Added:4592ec6de197 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=a5081d950e3aa00eda81b6407e58bef7fad7dddf date=2026-05-20 updatedAt=2026-06-27T01:43:55.405Z -->
- Add output key uniqueness to the stable public API allowlist. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:52b80adc2a64f040a8f3e13197b20abd4ce8d14b:changelog:Added:975a0ed7975d repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=52b80adc2a64f040a8f3e13197b20abd4ce8d14b date=2026-05-20 updatedAt=2026-06-27T01:43:55.406Z -->
- Add output-key-uniqueness to the public API allowlist. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:c0d39c2091b24386f737e5f9d478ab7e961f8fe7:changelog:Added:480dc68a4cac repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=c0d39c2091b24386f737e5f9d478ab7e961f8fe7 date=2026-05-20 updatedAt=2026-06-27T01:43:55.406Z -->
- Add flow DSL and orchestration authoring documentation. ([docs/flow-orchestration-authoring-surfaces.md](docs/flow-orchestration-authoring-surfaces.md), [packages/agent-adapters/docs/ARCHITECTURE.md](packages/agent-adapters/docs/ARCHITECTURE.md), [packages/flow-dsl/README.md](packages/flow-dsl/README.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:5b865c4c064f77408ea1553213d239a05c3c7d4b:changelog:Added:982886bf9c6b repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=5b865c4c064f77408ea1553213d239a05c3c7d4b date=2026-05-20 updatedAt=2026-06-27T01:43:55.407Z -->
- Add Flow DSL and agent-adapter orchestration documentation. ([docs/flow-orchestration-authoring-surfaces.md](docs/flow-orchestration-authoring-surfaces.md), [packages/agent-adapters/docs/ARCHITECTURE.md](packages/agent-adapters/docs/ARCHITECTURE.md), [packages/flow-dsl/README.md](packages/flow-dsl/README.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:e74c83f64e7b2075a5e0d125ee7db85a152c04d8:changelog:Added:a2279d47d088 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=e74c83f64e7b2075a5e0d125ee7db85a152c04d8 date=2026-05-20 updatedAt=2026-06-27T01:43:55.411Z -->
- Add flow compiler support for resolving agent toolsets and validating set nodes. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:6d9fb6d3a69024dd63948748de68ffb1550f641f:changelog:Added:2e0234e27fcd repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=6d9fb6d3a69024dd63948748de68ffb1550f641f date=2026-05-20 updatedAt=2026-06-27T01:43:55.411Z -->
- Add Flow compiler support for agent toolset resolution and set nodes. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:c0bc8648615c628f37424d7af6d29d25295f8bfe:changelog:Added:e65b11257810 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=c0bc8648615c628f37424d7af6d29d25295f8bfe date=2026-05-20 updatedAt=2026-06-27T01:43:55.412Z -->
- Add dzupagent public and server API surface indexes. ([docs/PUBLIC_API_SURFACE_ALLOWLISTS.md](docs/PUBLIC_API_SURFACE_ALLOWLISTS.md), [docs/SERVER_API_SURFACE_INDEX.md](docs/SERVER_API_SURFACE_INDEX.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:ea81842a82f40c8e86eff687c37a83ff8b1fee67:changelog:Added:27467a3255f2 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=ea81842a82f40c8e86eff687c37a83ff8b1fee67 date=2026-05-20 updatedAt=2026-06-27T01:43:55.412Z -->
- Add compile-time agent profile flattening and harden run-loop safety checks. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:179b581913a13b64ac23b76a34b05f6a8901835c:changelog:Added:6e3cdd22f16f repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=179b581913a13b64ac23b76a34b05f6a8901835c date=2026-05-20 updatedAt=2026-06-27T01:43:55.413Z -->
- Add typed inline validation blocks to agent flow nodes. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:bd940bb53b99d94deae15311d63d7be6207541f6:changelog:Added:28856a4a9f70 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=bd940bb53b99d94deae15311d63d7be6207541f6 date=2026-05-20 updatedAt=2026-06-27T01:43:55.414Z -->
- Add flow AST types for inline agent validation blocks. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:92ba9bd4f0a90d6c5190153887b92eeaa340a08c:changelog:Added:e176c2893727 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=92ba9bd4f0a90d6c5190153887b92eeaa340a08c date=2026-05-20 updatedAt=2026-06-27T01:43:55.414Z -->
- Add versioned markdown template parsing to flow-dsl. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:5f75a19fe440d685be95c1b526e71dc56032de35:changelog:Added:b20ee8c8b769 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=5f75a19fe440d685be95c1b526e71dc56032de35 date=2026-05-20 updatedAt=2026-06-27T01:43:55.415Z -->
- Add a public versioned markdown template parser for flow-dsl templates. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:f0e406a1ccb3095ccaff0483be8057a3d5f6e5a6:changelog:Added:93045dd5f406 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=f0e406a1ccb3095ccaff0483be8057a3d5f6e5a6 date=2026-05-20 updatedAt=2026-06-27T01:43:55.416Z -->
- Add tenant and owner scoped storage filters for run reflections. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:changelog-group:Added:8cc42411e960 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=539426b34da6d1246bc453fa6da013f43938bdfd date=2026-05-20 sourceCommits=539426b34da6d1246bc453fa6da013f43938bdfd,7049e58740257ae458c5ce3f6ba56d57713a1aba updatedAt=2026-06-27T01:43:55.416Z -->
- Export reflection query option types from the agent package. (ninel.hodzic)
<!-- /workspace-changelog:entry -->

### Fixed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:02b040e95b7dc0781a3e78815cd9aa83c01b65ea:changelog:Fixed:5dcee086cd63 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=02b040e95b7dc0781a3e78815cd9aa83c01b65ea date=2026-05-20 updatedAt=2026-06-27T01:43:55.417Z -->
- **Breaking:** Harden agent guardrails and routing stats authorization while adding compile-time agent profile flattening. ([README.md](README.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:8c78f96c4651942455ad4da0a681da1c45affc47:changelog:Fixed:89413d75f95c repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=8c78f96c4651942455ad4da0a681da1c45affc47 date=2026-05-20 updatedAt=2026-06-27T01:43:55.418Z -->
- Harden runtime error handling and input guards across agent, memory, and prompt stores. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:c1eea037cc6850509f4831178e6b074093983a28:changelog:Fixed:47a0947e67fc repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=c1eea037cc6850509f4831178e6b074093983a28 date=2026-05-20 updatedAt=2026-06-27T01:43:55.419Z -->
- Fix runtime guards to limit sensitive error details and reject invalid prompt operations. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:2ef46af519a242479c4fe693e40e1bc256b51b4f:changelog:Fixed:6f0772b95dea repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=2ef46af519a242479c4fe693e40e1bc256b51b4f date=2026-05-20 updatedAt=2026-06-27T01:43:55.419Z -->
- Fix benchmark tenant isolation and MCP server-name tool matching. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:2b8e01986649d1a8c8ab2b568e8f11551d7bd895:changelog:Fixed:a8b3410e7538 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=2b8e01986649d1a8c8ab2b568e8f11551d7bd895 date=2026-05-20 updatedAt=2026-06-27T01:43:55.420Z -->
- Prevent cross-tenant benchmark access and resolve MCP tool filters by server id or name. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:23c990a36bfbe4897d21078777d8bf7b63544f83:changelog:Fixed:92e8869d7b27 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=23c990a36bfbe4897d21078777d8bf7b63544f83 date=2026-05-20 updatedAt=2026-06-27T01:43:55.420Z -->
- Fix tenant-scoped event delivery and restrict routing telemetry to operator/admin roles. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:2d81c36c144c8c9cb22faa667c93752ffcea9768:changelog:Fixed:0e9d4eadc7c5 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=2d81c36c144c8c9cb22faa667c93752ffcea9768 date=2026-05-20 updatedAt=2026-06-27T01:43:55.421Z -->
- Enforce tenant-scoped event delivery and routing telemetry RBAC. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:869f7f488ddf753f7cb7718d3ca6b9f55c8dccb5:changelog:Fixed:3576f58afdca repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=869f7f488ddf753f7cb7718d3ca6b9f55c8dccb5 date=2026-05-20 updatedAt=2026-06-27T01:43:55.421Z -->
- Scope event stream subscriptions to the authenticated tenant. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:c9e3458a82de8cf407a976a33476778f7d3c6a20:changelog:Fixed:cf3d9131bbed repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=c9e3458a82de8cf407a976a33476778f7d3c6a20 date=2026-05-20 updatedAt=2026-06-27T01:43:55.422Z -->
- Fix event stream tenant isolation. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:8285d9757c083e6ee4b02d26a9d9bb0c86753547:changelog:Fixed:f3d66709f67c repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=8285d9757c083e6ee4b02d26a9d9bb0c86753547 date=2026-05-20 updatedAt=2026-06-27T01:43:55.422Z -->
- Fix cross-tenant telemetry exposure by scoping reflection aggregates and tenant-stamping run events. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:cbffc047365f302fce734c9c5ff38ae1583c858a:changelog:Fixed:e897735d9a92 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=cbffc047365f302fce734c9c5ff38ae1583c858a date=2026-05-20 updatedAt=2026-06-27T01:43:55.423Z -->
- Enforce tenant scoping for reflection lists, reflection patterns, and run events. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:22f35ac1665794b86f2b87299598d6349e10b617:changelog:Fixed:69d5aa4b47f3 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=22f35ac1665794b86f2b87299598d6349e10b617 date=2026-05-20 updatedAt=2026-06-27T01:43:55.424Z -->
- Fix outbound HTTP policy allowedHosts normalization. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:5f53344d6c384b040a4163f08ccd31fb673f880d:changelog:Fixed:60722aaea7ca repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=5f53344d6c384b040a4163f08ccd31fb673f880d date=2026-05-20 updatedAt=2026-06-27T01:43:55.424Z -->
- Fix outbound HTTP policy allowed host normalization. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:6a877c10d1bda70f336109005e514959fdbab621:changelog:Fixed:52b9ec3a5788 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=6a877c10d1bda70f336109005e514959fdbab621 date=2026-05-20 updatedAt=2026-06-27T01:43:55.425Z -->
- Fix tenant scoping for lifecycle events and reflection reads to prevent cross-tenant exposure. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:3ed6151f0b80972703677b198b6fb381c6218882:changelog:Fixed:18ca4bda557e repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=3ed6151f0b80972703677b198b6fb381c6218882 date=2026-05-20 updatedAt=2026-06-27T01:43:55.426Z -->
- Fix tenant isolation for lifecycle events and per-run reflection reads. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:e2cb8b4ad68b72e7c1d7d932ec84c33d0fccf7b5:changelog:Fixed:e9b723fa5b9e repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=e2cb8b4ad68b72e7c1d7d932ec84c33d0fccf7b5 date=2026-05-20 updatedAt=2026-06-27T01:43:55.426Z -->
- Enforce tenant-scoped WebSocket event bridge subscriptions. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:cac8de6cb9cc4da90deebc3483e8140c6bfc109e:changelog:Fixed:df693041849f repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=cac8de6cb9cc4da90deebc3483e8140c6bfc109e date=2026-05-20 updatedAt=2026-06-27T01:43:55.427Z -->
- Fix WebSocket event bridge subscriptions to respect authenticated tenant scope. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:1021b7db9d58ede1b1644ce4a83c59678b73a2d2:changelog:Fixed:8bbddcaa33c4 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=1021b7db9d58ede1b1644ce4a83c59678b73a2d2 date=2026-05-20 updatedAt=2026-06-27T01:43:55.427Z -->
- Fix run reflection list and pattern endpoints to filter by tenant and owner in storage. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

## 2026-05-18

### Changed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:4f2301b2e6347dd05f982c6594f7dbb537b7b1e5:changelog:Changed:ad32dcd38bee repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=4f2301b2e6347dd05f982c6594f7dbb537b7b1e5 date=2026-05-18 updatedAt=2026-06-27T01:43:55.429Z -->
- Consolidate DzupAgent architecture documentation and retire superseded audit artifacts. ([docs/flow-document-lowering-contract.md](docs/flow-document-lowering-contract.md), [docs/planning/todos-risks-implementation-2026-05-17/README.md](docs/planning/todos-risks-implementation-2026-05-17/README.md), [docs/planning/todos-risks-improvement-plan-2026-05-17.md](docs/planning/todos-risks-improvement-plan-2026-05-17.md), [docs/security/gitleaks-allowlist.md](docs/security/gitleaks-allowlist.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:218253769dd35d105c3f4ca566127bdfcae9f5f5:changelog:Changed:b8e07b6f9335 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=218253769dd35d105c3f4ca566127bdfcae9f5f5 date=2026-05-18 updatedAt=2026-06-27T01:43:55.430Z -->
- **Breaking:** Harden agent auth, connector validation, plugin registration, MCP transport handling, and flow agent-node safeguards. (ninel.hodzic)
<!-- /workspace-changelog:entry -->

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:c0e5b42a95a32d5ef99b7ddf5b1f99cad903d542:changelog:Added:fc669e6679ea repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=c0e5b42a95a32d5ef99b7ddf5b1f99cad903d542 date=2026-05-18 updatedAt=2026-06-27T01:43:55.431Z -->
- Add set nodes, memory search fields, and output-key collision diagnostics for flow packages. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:f3a0d0ed36910836e91290562e849b65407fbe03:changelog:Added:54085b4f5d6a repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=f3a0d0ed36910836e91290562e849b65407fbe03 date=2026-05-18 updatedAt=2026-06-27T01:43:55.431Z -->
- Add Flow AST and DSL support for set nodes, memory search operations, and output key uniqueness warnings. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

### Fixed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:c9ba9ead18a6ee02f5465b025e925ab2ec4c29ff:changelog:Fixed:ddcea7f52d41 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=c9ba9ead18a6ee02f5465b025e925ab2ec4c29ff date=2026-05-18 updatedAt=2026-06-27T01:43:55.432Z -->
- **Breaking:** Harden agent authentication, plugin loading, flow validation, MCP transport handling, and connector safety checks. ([README.md](README.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

## 2026-05-15

### Changed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:3086e9ce2ddf187e210a6ba26d28edb2c66d6dcd:changelog:Changed:0c445a14a5e9 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=3086e9ce2ddf187e210a6ba26d28edb2c66d6dcd date=2026-05-15 updatedAt=2026-06-27T01:43:55.433Z -->
- **Breaking:** Require tenant-scoped memory operations and add HTTP request timeouts. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:3141d52e267259a4237632a56a961b95a4d3063d:changelog:Changed:01cc07afa0f3 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=3141d52e267259a4237632a56a961b95a4d3063d date=2026-05-15 updatedAt=2026-06-27T01:43:55.434Z -->
- **Breaking:** Require explicit providers for per-run adapter policies and apply sandbox and permission overrides without mutating shared adapters. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:840eb109d4b73b1e1cf2b9ce212a6332e809ad5b:changelog:Changed:8ac4037a8f1b repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=840eb109d4b73b1e1cf2b9ce212a6332e809ad5b date=2026-05-15 updatedAt=2026-06-27T01:43:55.435Z -->
- **Breaking:** Require explicit providers for per-run policy enforcement and apply sandbox overrides per execution. ([README.md](README.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:09c2c917789d5672d26fe44dc0669314d1f6c42f:changelog:Changed:596bdd646010 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=09c2c917789d5672d26fe44dc0669314d1f6c42f date=2026-05-15 updatedAt=2026-06-27T01:43:55.435Z -->
- Apply compiled policy guardrail hints to adapter event streams. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:b483de42439f2214eb0fc6b75c98c7a7926019c4:changelog:Changed:41edd5b02a4f repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=b483de42439f2214eb0fc6b75c98c7a7926019c4 date=2026-05-15 updatedAt=2026-06-27T01:43:55.436Z -->
- Allow per-request policy conformance mode overrides and warn on legacy policy option transport. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:56e458a837f94f35eed6d7dc0751bbe71a20b30c:changelog:Changed:c6addda0a7f8 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=56e458a837f94f35eed6d7dc0751bbe71a20b30c date=2026-05-15 updatedAt=2026-06-27T01:43:55.437Z -->
- Document policy legacy-option telemetry and strict migration rehearsal. ([packages/agent-adapters/docs/POLICY_CONTEXT_LEGACY_OPTIONS_MIGRATION.md](packages/agent-adapters/docs/POLICY_CONTEXT_LEGACY_OPTIONS_MIGRATION.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:aa8a3d5c6ce522511dc736d96ccf1407faf6836d:changelog:Changed:395fd7c5dbef repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=aa8a3d5c6ce522511dc736d96ccf1407faf6836d date=2026-05-15 updatedAt=2026-06-27T01:43:55.437Z -->
- Emit and audit deprecation events for legacy policy option keys. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:5e43ee3a489f6314845de086b458d47252592d5b:changelog:Changed:864031c9a88e repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=5e43ee3a489f6314845de086b458d47252592d5b date=2026-05-15 updatedAt=2026-06-27T01:43:55.438Z -->
- Deprecate legacy policy option transport with audit events and optional strict enforcement. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:dfe22b71038d95860b4d80cd6590ddb17215597a:changelog:Added:c8f878335dff repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=dfe22b71038d95860b4d80cd6590ddb17215597a date=2026-05-15 updatedAt=2026-06-27T01:43:55.439Z -->
- Warn flow authors when spawn completion waits are unsupported. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:9f92050011517013ca12ce0dab8003bb9e5e4961:changelog:Added:1797d369eb31 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=9f92050011517013ca12ce0dab8003bb9e5e4961 date=2026-05-15 updatedAt=2026-06-27T01:43:55.439Z -->
- Add a compiler warning for unsupported spawn completion waits. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:09f3b6765005281579dafabebc3805c7e2368bc5:changelog:Added:154b5db76532 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=09f3b6765005281579dafabebc3805c7e2368bc5 date=2026-05-15 updatedAt=2026-06-27T01:43:55.440Z -->
- **Breaking:** Add skill-aware provider health metrics and routing bias. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:00f17bcea6bc00ce8a14112432b6ba48f8303367:changelog:Added:54eca79bfba4 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=00f17bcea6bc00ce8a14112432b6ba48f8303367 date=2026-05-15 updatedAt=2026-06-27T01:43:55.440Z -->
- **Breaking:** Add skill-aware health metrics and routing bias to learning-based provider selection. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:88e44e12aaa0797ca325fbdad10596fcc58fcfac:changelog:Added:18e015e61266 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=88e44e12aaa0797ca325fbdad10596fcc58fcfac date=2026-05-15 updatedAt=2026-06-27T01:43:55.441Z -->
- Add adapter preflight validation, metadata skill loading, and candidate auto-promotion. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:f4d1bf7ece8be50a5686af5c9c7e4fd39cb791ef:changelog:Added:29181e3b3cf2 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=f4d1bf7ece8be50a5686af5c9c7e4fd39cb791ef date=2026-05-15 updatedAt=2026-06-27T01:43:55.442Z -->
- Add adapter preflight validation, metadata-mode skill loading, and validation-based candidate promotion. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:43ef0fa8899d7a6eba83320052be35b09c09c4da:changelog:Added:a2b14a90b6e8 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=43ef0fa8899d7a6eba83320052be35b09c09c4da date=2026-05-15 updatedAt=2026-06-27T01:43:55.446Z -->
- Apply compiled policy guardrail overlays to adapter streams. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:b81665047ededc1fea38fbd19a1af04052abb097:changelog:Added:d6f9ab1b80a1 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=b81665047ededc1fea38fbd19a1af04052abb097 date=2026-05-15 updatedAt=2026-06-27T01:43:55.447Z -->
- Add governed PTC tools, policy-aware runtime projections, and versioned agent state primitives. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:694589d7e621832bf69cd499782e9b23cc5464f5:changelog:Added:4cb496164ab6 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=694589d7e621832bf69cd499782e9b23cc5464f5 date=2026-05-15 updatedAt=2026-06-27T01:43:55.447Z -->
- Add governed PTC tools, harness profiles, delta run state storage, versioned context backends, and SSE projections. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:b72e7f6af4994dac4f9e55e97c6b0782ec4cf9c7:changelog:Added:488fbdb9e28f repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=b72e7f6af4994dac4f9e55e97c6b0782ec4cf9c7 date=2026-05-15 updatedAt=2026-06-27T01:43:55.448Z -->
- Add typed policy execution context and policy conformance violation events for adapter routing. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:aee7caf41e5ab48f924f39d1f126c86970e4b717:changelog:Added:e953f98fa77b repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=aee7caf41e5ab48f924f39d1f126c86970e4b717 date=2026-05-15 updatedAt=2026-06-27T01:43:55.449Z -->
- Add typed policy context transport and policy conformance violation events. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:d8fb866fcf509e74e969179db6e39af42c44dfb5:changelog:Added:34c0af51e3a3 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=d8fb866fcf509e74e969179db6e39af42c44dfb5 date=2026-05-15 updatedAt=2026-06-27T01:43:55.450Z -->
- Document legacy policy option deprecation timeline. ([packages/agent-adapters/docs/POLICY_CONTEXT_LEGACY_OPTIONS_MIGRATION.md](packages/agent-adapters/docs/POLICY_CONTEXT_LEGACY_OPTIONS_MIGRATION.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:5b71dc5897f03aa8fa719ed9a07cd2338d972d10:changelog:Added:9856f3788c9c repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=5b71dc5897f03aa8fa719ed9a07cd2338d972d10 date=2026-05-15 updatedAt=2026-06-27T01:43:55.450Z -->
- Add legacy policy option migration guidance. ([packages/agent-adapters/docs/POLICY_CONTEXT_LEGACY_OPTIONS_MIGRATION.md](packages/agent-adapters/docs/POLICY_CONTEXT_LEGACY_OPTIONS_MIGRATION.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:122c46ea0252e6e43e9bcb6641019f5900f500c3:changelog:Added:3c9ab58b278b repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=122c46ea0252e6e43e9bcb6641019f5900f500c3 date=2026-05-15 updatedAt=2026-06-27T01:43:55.451Z -->
- Add per-run policy conformance mode overrides for orchestrator and HTTP adapter requests. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:e14b26b611945c8384c2e759df049a2ce18635a2:changelog:Added:b178e5ae6c91 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=e14b26b611945c8384c2e759df049a2ce18635a2 date=2026-05-15 updatedAt=2026-06-27T01:43:55.452Z -->
- Add strict legacy policy migration guidance for legacy policy option keys. (ninel.hodzic)
<!-- /workspace-changelog:entry -->

### Fixed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:b923de90f90930d7dfe36a5df0163b870cdad99c:changelog:Fixed:683302272b03 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=b923de90f90930d7dfe36a5df0163b870cdad99c date=2026-05-15 updatedAt=2026-06-27T01:43:55.453Z -->
- **Breaking:** Enforce tenant-scoped memory access and add configurable HTTP node timeouts. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:04b00d503a82304a5060cca0c542a96f6fa39456:changelog:Fixed:31a2e4dbdff8 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=04b00d503a82304a5060cca0c542a96f6fa39456 date=2026-05-15 updatedAt=2026-06-27T01:43:55.453Z -->
- Fix SSE projections to omit absent agent metadata. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:3f8f98f1c13abd99bfc7593944fcdeab03cbb9e0:changelog:Fixed:7fa05b342161 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=3f8f98f1c13abd99bfc7593944fcdeab03cbb9e0 date=2026-05-15 updatedAt=2026-06-27T01:43:55.454Z -->
- Fix Express SSE projections to omit optional agent metadata when it is absent. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

## 2026-05-14

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:fc7061cfda57ab17ac97b4f3c616959f9670a0ff:changelog:Added:1c368da21756 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=fc7061cfda57ab17ac97b4f3c616959f9670a0ff date=2026-05-14 updatedAt=2026-06-27T01:43:55.456Z -->
- Add normalization for spawn, emit, and memory DSL nodes with runtime-only graph warnings. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:290a77e8c35ea9969b559e7267fc43f3a1f4d9a6:changelog:Added:de72f1764be0 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=290a77e8c35ea9969b559e7267fc43f3a1f4d9a6 date=2026-05-14 updatedAt=2026-06-27T01:43:55.456Z -->
- Add DSL normalization for spawn, emit, and memory nodes with runtime-only lowering warnings. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:1cb4bebb75c2456558f196daa6af14b6424002f1:changelog:Added:162df84f13fe repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=1cb4bebb75c2456558f196daa6af14b6424002f1 date=2026-05-14 updatedAt=2026-06-27T01:43:55.457Z -->
- Add flow AST definitions for try/catch, loop, HTTP, wait, and subflow nodes. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:bf93a96cde754f9a148a12f38a51ba34ab7c2536:changelog:Added:9a6fa7f900c3 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=bf93a96cde754f9a148a12f38a51ba34ab7c2536 date=2026-05-14 updatedAt=2026-06-27T01:43:55.458Z -->
- Add flow AST node types for error handling, loops, HTTP calls, waits, and subflows. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:changelog-group:Added:0a5556c0b3bb repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=4ae487252414c32c378738b57b52507eb4eac67d date=2026-05-14 sourceCommits=4ae487252414c32c378738b57b52507eb4eac67d,b4972049df481dc20d986657044496782884652e updatedAt=2026-06-27T01:43:55.458Z -->
- Add flow DSL and compiler support for try/catch, loop, HTTP, wait, and subflow nodes. (Ninel Hodzic, ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:38fa3b92219ad5338e6fdacdbfba9633c6d9b7dc:changelog:Added:a93e90e98d8f repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=38fa3b92219ad5338e6fdacdbfba9633c6d9b7dc date=2026-05-14 updatedAt=2026-06-27T01:43:55.459Z -->
- Add a flow emit orchestration domain event. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:f5737f8a58a31986862ea3954028803072772b2b:changelog:Added:36a315270967 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=f5737f8a58a31986862ea3954028803072772b2b date=2026-05-14 updatedAt=2026-06-27T01:43:55.459Z -->
- Add Flow DSL emit orchestration domain events. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

## 2026-05-10

### Fixed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:1a783ef99db703f3e7ce0ba2424a16837e4b6b14:changelog:Fixed:3b0fa1609d0a repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=1a783ef99db703f3e7ce0ba2424a16837e4b6b14 date=2026-05-10 updatedAt=2026-06-27T01:43:55.461Z -->
- Fix create-dzupagent npm binary metadata. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:b4abb3bd45488e0a38dec68c2556d813e2c55f17:changelog:Fixed:cac2fe5817f0 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=b4abb3bd45488e0a38dec68c2556d813e2c55f17 date=2026-05-10 updatedAt=2026-06-27T01:43:55.462Z -->
- Fix create-dzupagent npm bin metadata for npm compatibility. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

## 2026-05-09

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:7d0cd3ac1de4e25ad0e05a4860c68a7d8de6b9e2:changelog:Added:a1528f85f46e repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=7d0cd3ac1de4e25ad0e05a4860c68a7d8de6b9e2 date=2026-05-09 updatedAt=2026-06-27T01:43:55.464Z -->
- Add publish runbook for workflow gates and npm authentication. ([docs/PUBLISH_RUNBOOK.md](docs/PUBLISH_RUNBOOK.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:3f6d33f5b20a3f4b5bbe7f799cf980ce2bf9515b:changelog:Added:a5c26cdc8101 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=3f6d33f5b20a3f4b5bbe7f799cf980ce2bf9515b date=2026-05-09 updatedAt=2026-06-27T01:43:55.464Z -->
- Add a publish runbook for workflow gates and npm authentication. ([docs/PUBLISH_RUNBOOK.md](docs/PUBLISH_RUNBOOK.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->

### Fixed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:57b072f9c80baffa647561519db2d2f14ef205cc:changelog:Fixed:236c3163ebda repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=57b072f9c80baffa647561519db2d2f14ef205cc date=2026-05-09 updatedAt=2026-06-27T01:43:55.465Z -->
- Fix context compression to stay within token budgets and reserve a single system cache breakpoint. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:d7c5109b155ba8eed8748de3d057281ae476eb8a:changelog:Fixed:14cb0d22e629 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=d7c5109b155ba8eed8748de3d057281ae476eb8a date=2026-05-09 updatedAt=2026-06-27T01:43:55.466Z -->
- Fix over-budget context compression and excessive prompt-cache breakpoints. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:8be6edc4d4c265feb6451fd513690227ec5f5888:changelog:Fixed:a751e78a9786 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=8be6edc4d4c265feb6451fd513690227ec5f5888 date=2026-05-09 updatedAt=2026-06-27T01:43:55.467Z -->
- Declare the Gemini SDK package as an optional adapter dependency. ([packages/agent-adapters/ARCHITECTURE.md](packages/agent-adapters/ARCHITECTURE.md), [packages/agent-adapters/docs/ARCHITECTURE.md](packages/agent-adapters/docs/ARCHITECTURE.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:c03918826b792c56c135ee8e6f1017e256eb81c0:changelog:Fixed:ea859f3ab165 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=c03918826b792c56c135ee8e6f1017e256eb81c0 date=2026-05-09 updatedAt=2026-06-27T01:43:55.467Z -->
- Declare the Gemini SDK package as an optional agent-adapters dependency. ([packages/agent-adapters/ARCHITECTURE.md](packages/agent-adapters/ARCHITECTURE.md), [packages/agent-adapters/docs/ARCHITECTURE.md](packages/agent-adapters/docs/ARCHITECTURE.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:7d87c152b4720bcdcfa829e8ad2ecfb9e2e8c061:changelog:Fixed:d453c1bba8ab repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=7d87c152b4720bcdcfa829e8ad2ecfb9e2e8c061 date=2026-05-09 updatedAt=2026-06-27T01:43:55.468Z -->
- Fix optional Puppeteer peer imports in the scraper browser pool. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:e07c54e96f1ca5ac66aeb9a5ed08c0ed0de0de4e:changelog:Fixed:74b6c22ccb7c repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=e07c54e96f1ca5ac66aeb9a5ed08c0ed0de0de4e date=2026-05-09 updatedAt=2026-06-27T01:43:55.469Z -->
- Fix scraper browser loading for optional Puppeteer peer dependencies. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:389d3a3184c287f8913785cdba8b7f0e20e30524:changelog:Fixed:4b1c6756ec37 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=389d3a3184c287f8913785cdba8b7f0e20e30524 date=2026-05-09 updatedAt=2026-06-27T01:43:55.470Z -->
- Fix optional Qdrant client loading for RAG providers. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:44d6cf2344100064068e4682d32072f0aedb1d81:changelog:Fixed:122790464a7b repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=44d6cf2344100064068e4682d32072f0aedb1d81 date=2026-05-09 updatedAt=2026-06-27T01:43:55.471Z -->
- Fix Qdrant RAG provider loading with the optional client peer dependency. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:d8aeb9b8816e80bc5d724ec47523ff516c254075:changelog:Fixed:4650e8205a1f repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=d8aeb9b8816e80bc5d724ec47523ff516c254075 date=2026-05-09 updatedAt=2026-06-27T01:43:55.472Z -->
- Fix published package metadata for TypeScript subpath declarations and CLI binaries. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:221e22e12a95cafc4d665a8784ff88a4c2fb049a:changelog:Fixed:2cca877dd7cb repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=221e22e12a95cafc4d665a8784ff88a4c2fb049a date=2026-05-09 updatedAt=2026-06-27T01:43:55.473Z -->
- Fix package metadata for TypeScript subpath declarations and CLI bin compatibility. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

## 2026-05-08

### Changed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:21be833be73e811a9f0d045e61ff337ba299b207:changelog:Changed:721eaf447e5a repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=21be833be73e811a9f0d045e61ff337ba299b207 date=2026-05-08 updatedAt=2026-06-27T01:43:55.474Z -->
- Improve memory consolidation, Claude token counting, Slack outbound policy injection, and server type contract isolation. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:53a8131206a156ddf2318c0ae5e96c1a54cb4c19:changelog:Added:f5b5c3a26515 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=53a8131206a156ddf2318c0ae5e96c1a54cb4c19 date=2026-05-08 updatedAt=2026-06-27T01:43:55.475Z -->
- Add a CLI stream-source bridge and normalize Anthropic cache token usage. ([docs/dzupagent/adr/ADR-0008-request-scope-workspace-isolation.md](docs/dzupagent/adr/ADR-0008-request-scope-workspace-isolation.md), [docs/dzupagent/adr/ADR-0009-break-remaining-circular-deps.md](docs/dzupagent/adr/ADR-0009-break-remaining-circular-deps.md)) (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:d4d9250c4cebd4d85c30290d33766ef5a5d67ccc:changelog:Added:10a6cfeff7fb repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=d4d9250c4cebd4d85c30290d33766ef5a5d67ccc date=2026-05-08 updatedAt=2026-06-27T01:43:55.476Z -->
- Add core MCP and model package subpath exports. ([docs/PUBLIC_API_SURFACE_ALLOWLISTS.md](docs/PUBLIC_API_SURFACE_ALLOWLISTS.md)) (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:eb932a4c62c79defd63f3077581ac10c1e6d2f86:changelog:Added:c6821f02246f repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=eb932a4c62c79defd63f3077581ac10c1e6d2f86 date=2026-05-08 updatedAt=2026-06-27T01:43:55.477Z -->
- Add dedicated core MCP and model subpath exports. ([docs/PUBLIC_API_SURFACE_ALLOWLISTS.md](docs/PUBLIC_API_SURFACE_ALLOWLISTS.md)) (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:772693c229e38cd6f7205c2c13f36ab6ccdfe210:changelog:Added:b2e970f2aeeb repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=772693c229e38cd6f7205c2c13f36ab6ccdfe210 date=2026-05-08 updatedAt=2026-06-27T01:43:55.478Z -->
- Add memory consolidation hooks, Claude token counting fallback, and type-only server contracts. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:e460a40f3780cfc47b8936600e95d3e04f8cf05e:changelog:Added:6c603f8ff45b repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=e460a40f3780cfc47b8936600e95d3e04f8cf05e date=2026-05-08 updatedAt=2026-06-27T01:43:55.483Z -->
- Add circular dependency closure and regression-prevention ADR. ([docs/dzupagent/adr/ADR-0010-circular-dependency-resolution.md](docs/dzupagent/adr/ADR-0010-circular-dependency-resolution.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:0c3abce98f3922f8c041f1f7e197c48b24f74a17:changelog:Added:9f1d1609b3f3 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=0c3abce98f3922f8c041f1f7e197c48b24f74a17 date=2026-05-08 updatedAt=2026-06-27T01:43:55.484Z -->
- Add circular dependency closure ADR and regression-prevention policy. ([docs/dzupagent/adr/ADR-0010-circular-dependency-resolution.md](docs/dzupagent/adr/ADR-0010-circular-dependency-resolution.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:changelog-group:Added:3fb5b404e895 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=5d47fda48837adb83ca1dba41d7c62c6d86d3495 date=2026-05-08 sourceCommits=5d47fda48837adb83ca1dba41d7c62c6d86d3495,a054641cda9793b51b39fd9367d878fb4635fc75 updatedAt=2026-06-27T01:43:55.485Z -->
- Add package export artifact checks to verification gates. ([docs/improvements/MC_SPLIT_PR_READINESS_2026-05-08.md](docs/improvements/MC_SPLIT_PR_READINESS_2026-05-08.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

### Fixed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:274290be7be6660561c687b22759ca8d4fa3d402:changelog:Fixed:0d19064a4b3f repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=274290be7be6660561c687b22759ca8d4fa3d402 date=2026-05-08 updatedAt=2026-06-27T01:43:55.486Z -->
- Fix createOrchestrator facade factory exports. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:f41642065895b977e69313dde9ea6d1496c3687f:changelog:Fixed:8d9887b5907c repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=f41642065895b977e69313dde9ea6d1496c3687f date=2026-05-08 updatedAt=2026-06-27T01:43:55.487Z -->
- Fix createOrchestrator facade exports in agent adapters. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:64301128cff99cd944df8f816d2530d5f18b2e63:changelog:Fixed:7dcbb9a11516 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=64301128cff99cd944df8f816d2530d5f18b2e63 date=2026-05-08 updatedAt=2026-06-27T01:43:55.488Z -->
- Normalize Anthropic cache token usage and expose a shared CLI stream source for adapter implementations. ([docs/dzupagent/adr/ADR-0008-request-scope-workspace-isolation.md](docs/dzupagent/adr/ADR-0008-request-scope-workspace-isolation.md), [docs/dzupagent/adr/ADR-0009-break-remaining-circular-deps.md](docs/dzupagent/adr/ADR-0009-break-remaining-circular-deps.md)) (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:76f46a408b85dad5fb96748fb0cdecd5fae8ea63:changelog:Fixed:bf9bac4a980a repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=76f46a408b85dad5fb96748fb0cdecd5fae8ea63 date=2026-05-08 updatedAt=2026-06-27T01:43:55.489Z -->
- Expose the documented @dzupagent/testing/vitest-llm-setup package subpath for Vitest setupFiles consumers. ([packages/testing/docs/ARCHITECTURE.md](packages/testing/docs/ARCHITECTURE.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:b5d9c94e78533ffe710739129b75a91adaca7225:changelog:Fixed:e0b94edbe5f8 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=b5d9c94e78533ffe710739129b75a91adaca7225 date=2026-05-08 updatedAt=2026-06-27T01:43:55.490Z -->
- Fix @dzupagent/testing/vitest-llm-setup subpath exports for Vitest setup consumers. ([packages/testing/docs/ARCHITECTURE.md](packages/testing/docs/ARCHITECTURE.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:fa02e232ea44b1a6628039bfa9ecf12c3d82ba5c:changelog:Fixed:db3d47843fa0 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=fa02e232ea44b1a6628039bfa9ecf12c3d82ba5c date=2026-05-08 updatedAt=2026-06-27T01:43:55.491Z -->
- Fix optional tokenizer backend loading from Node ESM modules. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:6f659c88e2e95a20e2d9139f21c8f4997907b435:changelog:Fixed:69f157458d16 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=6f659c88e2e95a20e2d9139f21c8f4997907b435 date=2026-05-08 updatedAt=2026-06-27T01:43:55.492Z -->
- Fix optional tokenizer backend loading from ESM modules. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:144fde0a248a9038cdccf249fc5d74fdf119b22d:changelog:Fixed:4301478e388a repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=144fde0a248a9038cdccf249fc5d74fdf119b22d date=2026-05-08 updatedAt=2026-06-27T01:43:55.492Z -->
- Fix prompt-cache marker injection across Claude model instances, auto-compression loops, and structured output calls. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:6cfad3ddfd35292b4c2950e4ec6ef1e681cde4c9:changelog:Fixed:acf370112b85 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=6cfad3ddfd35292b4c2950e4ec6ef1e681cde4c9 date=2026-05-08 updatedAt=2026-06-27T01:43:55.493Z -->
- Fix prompt cache marker injection across Claude run, compression, and structured-output paths. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:fae2ff313de4d688835230c44310f5bcda0b139c:changelog:Fixed:aa5b225d3c32 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=fae2ff313de4d688835230c44310f5bcda0b139c date=2026-05-08 updatedAt=2026-06-27T01:43:55.494Z -->
- Restore verification, audit, and API surface documentation. ([docs/ADAPTER_RULES_RELEASE_CANDIDATE_2026-05-03.md](docs/ADAPTER_RULES_RELEASE_CANDIDATE_2026-05-03.md), [docs/CAPABILITY_MATRIX.md](docs/CAPABILITY_MATRIX.md), [docs/PUBLIC_API_SURFACE_ALLOWLISTS.md](docs/PUBLIC_API_SURFACE_ALLOWLISTS.md), [docs/SERVER_API_SURFACE_INDEX.md](docs/SERVER_API_SURFACE_INDEX.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:81e61da82b58e464284e050c4d4c732e447e66e0:changelog:Fixed:d6277dc0e3ac repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=81e61da82b58e464284e050c4d4c732e447e66e0 date=2026-05-08 updatedAt=2026-06-27T01:43:55.495Z -->
- Fix improvement drift checks for repositories without archived improvement docs. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:985f3deb574353b6b4e3f819232dbc5c11e5adb2:changelog:Fixed:388219ee0152 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=985f3deb574353b6b4e3f819232dbc5c11e5adb2 date=2026-05-08 updatedAt=2026-06-27T01:43:55.496Z -->
- Fix Arrow memory configuration typing for agent memory context loading. (ninel.hodzic)
<!-- /workspace-changelog:entry -->

## 2026-05-07

### Changed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:changelog-group:Changed:50e9659cf4db repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=888c613d11918bb90751e305dd3232d14777602f date=2026-05-07 sourceCommits=888c613d11918bb90751e305dd3232d14777602f,58c6fbb265224956ffd6e91ab64ec09efb152fba updatedAt=2026-06-27T01:43:55.498Z -->
- **Breaking:** Share SSE parsing helpers across agent adapters and rename MemoryEntry to MemoryFileEntry. (Ninel Hodzic, ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:9cb9bce92fbd1a2989abb8574202512f1ab844f2:changelog:Changed:3f435c449cda repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=9cb9bce92fbd1a2989abb8574202512f1ab844f2 date=2026-05-07 updatedAt=2026-06-27T01:43:55.499Z -->
- Block raw fetch in lint to enforce outbound URL policy. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:d846de1ebb8db91d9fea7ebbb396253d49e9ccc7:changelog:Changed:520e6962cfad repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=d846de1ebb8db91d9fea7ebbb396253d49e9ccc7 date=2026-05-07 updatedAt=2026-06-27T01:43:55.500Z -->
- Enforce SSRF-safe outbound requests by banning raw fetch in ESLint. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:9c0b927b5f67a4edb1c2572f0622ad7a1dfa98ce:changelog:Changed:ad2a72aaae79 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=9c0b927b5f67a4edb1c2572f0622ad7a1dfa98ce date=2026-05-07 updatedAt=2026-06-27T01:43:55.501Z -->
- Improve agent adapter fallback ordering performance and deprecate the private Claude loadSDK alias. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:1b31b7deae54dce55bfb3ecf374ee00bc43375dc:changelog:Changed:81851d1de9c3 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=1b31b7deae54dce55bfb3ecf374ee00bc43375dc date=2026-05-07 updatedAt=2026-06-27T01:43:55.502Z -->
- Improve agent adapter fallback ordering performance for large provider rosters. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:8deccf6a96fbe0ede96f09c9693837ad38ecbff6:changelog:Changed:fe6b37d18b48 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=8deccf6a96fbe0ede96f09c9693837ad38ecbff6 date=2026-05-07 updatedAt=2026-06-27T01:43:55.503Z -->
- Deprecate the codegen compat facade ahead of v2.0 and clarify MergeStrategy domains. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:af405ed61b3537d072ee2d2bafe275ca9f7c2ddb:changelog:Changed:368887969bba repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=af405ed61b3537d072ee2d2bafe275ca9f7c2ddb date=2026-05-07 updatedAt=2026-06-27T01:43:55.503Z -->
- Deprecate @dzupagent/codegen/compat ahead of v2.0 removal and clarify MergeStrategy domains. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:changelog-group:Changed:f5ac51702a61 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=afedcbce70926db52318335ac6f08cdbfdc8c396 date=2026-05-07 sourceCommits=afedcbce70926db52318335ac6f08cdbfdc8c396,d44b6cd05ae65810628fae89bc4803bb233e9f11 updatedAt=2026-06-27T01:43:55.504Z -->
- **Breaking:** Stop output filter chains when a filter returns null. (Ninel Hodzic, ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:ff40640f7a85cf8ace49f69f1d1b2dcf17f81bd3:changelog:Changed:75ec1dab3c29 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=ff40640f7a85cf8ace49f69f1d1b2dcf17f81bd3 date=2026-05-07 updatedAt=2026-06-27T01:43:55.505Z -->
- Make circular dependency checks shardable and concurrent, and scan test files only when requested. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:8dc66972b965a98619400d9f7c2c26d5cd9399bb:changelog:Changed:12558a1cd76a repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=8dc66972b965a98619400d9f7c2c26d5cd9399bb date=2026-05-07 updatedAt=2026-06-27T01:43:55.506Z -->
- Harden codegen tool permissions and switch workspace packages to scoped core submodule imports. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:74c39848ca2d4adaa2c6d22e830edd0aae023ce7:changelog:Changed:e5e0bbb5a5b6 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=74c39848ca2d4adaa2c6d22e830edd0aae023ce7 date=2026-05-07 updatedAt=2026-06-27T01:43:55.507Z -->
- Harden codegen file-tool permission policy and switch packages to modular core subpath imports. ([README.md](README.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:changelog-group:Added:d5132b9777b6 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=08d54f0b07ee05bd77b97db7828c7d7b832b5d9d date=2026-05-07 sourceCommits=08d54f0b07ee05bd77b97db7828c7d7b832b5d9d,c80d5bf7f9fb7bca7563e07648fff5d62e01524e updatedAt=2026-06-27T01:43:55.509Z -->
- Add optional agent run-state snapshot persistence. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:2e1852629bfae5221b78e4788d9619a9b8475c51:changelog:Added:f79039a7e8a4 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=2e1852629bfae5221b78e4788d9619a9b8475c51 date=2026-05-07 updatedAt=2026-06-27T01:43:55.509Z -->
- Add baseline-aware circular dependency checks to strict verification. ([docs/PUBLIC_API_SURFACE_ALLOWLISTS.md](docs/PUBLIC_API_SURFACE_ALLOWLISTS.md)) (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:4433f3753d7e573c76fcbdea7d15daf005fd29bc:changelog:Added:ed90997991d8 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=4433f3753d7e573c76fcbdea7d15daf005fd29bc date=2026-05-07 updatedAt=2026-06-27T01:43:55.510Z -->
- Add a baseline-aware circular import gate to strict verification. ([docs/PUBLIC_API_SURFACE_ALLOWLISTS.md](docs/PUBLIC_API_SURFACE_ALLOWLISTS.md)) (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:fa4aebd869606c6709ecbfce8aecbbc762b2aca4:changelog:Added:608b5e0c4e5c repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=fa4aebd869606c6709ecbfce8aecbbc762b2aca4 date=2026-05-07 updatedAt=2026-06-27T01:43:55.511Z -->
- Expose tool-result security scan options in agent config types and normalize circular-dependency output. ([packages/adapter-rules/README.md](packages/adapter-rules/README.md), [packages/adapter-types/README.md](packages/adapter-types/README.md), [packages/agent-types/README.md](packages/agent-types/README.md), [packages/app-tools/README.md](packages/app-tools/README.md), [packages/code-edit-kit/README.md](packages/code-edit-kit/README.md), [packages/eval-contracts/README.md](packages/eval-contracts/README.md), [packages/flow-ast/README.md](packages/flow-ast/README.md), [packages/flow-compiler/README.md](packages/flow-compiler/README.md), [packages/flow-dsl/README.md](packages/flow-dsl/README.md), [packages/hitl-kit/README.md](packages/hitl-kit/README.md), [packages/runtime-contracts/README.md](packages/runtime-contracts/README.md)) (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:24b43a4264b21c8ec2df1aa7f8c3746308b1f53a:changelog:Added:3032860c415d repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=24b43a4264b21c8ec2df1aa7f8c3746308b1f53a date=2026-05-07 updatedAt=2026-06-27T01:43:55.511Z -->
- Add DzupAgent security config typings for scanning tool results. ([packages/agent-types/README.md](packages/agent-types/README.md)) (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:e28b8b30fc7fdcb23dc4ef6fb6c1ea55e2f45de8:changelog:Added:5a4a6b4bcea5 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=e28b8b30fc7fdcb23dc4ef6fb6c1ea55e2f45de8 date=2026-05-07 updatedAt=2026-06-27T01:43:55.512Z -->
- Add runAgentExecution integration helper for Codex and Claude adapter fallback execution. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:1a718c34b126bf067dfbcb1e271f28d62b9f1ed7:changelog:Added:71410208a961 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=1a718c34b126bf067dfbcb1e271f28d62b9f1ed7 date=2026-05-07 updatedAt=2026-06-27T01:43:55.513Z -->
- Add runAgentExecution integration helper for Codex and Claude adapter execution. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:83fa42445b3266cbc2e49b2b3386d5dd857e1835:changelog:Added:c93721bb2fb3 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=83fa42445b3266cbc2e49b2b3386d5dd857e1835 date=2026-05-07 updatedAt=2026-06-27T01:43:55.513Z -->
- Add an ADR documenting flow-compiler ownership and dependency boundaries. ([docs/dzupagent/adr/ADR-0007-flow-compiler-layer-ownership.md](docs/dzupagent/adr/ADR-0007-flow-compiler-layer-ownership.md)) (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:fb3ee389dae48a729cdae2fb0a9b43232d3e7451:changelog:Added:fa2805960a3c repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=fb3ee389dae48a729cdae2fb0a9b43232d3e7451 date=2026-05-07 updatedAt=2026-06-27T01:43:55.514Z -->
- Add an ADR documenting the flow compiler ownership boundary. ([docs/dzupagent/adr/ADR-0007-flow-compiler-layer-ownership.md](docs/dzupagent/adr/ADR-0007-flow-compiler-layer-ownership.md)) (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:b3302d8b5138e9386af7702529f1eb726b8ab213:changelog:Added:d4dd0836ec31 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=b3302d8b5138e9386af7702529f1eb726b8ab213 date=2026-05-07 updatedAt=2026-06-27T01:43:55.515Z -->
- Add pluggable agent output filters and modularize flow validation. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:45eef04c6e794f48d7205a9649ac0ea952b60cd4:changelog:Added:acca8d14ffab repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=45eef04c6e794f48d7205a9649ac0ea952b60cd4 date=2026-05-07 updatedAt=2026-06-27T01:43:55.516Z -->
- Add pluggable agent output filters and split flow validation into modular validators. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:e676d56ca1268a41086e47f1c6b1089099b9a9a1:changelog:Added:9edf0302c648 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=e676d56ca1268a41086e47f1c6b1089099b9a9a1 date=2026-05-07 updatedAt=2026-06-27T01:43:55.517Z -->
- Add sharding, concurrency, and test inclusion controls to the circular dependency checker. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:63f12b1a3d1831a86a8b61c6d384aeadfe4b4a4a:changelog:Added:2ad694b2349a repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=63f12b1a3d1831a86a8b61c6d384aeadfe4b4a4a date=2026-05-07 updatedAt=2026-06-27T01:43:55.522Z -->
- Add focused core subpath exports for events, LLM, tools, identity, persistence, plugins, pipeline, and utilities. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:dc08e0ab67ecf1b374199b2c933e460ab793638d:changelog:Added:605e87ab201a repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=dc08e0ab67ecf1b374199b2c933e460ab793638d date=2026-05-07 updatedAt=2026-06-27T01:43:55.522Z -->
- Add focused @dzupagent/core subpath entry points for events, LLM, tools, identity, persistence, plugins, pipelines, and utilities. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:changelog-group:Added:47e0fbf9d0b0 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=727d0fe636b91252c83bdbd5c2a3fe58e95a28bc date=2026-05-07 sourceCommits=727d0fe636b91252c83bdbd5c2a3fe58e95a28bc,498f03df2be0647dc95b7b0f8a048971490a4e53 updatedAt=2026-06-27T01:43:55.523Z -->
- Add shared pipeline runtime contracts and facade run coordination helpers. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

### Removed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:98f3c1cbfb82539a825e13026312fad36cd9610b:changelog:Removed:3fbca57fc22d repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=98f3c1cbfb82539a825e13026312fad36cd9610b date=2026-05-07 updatedAt=2026-06-27T01:43:55.524Z -->
- **Breaking:** Remove deprecated replay and self-correction re-exports from the agent root barrel. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:5351bbb975c8510697a3252bc0b1ceb439114572:changelog:Removed:94068369cc60 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=5351bbb975c8510697a3252bc0b1ceb439114572 date=2026-05-07 updatedAt=2026-06-27T01:43:55.525Z -->
- **Breaking:** Remove deprecated replay and self-correction re-exports from the @dzupagent/agent root barrel. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->

### Fixed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:127e3d0a7a4433491b82eca98ca6659b4f2dea80:changelog:Fixed:a97518be4556 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=127e3d0a7a4433491b82eca98ca6659b4f2dea80 date=2026-05-07 updatedAt=2026-06-27T01:43:55.526Z -->
- **Breaking:** Hash webhook trigger secrets, redact them from trigger responses, and enable PII scanning for tool results. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:ebd9805172622e9ce936c784e6cbc9024af1556a:changelog:Fixed:c2732a6c0b85 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=ebd9805172622e9ce936c784e6cbc9024af1556a date=2026-05-07 updatedAt=2026-06-27T01:43:55.527Z -->
- **Breaking:** Hash and redact trigger webhook secrets and add PII scanning for tool results. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:cadfd77d3c8c7fb656858942fc8bbfa9080e44cd:changelog:Fixed:a8fd41634854 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=cadfd77d3c8c7fb656858942fc8bbfa9080e44cd date=2026-05-07 updatedAt=2026-06-27T01:43:55.528Z -->
- Recheck tool permissions at issuance time to block TOCTOU tool execution. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:1187df0122d19502de8d2cb134d332c6d7937ccc:changelog:Fixed:79d3b64b354e repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=1187df0122d19502de8d2cb134d332c6d7937ccc date=2026-05-07 updatedAt=2026-06-27T01:43:55.529Z -->
- Fix tool permission TOCTOU gaps by rechecking access immediately before invocation and emitting high-severity safety violations. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:f2d2473bfb8d1daeffed1bceb30f34898f9b9f72:changelog:Fixed:c3d9bc69e1c6 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=f2d2473bfb8d1daeffed1bceb30f34898f9b9f72 date=2026-05-07 updatedAt=2026-06-27T01:43:55.530Z -->
- Fix Arrow memory type imports to avoid a circular dependency. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:37b48c2e0e5aacab65e9bc46e0d9d701b4fde2d6:changelog:Fixed:3379e747cf3a repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=37b48c2e0e5aacab65e9bc46e0d9d701b4fde2d6 date=2026-05-07 updatedAt=2026-06-27T01:43:55.531Z -->
- Fix the Arrow memory type import cycle while preserving the existing agent types export. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:c5ecbd29fec5dce09eed46156d46784c3feab453:changelog:Fixed:24c90ef77b4e repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=c5ecbd29fec5dce09eed46156d46784c3feab453 date=2026-05-07 updatedAt=2026-06-27T01:43:55.532Z -->
- Fix adapter type circular dependencies by moving token usage into a leaf contract. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:b367be3c0dad4496eb2a389c3f07363acee738ef:changelog:Fixed:1c989923573a repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=b367be3c0dad4496eb2a389c3f07363acee738ef date=2026-05-07 updatedAt=2026-06-27T01:43:55.533Z -->
- Fix adapter type contract import cycles by moving token usage types to a leaf module. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:cfcc234e9f287622d4f3b6cb13979080421e6829:changelog:Fixed:3e71d752f4fb repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=cfcc234e9f287622d4f3b6cb13979080421e6829 date=2026-05-07 updatedAt=2026-06-27T01:43:55.534Z -->
- Fix A2A push notification import cycle by moving shared task types into a leaf module. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:c123bc77c45f704a2d9ebbd02bd0099eb14967fd:changelog:Fixed:425ee774649f repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=c123bc77c45f704a2d9ebbd02bd0099eb14967fd date=2026-05-07 updatedAt=2026-06-27T01:43:55.534Z -->
- Fix A2A task-handler and push-notification circular imports. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:cae85564980b83e23f6e3d7e88e8e1d6366c7572:changelog:Fixed:4efce0b3e3d2 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=cae85564980b83e23f6e3d7e88e8e1d6366c7572 date=2026-05-07 updatedAt=2026-06-27T01:43:55.535Z -->
- Fix circular imports between tool resolver and custom tool instantiation. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:0443ab2b13cd8e098178b59f6466c5b16d02bfb0:changelog:Fixed:41fba13d4189 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=0443ab2b13cd8e098178b59f6466c5b16d02bfb0 date=2026-05-07 updatedAt=2026-06-27T01:43:55.536Z -->
- Fix circular imports between server tool resolution and custom tool instantiation. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:a370de007f791aec1e2504db0ea0249eb6efe92a:changelog:Fixed:598ae1e35eea repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=a370de007f791aec1e2504db0ea0249eb6efe92a date=2026-05-07 updatedAt=2026-06-27T01:43:55.537Z -->
- Fix run-worker circular imports by moving shared runtime types to a leaf module. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:changelog-group:Fixed:3fdaf249ac72 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=d3d6189bf48a66dbb4f677891d3f8aaf8eb93662 date=2026-05-07 sourceCommits=d3d6189bf48a66dbb4f677891d3f8aaf8eb93662,d6fb64388a666288b4d757dcbe969859b89781c1 updatedAt=2026-06-27T01:43:55.538Z -->
- Fix server RBAC type imports to remove a circular dependency. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:edf59166019a7d3755c2eb44e8f77787b1bb61ec:changelog:Fixed:3d08486df051 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=edf59166019a7d3755c2eb44e8f77787b1bb61ec date=2026-05-07 updatedAt=2026-06-27T01:43:55.539Z -->
- Restore missing checkpoint, emit, and restore validators for flow AST validation. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:ba84d15f08320aeada9c255ebd530e40b117890c:changelog:Fixed:df987a0c8502 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=ba84d15f08320aeada9c255ebd530e40b117890c date=2026-05-07 updatedAt=2026-06-27T01:43:55.539Z -->
- Fix missing checkpoint, emit, and restore flow node validators. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:17b536dd8cac3f62785460d321f456335431d2d5:changelog:Fixed:e09f7681711a repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=17b536dd8cac3f62785460d321f456335431d2d5 date=2026-05-07 updatedAt=2026-06-27T01:43:55.540Z -->
- Enforce outbound URL policy for adapter and connector fetches. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:766bb26869c5ab05bd35fdd9849248294cac2571:changelog:Fixed:1cbda23392c4 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=766bb26869c5ab05bd35fdd9849248294cac2571 date=2026-05-07 updatedAt=2026-06-27T01:43:55.541Z -->
- Enforce outbound URL policy for adapter and connector fetches and split flow AST validation by node type. ([README.md](README.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:d0cf259120fdb2987d7e9eadfc243a464675030d:changelog:Fixed:d259062b4a36 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=d0cf259120fdb2987d7e9eadfc243a464675030d date=2026-05-07 updatedAt=2026-06-27T01:43:55.541Z -->
- Fix aborted outbound URL requests to stop before DNS lookup or fetch. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:96f3df8107a35c3ccb19cb18f16666fd211c66d5:changelog:Fixed:ccf63f3848cd repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=96f3df8107a35c3ccb19cb18f16666fd211c66d5 date=2026-05-07 updatedAt=2026-06-27T01:43:55.542Z -->
- Honor aborted outbound URL requests before DNS lookup or fetch. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:changelog-group:Fixed:c2223fbc5f2c repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=f528c9a6e59cce7cd210323cff4c0283ecf949fb date=2026-05-07 sourceCommits=f528c9a6e59cce7cd210323cff4c0283ecf949fb,e25f826af7ba8bd9408c8f3c7551dba975b39cc0 updatedAt=2026-06-27T01:43:55.543Z -->
- Fix false stuck detection after paused agents resume. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:525b923c9215abcbe13877ca41bffd5dce706fd5:changelog:Fixed:ecaf5f033b4c repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=525b923c9215abcbe13877ca41bffd5dce706fd5 date=2026-05-07 updatedAt=2026-06-27T01:43:55.544Z -->
- Fix LLM call audit entries to include tenant, prompt, and response traceability details. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:e1410aabb874bef24d4460c44a43926324d34be4:changelog:Fixed:cfe9ea1b2ea5 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=e1410aabb874bef24d4460c44a43926324d34be4 date=2026-05-07 updatedAt=2026-06-27T01:43:55.545Z -->
- Include tenant, prompt, and response details in LLM call audit entries. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:594b6aec44f9239384ed9929a55aba76f0372004:changelog:Fixed:4e01725240b1 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=594b6aec44f9239384ed9929a55aba76f0372004 date=2026-05-07 updatedAt=2026-06-27T01:43:55.545Z -->
- Enforce tool permission policies before binding tools to the model. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:73c2568c6a07343dff57e5178c8984fc29e140df:changelog:Fixed:f0f23b712398 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=73c2568c6a07343dff57e5178c8984fc29e140df date=2026-05-07 updatedAt=2026-06-27T01:43:55.546Z -->
- Exclude tools denied by toolPermissionPolicy before binding them to the model. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:69c6f76c177abd90c8bbfd4cda4f5649eed484f9:changelog:Fixed:ed10eb415dc8 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=69c6f76c177abd90c8bbfd4cda4f5649eed484f9 date=2026-05-07 updatedAt=2026-06-27T01:43:55.547Z -->
- Fix portable OpenTelemetry metric map declarations and complete core subpath import migrations. ([docs/CAPABILITY_MATRIX.md](docs/CAPABILITY_MATRIX.md), [docs/PUBLIC_API_SURFACE_ALLOWLISTS.md](docs/PUBLIC_API_SURFACE_ALLOWLISTS.md)) (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:e27bcfefdb5af994edd0dd147f2d8fde0a37f14f:changelog:Fixed:0107cac22e59 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=e27bcfefdb5af994edd0dd147f2d8fde0a37f14f date=2026-05-07 updatedAt=2026-06-27T01:43:55.548Z -->
- Fix OpenTelemetry metric-map type portability and migrate package imports to stable core subpaths. ([docs/CAPABILITY_MATRIX.md](docs/CAPABILITY_MATRIX.md), [docs/PUBLIC_API_SURFACE_ALLOWLISTS.md](docs/PUBLIC_API_SURFACE_ALLOWLISTS.md)) (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:changelog-group:Fixed:6e332a71ae53 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=a20960fa383177c30365865ee270f6a157f06796 date=2026-05-07 sourceCommits=a20960fa383177c30365865ee270f6a157f06796,dd55fc7cd6a9c7a379e351393e02c13418e22420 updatedAt=2026-06-27T01:43:55.549Z -->
- Fix the orchestrator facade factory import cycle. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

## 2026-05-06

### Changed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:4db816f10cd548e2f9c263f79dd9b2aacf427ac5:changelog:Changed:3231a83f1da3 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=4db816f10cd548e2f9c263f79dd9b2aacf427ac5 date=2026-05-06 updatedAt=2026-06-27T01:43:55.551Z -->
- **Breaking:** Apply default agent run budgets, LLM audit recording, and safer git ref validation. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:4a012762f203e1296afbd8c844150028fa3bceb0:changelog:Changed:9e44d9f0f5ec repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=4a012762f203e1296afbd8c844150028fa3bceb0 date=2026-05-06 updatedAt=2026-06-27T01:43:55.555Z -->
- **Breaking:** Strengthen agent runtime auditing, default run budgets, and git ref validation. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:ebff7dc17ab2a20cf0bb7aeb4f2f937fcef4be06:changelog:Changed:691a7d9dfdbe repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=ebff7dc17ab2a20cf0bb7aeb4f2f937fcef4be06 date=2026-05-06 updatedAt=2026-06-27T01:43:55.556Z -->
- **Breaking:** Unify shared security primitives and scope marketplace catalog slugs by tenant. ([README.md](README.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:c4bdd54a0e15fd8e4c62c29b82a0a55b740b248e:changelog:Changed:49d6b9d22744 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=c4bdd54a0e15fd8e4c62c29b82a0a55b740b248e date=2026-05-06 updatedAt=2026-06-27T01:43:55.556Z -->
- **Breaking:** Change security defaults, route validation, and marketplace catalog slugs around shared security primitives. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:6267320bbaa15a2c69922141cc5677761ad461be:changelog:Changed:fe26080f2ef1 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=6267320bbaa15a2c69922141cc5677761ad461be date=2026-05-06 updatedAt=2026-06-27T01:43:55.557Z -->
- Tighten GitHub outbound request policy support and normalize server rate-limit and update handling. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:631847e15ee104a93f87edafde13f71526062f32:changelog:Changed:7e0b9cc71a62 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=631847e15ee104a93f87edafde13f71526062f32 date=2026-05-06 updatedAt=2026-06-27T01:43:55.558Z -->
- Tighten outbound request safety, rate-limit reset timing, and update validation behavior. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:5dedd3f2ac88cf9bbb0aa174656321c3a04f43ca:changelog:Changed:426717f2ad24 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=5dedd3f2ac88cf9bbb0aa174656321c3a04f43ca date=2026-05-06 updatedAt=2026-06-27T01:43:55.559Z -->
- Document updated public API allowlists and the agent-adapter dzupagent entry surface. ([docs/PUBLIC_API_SURFACE_ALLOWLISTS.md](docs/PUBLIC_API_SURFACE_ALLOWLISTS.md), [packages/agent-adapters/ARCHITECTURE.md](packages/agent-adapters/ARCHITECTURE.md), [packages/agent-adapters/docs/ARCHITECTURE.md](packages/agent-adapters/docs/ARCHITECTURE.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:03e2c8f47b5809d532dad58c2e4571fdd742f48b:changelog:Changed:9df6a59fec7a repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=03e2c8f47b5809d532dad58c2e4571fdd742f48b date=2026-05-06 updatedAt=2026-06-27T01:43:55.560Z -->
- Align package tiers and public API allowlists with dependency architecture. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:6d29ef93e8928408da28307010f6e066fe4ae535:changelog:Changed:e076ae13de11 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=6d29ef93e8928408da28307010f6e066fe4ae535 date=2026-05-06 updatedAt=2026-06-27T01:43:55.561Z -->
- Split orchestration and pipeline runtime modules and add hardened adapter, guardrail, audit, and evaluation support. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:9dbdefb6e321fe0eab817ff631c72a6518d68a79:changelog:Changed:63a0ca2ec7d1 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=9dbdefb6e321fe0eab817ff631c72a6518d68a79 date=2026-05-06 updatedAt=2026-06-27T01:43:55.562Z -->
- Delegate SafetyMonitor prompt-injection and PII scanning to @dzupagent/security with shared policy controls. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:ba4dedd69c88d4e7f60f556fc6e5ac55cc6a950e:changelog:Changed:d783cb010e04 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=ba4dedd69c88d4e7f60f556fc6e5ac55cc6a950e date=2026-05-06 updatedAt=2026-06-27T01:43:55.563Z -->
- Delegate SafetyMonitor prompt-injection and PII checks to canonical security scanners with shared policy controls. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:acfb9cfe9d2695c9be758db2769d7a1a6a9e74b5:changelog:Changed:7adaae26546e repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=acfb9cfe9d2695c9be758db2769d7a1a6a9e74b5 date=2026-05-06 updatedAt=2026-06-27T01:43:55.563Z -->
- Cache supervisor agents and extract bounded orchestration concurrency helpers. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:d43dbb1cf3dbdc669e4f0aebf6ead02006b50ed2:changelog:Changed:b0c0a4386a99 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=d43dbb1cf3dbdc669e4f0aebf6ead02006b50ed2 date=2026-05-06 updatedAt=2026-06-27T01:43:55.564Z -->
- Cache supervisor agents and split orchestration concurrency helpers. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:8225955560776cb3dfb06433aa3da0b58717fa58:changelog:Changed:c9a273550ea1 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=8225955560776cb3dfb06433aa3da0b58717fa58 date=2026-05-06 updatedAt=2026-06-27T01:43:55.565Z -->
- Route agent adapter warnings and diagnostics through the framework logger. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:23dc88b3bd1c88583216cd5684e6b44fce877322:changelog:Changed:bfcf4c9c0737 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=23dc88b3bd1c88583216cd5684e6b44fce877322 date=2026-05-06 updatedAt=2026-06-27T01:43:55.566Z -->
- Route server lifecycle and error logs through the framework logger. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:3c0785e416ff226b1a50a304bdfbdd59105cb640:changelog:Added:1f8b73c99848 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=3c0785e416ff226b1a50a304bdfbdd59105cb640 date=2026-05-06 updatedAt=2026-06-27T01:43:55.567Z -->
- Document playground decommissioning and current server and agent ownership. ([docs/playground/ARCHITECTURE.md](docs/playground/ARCHITECTURE.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:6b21b9d10e77ea2f97031f383d36f3c5ce16e2a0:changelog:Added:882d8ba34797 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=6b21b9d10e77ea2f97031f383d36f3c5ce16e2a0 date=2026-05-06 updatedAt=2026-06-27T01:43:55.567Z -->
- Add tenant-scoped server persistence and LLM invocation audit records. ([docs/PUBLIC_API_SURFACE_ALLOWLISTS.md](docs/PUBLIC_API_SURFACE_ALLOWLISTS.md), [docs/SERVER_API_SURFACE_INDEX.md](docs/SERVER_API_SURFACE_INDEX.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:a3aae5147305db3895c4101f5dd00a81143d63e7:changelog:Added:3977fd785c62 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=a3aae5147305db3895c4101f5dd00a81143d63e7 date=2026-05-06 updatedAt=2026-06-27T01:43:55.568Z -->
- Allow the rate-limit root export as a stable public API. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:02453ad4a582c527378e7672b3d3426e8fe53eeb:changelog:Added:1b18b330196c repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=02453ad4a582c527378e7672b3d3426e8fe53eeb date=2026-05-06 updatedAt=2026-06-27T01:43:55.569Z -->
- Add rate-limit to the stable public API allowlist. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:740dab089b1af9cf5858bf279bc3bb8a03efcf9e:changelog:Added:4b4948a4f5c3 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=740dab089b1af9cf5858bf279bc3bb8a03efcf9e date=2026-05-06 updatedAt=2026-06-27T01:43:55.569Z -->
- Document public API allowlists and agent adapter entry surfaces. ([docs/PUBLIC_API_SURFACE_ALLOWLISTS.md](docs/PUBLIC_API_SURFACE_ALLOWLISTS.md), [packages/agent-adapters/ARCHITECTURE.md](packages/agent-adapters/ARCHITECTURE.md), [packages/agent-adapters/docs/ARCHITECTURE.md](packages/agent-adapters/docs/ARCHITECTURE.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:b4e0517d0c3c5f9b74189a7312d008a1911769a0:changelog:Added:2d7ca47342e8 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=b4e0517d0c3c5f9b74189a7312d008a1911769a0 date=2026-05-06 updatedAt=2026-06-27T01:43:55.570Z -->
- Add modular orchestration and pipeline runtimes with hardened adapter, guardrail, audit, compile, and run handling. ([README.md](README.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:8a4bd59a3c73022e74ec16ba6e16c608830159d6:changelog:Added:07cd74f19bb0 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=8a4bd59a3c73022e74ec16ba6e16c608830159d6 date=2026-05-06 updatedAt=2026-06-27T01:43:55.571Z -->
- Add permission-tier filtering for agent tools. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:ab2b02a4b85eaacc3ae1b175ca17b317f9912e34:changelog:Added:8fac468fcac8 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=ab2b02a4b85eaacc3ae1b175ca17b317f9912e34 date=2026-05-06 updatedAt=2026-06-27T01:43:55.572Z -->
- Add agent permission tiers that hide higher-risk tools and emit tool-filter audit events. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:d3702382e138b211fc7f4c8a6aac7d68735433b5:changelog:Added:b1cce624f669 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=d3702382e138b211fc7f4c8a6aac7d68735433b5 date=2026-05-06 updatedAt=2026-06-27T01:43:55.572Z -->
- Add tool-loop telemetry for context compression failures. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:6a4196821e58ae8c194d691d683b127557533fac:changelog:Added:904a1ca8ab82 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=6a4196821e58ae8c194d691d683b127557533fac date=2026-05-06 updatedAt=2026-06-27T01:43:55.573Z -->
- Add diagnostic events for agent context compression failures. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:04bc8166fee67f58e10c6ae1c8c4f3fe16115e58:changelog:Added:0941bf6f8dc7 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=04bc8166fee67f58e10c6ae1c8c4f3fe16115e58 date=2026-05-06 updatedAt=2026-06-27T01:43:55.574Z -->
- Add @dzupagent/core/vectordb as a published subpath export. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:17920feb3d6fbf11abcc27ade4c815df9509ae79:changelog:Added:eade6c15f020 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=17920feb3d6fbf11abcc27ade4c815df9509ae79 date=2026-05-06 updatedAt=2026-06-27T01:43:55.575Z -->
- Add the core vector database subpath export. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:2dca2116d4e3598542c19f8b8e4b34e273614fc4:changelog:Added:7813c0cf3f53 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=2dca2116d4e3598542c19f8b8e4b34e273614fc4 date=2026-05-06 updatedAt=2026-06-27T01:43:55.575Z -->
- Add agent tool-filter audit and count metrics. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:a16d42a0193ced197d2d756523936c544c469cf0:changelog:Added:59265a1bd7cc repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=a16d42a0193ced197d2d756523936c544c469cf0 date=2026-05-06 updatedAt=2026-06-27T01:43:55.576Z -->
- Add OpenTelemetry metrics for agent tool filtering audits and counts. (ninel.hodzic)
<!-- /workspace-changelog:entry -->

### Fixed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:5b512c594ef94819a068fa7a667d543357986c17:changelog:Fixed:f3020bd375e6 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=5b512c594ef94819a068fa7a667d543357986c17 date=2026-05-06 updatedAt=2026-06-27T01:43:55.577Z -->
- Add tenant-scoped server routing and persistence safeguards across catalog, cluster, persona, prompt, schedule, trigger, approval, and agent APIs. ([audit/full-dzupagent-2026-05-06/run-001/docs/SECURITY-AUDIT.md](audit/full-dzupagent-2026-05-06/run-001/docs/SECURITY-AUDIT.md), [audit/full-dzupagent-2026-05-06/run-001/docs/CROSS-DOMAIN-MATRIX.md](audit/full-dzupagent-2026-05-06/run-001/docs/CROSS-DOMAIN-MATRIX.md), [docs/SERVER_API_SURFACE_INDEX.md](docs/SERVER_API_SURFACE_INDEX.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:efbb32fd862a365d9f6849ce360257009a0ec155:changelog:Fixed:94a5ef464e43 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=efbb32fd862a365d9f6849ce360257009a0ec155 date=2026-05-06 updatedAt=2026-06-27T01:43:55.578Z -->
- Fix tenant-scoped learning records, profiles, and failure patterns in agent adapter stores. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:1403531fc441724ecf9a120f977eda83186272bc:changelog:Fixed:734cb0b28323 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=1403531fc441724ecf9a120f977eda83186272bc date=2026-05-06 updatedAt=2026-06-27T01:43:55.578Z -->
- Isolate agent learning records, profiles, and failure patterns by tenant. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:74a977e735dd99757954b6286126ef957075ce09:changelog:Fixed:cfa16483beaa repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=74a977e735dd99757954b6286126ef957075ce09 date=2026-05-06 updatedAt=2026-06-27T01:43:55.579Z -->
- Enforce outbound URL policy before server probes, webhooks, and GitHub connector requests can reach private or redirected destinations. ([packages/server/README.md](packages/server/README.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:7895fd943c5ebb5e3ea6671166abc2406c9c950e:changelog:Fixed:3402b933916a repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=7895fd943c5ebb5e3ea6671166abc2406c9c950e date=2026-05-06 updatedAt=2026-06-27T01:43:55.582Z -->
- **Breaking:** Enforce outbound URL policy for deployment probes, registry health checks, webhooks, and GitHub connector origins. ([packages/server/README.md](packages/server/README.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:0eab6ecf2b063776dfd581a900a20a195058a074:changelog:Fixed:1badd4cd65e6 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=0eab6ecf2b063776dfd581a900a20a195058a074 date=2026-05-06 updatedAt=2026-06-27T01:43:55.583Z -->
- Fix learning routes to scope reads and writes to the authenticated tenant. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:fead7aafc2b449b955554f70dae0e404b60d2eeb:changelog:Fixed:1ab7c0cff866 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=fead7aafc2b449b955554f70dae0e404b60d2eeb date=2026-05-06 updatedAt=2026-06-27T01:43:55.584Z -->
- Fix learning routes to use the authenticated API key tenant scope for learning data access. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

## 2026-05-05

### Changed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:82027fe95b7601a96e58a663f85b1ca72b80219c:changelog:Changed:73b8e2bf6aff repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=82027fe95b7601a96e58a663f85b1ca72b80219c date=2026-05-05 updatedAt=2026-06-27T01:43:55.586Z -->
- **Breaking:** Separate adapter cache-write metrics and harden Claude adapter runtime sandboxing. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:3885a67ea93fa9e0ce392b4a97f3dc77d9666eb7:changelog:Changed:0b3891c6e9df repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=3885a67ea93fa9e0ce392b4a97f3dc77d9666eb7 date=2026-05-05 updatedAt=2026-06-27T01:43:55.587Z -->
- Refactor adapter runtime orchestration and unify governance, observability, and token metrics. ([README.md](README.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:7edb6e12fec8e4ff0781dbbbb599b4b44edc7d6b:changelog:Changed:8f7f67dc9dd5 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=7edb6e12fec8e4ff0781dbbbb599b4b44edc7d6b date=2026-05-05 updatedAt=2026-06-27T01:43:55.587Z -->
- **Breaking:** Unify adapter stream lifecycle and add prompt cache telemetry. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:81c50f8824b28e484f4b2af27e876cbf7662c394:changelog:Changed:b8f15ffa1ad6 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=81c50f8824b28e484f4b2af27e876cbf7662c394 date=2026-05-05 updatedAt=2026-06-27T01:43:55.588Z -->
- Update public API surface allowlists for current core, agent, and memory exports. ([docs/PUBLIC_API_SURFACE_ALLOWLISTS.md](docs/PUBLIC_API_SURFACE_ALLOWLISTS.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:efd0f04a0b29be7b7cb19b5617195460c4b463ed:changelog:Changed:16c25df25236 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=efd0f04a0b29be7b7cb19b5617195460c4b463ed date=2026-05-05 updatedAt=2026-06-27T01:43:55.589Z -->
- **Breaking:** Refactor agent runtime with distributed guardrails, tokenizer-backed budgeting, memory hygiene, and removed playground exports. ([README.md](README.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:538c38ac8d2b8b872b204d7fd86ff8d31fec05f0:changelog:Changed:b47cba745826 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=538c38ac8d2b8b872b204d7fd86ff8d31fec05f0 date=2026-05-05 updatedAt=2026-06-27T01:43:55.589Z -->
- **Breaking:** Refactor the agent runtime with distributed guardrails, tokenizer-backed token counts, memory hygiene, and removed playground exports. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:5cfe4fee891a70b0ff50de25f66f387bc35636b2:changelog:Added:98cb3e48ef4f repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=5cfe4fee891a70b0ff50de25f66f387bc35636b2 date=2026-05-05 updatedAt=2026-06-27T01:43:55.590Z -->
- **Breaking:** Add shared adapter stream lifecycle handling and prompt cache telemetry. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:d03aeb895429830e65d37a46a6b91451a887db34:changelog:Added:f36e69887b8f repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=d03aeb895429830e65d37a46a6b91451a887db34 date=2026-05-05 updatedAt=2026-06-27T01:43:55.591Z -->
- Add public API allowlist entries for consolidation engine and memory pruner exports. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

### Fixed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:0bb474416fa6048b4fee9233ddff854bb07c89af:changelog:Fixed:4f87e1674077 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=0bb474416fa6048b4fee9233ddff854bb07c89af date=2026-05-05 updatedAt=2026-06-27T01:43:55.592Z -->
- Fix Codex stream cancellation and Claude runner source integration. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:24be6ebd4f884f9ec2580425ede7a92ba75df8b0:changelog:Fixed:0d9ff90ac39e repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=24be6ebd4f884f9ec2580425ede7a92ba75df8b0 date=2026-05-05 updatedAt=2026-06-27T01:43:55.593Z -->
- Fix agent adapter stream lifecycle and interruption handling. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

## 2026-05-04

### Changed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:00fbff7ab361e50e1b99c354d8a4af93457aa9b7:changelog:Changed:45aa96b031cf repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=00fbff7ab361e50e1b99c354d8a4af93457aa9b7 date=2026-05-04 updatedAt=2026-06-27T01:43:55.595Z -->
- **Breaking:** Add shared execution ports and a composable adapter execution pipeline. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:7c3bcc2f4a0a849bb63e9228d97d8cc171b51740:changelog:Added:a0a9aaa7da04 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=7c3bcc2f4a0a849bb63e9228d97d8cc171b51740 date=2026-05-04 updatedAt=2026-06-27T01:43:55.596Z -->
- Add agent adapter audit reports and API surface documentation. ([audit/full-agent-agent-adapters-2026-05-03/run-001/AUDIT_REPORT.md](audit/full-agent-agent-adapters-2026-05-03/run-001/AUDIT_REPORT.md), [audit/full-agent-agent-adapters-2026-05-03/run-001/README.md](audit/full-agent-agent-adapters-2026-05-03/run-001/README.md), [docs/PUBLIC_API_SURFACE_ALLOWLISTS.md](docs/PUBLIC_API_SURFACE_ALLOWLISTS.md), [docs/dzupagent/adr/ADR-0005-memory-client-interface.md](docs/dzupagent/adr/ADR-0005-memory-client-interface.md), [docs/dzupagent/architecture/ORCHESTRATION_TYPES.md](docs/dzupagent/architecture/ORCHESTRATION_TYPES.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:8fe982f74fd033150608287eefedbd514bd5f376:changelog:Added:484bd71ae737 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=8fe982f74fd033150608287eefedbd514bd5f376 date=2026-05-04 updatedAt=2026-06-27T01:43:55.597Z -->
- Add MemoryClient ADR and orchestration type documentation. ([docs/PUBLIC_API_SURFACE_ALLOWLISTS.md](docs/PUBLIC_API_SURFACE_ALLOWLISTS.md), [docs/dzupagent/adr/ADR-0005-memory-client-interface.md](docs/dzupagent/adr/ADR-0005-memory-client-interface.md), [docs/dzupagent/architecture/ORCHESTRATION_TYPES.md](docs/dzupagent/architecture/ORCHESTRATION_TYPES.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:9d00b0f877c3b8169694205ee2098b5ea900b7bf:changelog:Added:948557ba0a71 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=9d00b0f877c3b8169694205ee2098b5ea900b7bf date=2026-05-04 updatedAt=2026-06-27T01:43:55.598Z -->
- Add supported Tier 1 classification and stable public API allowlists for @dzupagent/security. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:566a5c45073c0cf5923897501fa85a39002e4503:changelog:Added:45aa96b031cf repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=566a5c45073c0cf5923897501fa85a39002e4503 date=2026-05-04 updatedAt=2026-06-27T01:43:55.599Z -->
- Add shared execution ports and a composable adapter execution pipeline. (ninel.hodzic)
<!-- /workspace-changelog:entry -->

## 2026-05-03

### Changed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:5005c5c39198f7df7f1793a61dd6a61caa974347:changelog:Changed:8c99cdc216f4 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=5005c5c39198f7df7f1793a61dd6a61caa974347 date=2026-05-03 updatedAt=2026-06-27T01:43:55.600Z -->
- Mark security audit findings resolved with current remediation evidence. ([docs/SECURITY-AUDIT.md](docs/SECURITY-AUDIT.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:6106d8d8495b0cafd2d0bb6162ae2917a3b3fe87:changelog:Changed:4c12f9c49272 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=6106d8d8495b0cafd2d0bb6162ae2917a3b3fe87 date=2026-05-03 updatedAt=2026-06-27T01:43:55.601Z -->
- Document resolved security audit findings with remediation evidence. ([docs/SECURITY-AUDIT.md](docs/SECURITY-AUDIT.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:0278cd1b5c7a7ac2dd8fda34cdb253439f1ac403:changelog:Added:7d48f2a078b3 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=0278cd1b5c7a7ac2dd8fda34cdb253439f1ac403 date=2026-05-03 updatedAt=2026-06-27T01:43:55.602Z -->
- Allow script-runs in the public API allowlist. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:c474239b50b54856977e1cbae7fd983897af7f2a:changelog:Added:ff2bd9ccd5ad repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=c474239b50b54856977e1cbae7fd983897af7f2a date=2026-05-03 updatedAt=2026-06-27T01:43:55.603Z -->
- Add capability matrix and flow orchestration authoring guidance. ([docs/CAPABILITY_MATRIX.md](docs/CAPABILITY_MATRIX.md), [docs/flow-orchestration-authoring-surfaces.md](docs/flow-orchestration-authoring-surfaces.md), [docs/PUBLIC_API_SURFACE_ALLOWLISTS.md](docs/PUBLIC_API_SURFACE_ALLOWLISTS.md), [docs/SERVER_API_SURFACE_INDEX.md](docs/SERVER_API_SURFACE_INDEX.md), [packages/agent-adapters/ARCHITECTURE.md](packages/agent-adapters/ARCHITECTURE.md), [packages/agent/src/orchestration/ARCHITECTURE.md](packages/agent/src/orchestration/ARCHITECTURE.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:aae6e3abcac142d8b73656d2ccac3263efffdd41:changelog:Added:7c82231884fe repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=aae6e3abcac142d8b73656d2ccac3263efffdd41 date=2026-05-03 updatedAt=2026-06-27T01:43:55.604Z -->
- Add capability matrix and flow orchestration authoring documentation. ([docs/CAPABILITY_MATRIX.md](docs/CAPABILITY_MATRIX.md), [docs/flow-orchestration-authoring-surfaces.md](docs/flow-orchestration-authoring-surfaces.md), [docs/PUBLIC_API_SURFACE_ALLOWLISTS.md](docs/PUBLIC_API_SURFACE_ALLOWLISTS.md), [docs/SERVER_API_SURFACE_INDEX.md](docs/SERVER_API_SURFACE_INDEX.md), [packages/agent-adapters/ARCHITECTURE.md](packages/agent-adapters/ARCHITECTURE.md), [packages/agent/src/orchestration/ARCHITECTURE.md](packages/agent/src/orchestration/ARCHITECTURE.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:5e43ec79ce211417412d383ab94e210f8ba49a98:changelog:Added:718d17250d77 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=5e43ec79ce211417412d383ab94e210f8ba49a98 date=2026-05-03 updatedAt=2026-06-27T01:43:55.605Z -->
- **Breaking:** Add managed run event persistence, flow compile evidence, and adapter runtime metrics. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:6d6cb5206c2348f4168679aab625debad43a60f8:changelog:Added:8fb60c8aa21d repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=6d6cb5206c2348f4168679aab625debad43a60f8 date=2026-05-03 updatedAt=2026-06-27T01:43:55.606Z -->
- Add managed run event persistence, adapter runtime metrics, and flow compile evidence. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:349eaf710b122a4daa854ba7ad914fbe9e589849:changelog:Added:776c1ee380a5 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=349eaf710b122a4daa854ba7ad914fbe9e589849 date=2026-05-03 updatedAt=2026-06-27T01:43:55.606Z -->
- Add the rules subpath to public API export allowlists. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:0b536a08b8815634211063550022636c2db4ac1d:changelog:Added:16fe02220a6e repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=0b536a08b8815634211063550022636c2db4ac1d date=2026-05-03 updatedAt=2026-06-27T01:43:55.607Z -->
- Add rules as an allowed public API export subpath. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:63857806a599da74e76246611636ec0860615e86:changelog:Added:9c4ad8be25b9 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=63857806a599da74e76246611636ec0860615e86 date=2026-05-03 updatedAt=2026-06-27T01:43:55.608Z -->
- Add adapter rule runtime diagnostics and monitor telemetry. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:21553d0e68ad47fef3f3aa99ded8ad2d2733f801:changelog:Added:19f6dec38559 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=21553d0e68ad47fef3f3aa99ded8ad2d2733f801 date=2026-05-03 updatedAt=2026-06-27T01:43:55.611Z -->
- Add adapter rule diagnostics, runtime projection helpers, and monitor telemetry. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:cd7d00331017b91b9056746b443174497716c3da:changelog:Added:ae3da6bd55e5 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=cd7d00331017b91b9056746b443174497716c3da date=2026-05-03 updatedAt=2026-06-27T01:43:55.612Z -->
- Add adapter-rules release candidate sealing documentation. ([docs/ADAPTER_RULES_RELEASE_CANDIDATE_2026-05-03.md](docs/ADAPTER_RULES_RELEASE_CANDIDATE_2026-05-03.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:fee72d44ffc00c049842c3289edeedd69f3c16e5:changelog:Added:83869b62b2f8 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=fee72d44ffc00c049842c3289edeedd69f3c16e5 date=2026-05-03 updatedAt=2026-06-27T01:43:55.613Z -->
- Document CLI-based agent adapter authentication, bridge integration, event logging, and execution timeouts. ([packages/agent-adapters/README.md](packages/agent-adapters/README.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:62b41f2dbb3b4aa1068e6b473bd0c605fd2f6a12:changelog:Added:7d5a34cfe970 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=62b41f2dbb3b4aa1068e6b473bd0c605fd2f6a12 date=2026-05-03 updatedAt=2026-06-27T01:43:55.614Z -->
- Document CLI adapter authentication, bridge event streaming, and execution timeouts. ([packages/agent-adapters/README.md](packages/agent-adapters/README.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:6a9ded72ba1d3c9f89d65f9c7ff6b3380f6c5926:changelog:Added:711a5f87a7b2 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=6a9ded72ba1d3c9f89d65f9c7ff6b3380f6c5926 date=2026-05-03 updatedAt=2026-06-27T01:43:55.615Z -->
- Add adapter factories and registry-level fallback timeouts with progress events. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:cc67b657c9c1e19488cc3311488245b3ec0c3c79:changelog:Added:6f59c5dd201b repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=cc67b657c9c1e19488cc3311488245b3ec0c3c79 date=2026-05-03 updatedAt=2026-06-27T01:43:55.615Z -->
- Add fallback execution timeouts, routing progress events, adapter factories, and Claude workspace-write permission bypass. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

## 2026-05-02

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:b1499ba49026eff180380d5fc065f5502978f49d:changelog:Added:c6c64eac9152 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=b1499ba49026eff180380d5fc065f5502978f49d date=2026-05-02 updatedAt=2026-06-27T01:43:55.618Z -->
- Add MCP prompt listing and retrieval support. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:d33d1d35d4cfa9356d13f9f307ff5841f468e53e:changelog:Added:83dbf6445a02 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=d33d1d35d4cfa9356d13f9f307ff5841f468e53e date=2026-05-02 updatedAt=2026-06-27T01:43:55.619Z -->
- Add MCP prompt listing and retrieval support to the core server. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:changelog-group:Added:02e05d486f4f repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=1d44addc0b3a84b86695d6a02f000ccc1f216a84 date=2026-05-02 sourceCommits=1d44addc0b3a84b86695d6a02f000ccc1f216a84,544814c0a096db6f4ba77e531e8d9c85dea473fc updatedAt=2026-06-27T01:43:55.620Z -->
- Add categorized flow compiler diagnostics, host tool registry helpers, and flow artifact metadata. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

### Fixed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:changelog-group:Fixed:775c80ac5e2f repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=cc1d628df315d3de8a9deab77b2fda4ec7bf94ff date=2026-05-02 sourceCommits=cc1d628df315d3de8a9deab77b2fda4ec7bf94ff,60f70f34fbaa466202f731e030c73c6acff8b995 updatedAt=2026-06-27T01:43:55.621Z -->
- Fix flow DSL node indentation and inline object parsing. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

## 2026-04-30

### Changed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:41da794fc9208436555eb09888bec2a7ab3ee8fa:changelog:Changed:6514750af991 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=41da794fc9208436555eb09888bec2a7ab3ee8fa date=2026-04-30 updatedAt=2026-06-27T01:43:55.623Z -->
- Refresh developer API surface indexes and playground ownership notes. ([README.md](README.md), [docs/PUBLIC_API_SURFACE_ALLOWLISTS.md](docs/PUBLIC_API_SURFACE_ALLOWLISTS.md), [docs/SERVER_API_SURFACE_INDEX.md](docs/SERVER_API_SURFACE_INDEX.md), [packages/agent/docs/api-tiers.md](packages/agent/docs/api-tiers.md), [packages/playground/docs/ARCHITECTURE.md](packages/playground/docs/ARCHITECTURE.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:3642de5509ff5100921e18090d9e27a3a4b3e79a:changelog:Changed:1cd9b2172e58 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=3642de5509ff5100921e18090d9e27a3a4b3e79a date=2026-04-30 updatedAt=2026-06-27T01:43:55.624Z -->
- Update API surface documentation for the contracted server root and playground ownership notes. ([README.md](README.md), [docs/PUBLIC_API_SURFACE_ALLOWLISTS.md](docs/PUBLIC_API_SURFACE_ALLOWLISTS.md), [docs/SERVER_API_SURFACE_INDEX.md](docs/SERVER_API_SURFACE_INDEX.md), [packages/agent/docs/api-tiers.md](packages/agent/docs/api-tiers.md), [packages/playground/docs/ARCHITECTURE.md](packages/playground/docs/ARCHITECTURE.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:173565fc467f16ce4284f55edbdaff3f48e28f6b:changelog:Changed:60b0b57972b2 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=173565fc467f16ce4284f55edbdaff3f48e28f6b date=2026-04-30 updatedAt=2026-06-27T01:43:55.625Z -->
- **Breaking:** Move feature-plane server APIs to @dzupagent/server/features and add adapter runtime event and Flow AST node support. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:f8a287eb76c9abae13908a7d2ab5b202a45a6863:changelog:Changed:978f80542efa repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=f8a287eb76c9abae13908a7d2ab5b202a45a6863 date=2026-04-30 updatedAt=2026-06-27T01:43:55.625Z -->
- **Breaking:** Move feature-plane server APIs to the explicit `@dzupagent/server/features` subpath and add adapter runtime events with broader flow node parsing. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:1ea423c087231ffb3b8f97f0a9b28922009a705b:changelog:Changed:464bc3150427 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=1ea423c087231ffb3b8f97f0a9b28922009a705b date=2026-04-30 updatedAt=2026-06-27T01:43:55.626Z -->
- Refresh audit findings and public API boundary guidance. ([docs/PUBLIC_API_SURFACE_ALLOWLISTS.md](docs/PUBLIC_API_SURFACE_ALLOWLISTS.md), [packages/agent/src/orchestration/ARCHITECTURE.md](packages/agent/src/orchestration/ARCHITECTURE.md), [packages/server/README.md](packages/server/README.md), [packages/server/docs/ARCHITECTURE.md](packages/server/docs/ARCHITECTURE.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:de4055100340821145fc54e064cf3b8b277005a7:changelog:Changed:9ab8b6b2bf83 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=de4055100340821145fc54e064cf3b8b277005a7 date=2026-04-30 updatedAt=2026-06-27T01:43:55.627Z -->
- **Breaking:** Harden orchestration routing, team policy validation, provider failure accounting, and outbound connector navigation. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:c5a2888a985fac95330baf7364bd5e52c98f4db1:changelog:Changed:7f43600f33b2 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=c5a2888a985fac95330baf7364bd5e52c98f4db1 date=2026-04-30 updatedAt=2026-06-27T01:43:55.628Z -->
- **Breaking:** Harden orchestration routing, delegation planning, browser navigation, and adapter package surfaces. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:8d39fa0e5e48565a43fc5d69010744604b1742ad:changelog:Changed:095492040d47 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=8d39fa0e5e48565a43fc5d69010744604b1742ad date=2026-04-30 updatedAt=2026-06-27T01:43:55.628Z -->
- Tighten architecture governance checks for layer 0 runtime profiles and Tier 1 public API allowlists. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:43396dde06ab426267070f31ab0b0a51e2a370ad:changelog:Added:1fe9864b13c9 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=43396dde06ab426267070f31ab0b0a51e2a370ad date=2026-04-30 updatedAt=2026-06-27T01:43:55.630Z -->
- Add leaf primitive layer rules and package public API allowlists. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:f31b2181b1327fad03b77f753eeae1857d661faa:changelog:Added:c0e84be35b80 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=f31b2181b1327fad03b77f753eeae1857d661faa date=2026-04-30 updatedAt=2026-06-27T01:43:55.630Z -->
- Define leaf-primitives architecture layer and public API allowlists. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

## 2026-04-29

### Changed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:ebb35940ab609fb6b171052c871825c87e00d483:changelog:Changed:7c9b35bf2a7b repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=ebb35940ab609fb6b171052c871825c87e00d483 date=2026-04-29 updatedAt=2026-06-27T01:43:55.632Z -->
- Grant operators memory access and emit provider run, approval timeout, and tool cancellation metrics. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:bf44077fa21920941424beba958871b863f16b74:changelog:Changed:16078ee207d0 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=bf44077fa21920941424beba958871b863f16b74 date=2026-04-29 updatedAt=2026-06-27T01:43:55.633Z -->
- Expand observability metrics and operator memory permissions. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:08233b7cbd6143b0a37cb945ec6fb997d9da88b9:changelog:Changed:facf2a6f7d5a repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=08233b7cbd6143b0a37cb945ec6fb997d9da88b9 date=2026-04-29 updatedAt=2026-06-27T01:43:55.634Z -->
- Omit undefined optional fields across agent runtime data and internal trace helpers. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:69ec69e47d5653d223c16772f9322f93c0c99471:changelog:Changed:7b228b421779 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=69ec69e47d5653d223c16772f9322f93c0c99471 date=2026-04-29 updatedAt=2026-06-27T01:43:55.635Z -->
- Omit undefined optional fields across agent runtime objects and remove internal playground Vue trace components. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:4b90146f055ec748580bbba0cdef6fca5171cbbf:changelog:Changed:f3833cde6f4d repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=4b90146f055ec748580bbba0cdef6fca5171cbbf date=2026-04-29 updatedAt=2026-06-27T01:43:55.636Z -->
- **Breaking:** Tighten adapter, orchestration, tool-governance, and Express support contracts. ([README.md](README.md), [packages/core/src/tools/ARCHITECTURE.md](packages/core/src/tools/ARCHITECTURE.md), [packages/core/src/facades/ARCHITECTURE.md](packages/core/src/facades/ARCHITECTURE.md), [packages/server/README.md](packages/server/README.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:00a4b84c1d1aff9ec0c8ddf65e38e66ee7fd8417:changelog:Changed:79e240c16479 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=00a4b84c1d1aff9ec0c8ddf65e38e66ee7fd8417 date=2026-04-29 updatedAt=2026-06-27T01:43:55.637Z -->
- **Breaking:** Tighten DzupAgent orchestration, tool-governance, adapter, and Express support contracts. ([README.md](README.md), [packages/core/src/tools/ARCHITECTURE.md](packages/core/src/tools/ARCHITECTURE.md), [packages/express/docs/ARCHITECTURE.md](packages/express/docs/ARCHITECTURE.md), [packages/server/README.md](packages/server/README.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:bbf906915e1c4e27377b3ed7d22013ea88efa46a:changelog:Changed:328a11bf4aad repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=bbf906915e1c4e27377b3ed7d22013ea88efa46a date=2026-04-29 updatedAt=2026-06-27T01:43:55.641Z -->
- Centralize connector tool normalization on the shared base contract. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:2b8d4e41c699bdab35288cd423f21844359ea49b:changelog:Changed:16f1a902fff7 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=2b8d4e41c699bdab35288cd423f21844359ea49b date=2026-04-29 updatedAt=2026-06-27T01:43:55.642Z -->
- **Breaking:** Fail closed when supervisor provider-adapter mode is missing a provider port. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:cd6f09e3daf85f981c35413f14fab031d3133a7c:changelog:Changed:4b551bdb7a66 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=cd6f09e3daf85f981c35413f14fab031d3133a7c date=2026-04-29 updatedAt=2026-06-27T01:43:55.643Z -->
- **Breaking:** Require a provider port for provider-adapter supervisor execution. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:changelog-group:Changed:dd8e3d2718d5 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=269566ac6de56b36e0f2cb2958989fd95478f7c8 date=2026-04-29 sourceCommits=269566ac6de56b36e0f2cb2958989fd95478f7c8,b13dba28875c5303daba0c24ecd5936be48dabc8 updatedAt=2026-06-27T01:43:55.644Z -->
- Bound standard memory prompt loading by the available token budget. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:8b34bc8d9d3ed150a2c081f253386bb6e6b14e20:changelog:Added:167528dd026a repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=8b34bc8d9d3ed150a2c081f253386bb6e6b14e20 date=2026-04-29 updatedAt=2026-06-27T01:43:55.645Z -->
- Add default choices to classify flow nodes. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:c846da11e957ae5f2c260cc9a140e96e70d85f8e:changelog:Added:4c99168b6183 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=c846da11e957ae5f2c260cc9a140e96e70d85f8e date=2026-04-29 updatedAt=2026-06-27T01:43:55.646Z -->
- Add default choices to flow classify nodes. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:62ab99f389ae25d816e92386e7600ca38341d110:changelog:Added:8b329306007e repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=62ab99f389ae25d816e92386e7600ca38341d110 date=2026-04-29 updatedAt=2026-06-27T01:43:55.647Z -->
- Add staged coverage baselines and large source file risk inventory. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:25b868c6baebeaa9ab6bdc6ee4e5deb1eba7b58c:changelog:Added:e33b014cb52e repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=25b868c6baebeaa9ab6bdc6ee4e5deb1eba7b58c date=2026-04-29 updatedAt=2026-06-27T01:43:55.648Z -->
- Add server route endpoint and route-family governance to the domain boundary check. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:1fff37a28aa4d7aa2bc640f961cf22a75420cd0a:changelog:Added:cb16320e39e7 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=1fff37a28aa4d7aa2bc640f961cf22a75420cd0a date=2026-04-29 updatedAt=2026-06-27T01:43:55.649Z -->
- Add route endpoint and route-family governance to domain boundary checks. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:5a0244637e8b208f5dd785c4dfba97cf165a55f5:changelog:Added:bcf96d99b8b3 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=5a0244637e8b208f5dd785c4dfba97cf165a55f5 date=2026-04-29 updatedAt=2026-06-27T01:43:55.650Z -->
- Add OpenAI as an HTTP-routable agent adapter provider. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:bb4930ca4d9e686cddddb0d9883fefc222853495:changelog:Added:9343803974d4 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=bb4930ca4d9e686cddddb0d9883fefc222853495 date=2026-04-29 updatedAt=2026-06-27T01:43:55.651Z -->
- Add OpenAI to HTTP-routable agent adapter providers. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:1d41fdfae18e59e8a33391c96acd7728307be0dd:changelog:Added:d1479c94dd6c repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=1d41fdfae18e59e8a33391c96acd7728307be0dd date=2026-04-29 updatedAt=2026-06-27T01:43:55.652Z -->
- Track run identifiers on agent prompt memory reads for provenance. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:b3dae51e11b3d814f37a931e435999dfca570e0d:changelog:Added:bdc7ced372d8 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=b3dae51e11b3d814f37a931e435999dfca570e0d date=2026-04-29 updatedAt=2026-06-27T01:43:55.653Z -->
- Add run-scoped provenance tracking for prompt memory reads. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:e8ba8b190d1570e2b7f39b7c518013d324d2ff14:changelog:Added:3af3f6252aed repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=e8ba8b190d1570e2b7f39b7c518013d324d2ff14 date=2026-04-29 updatedAt=2026-06-27T01:43:55.654Z -->
- Log successful tool result audit events without storing raw output. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:9ce72b840f7d0c78e2bc6a937608c36059c58b68:changelog:Added:6fcd88a9d20e repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=9ce72b840f7d0c78e2bc6a937608c36059c58b68 date=2026-04-29 updatedAt=2026-06-27T01:43:55.654Z -->
- Add run correlation and safe scope metadata to memory write-back events. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:72b337f4049049b034cd25be4f92846d021dd990:changelog:Added:ce4c49650e1d repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=72b337f4049049b034cd25be4f92846d021dd990 date=2026-04-29 updatedAt=2026-06-27T01:43:55.655Z -->
- Add run correlation and scope metadata to memory write-back events. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

### Fixed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:0bd9ff6d34c2ed415aeea16c59dfeff1490dd2af:changelog:Fixed:1ae0a3cdefee repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=0bd9ff6d34c2ed415aeea16c59dfeff1490dd2af date=2026-04-29 updatedAt=2026-06-27T01:43:55.657Z -->
- Fix Turbo test cache invalidation for test file changes. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:3e9d834a6bcf6b1db49ae75f3a37748d204a8fce:changelog:Fixed:b2bc581932e2 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=3e9d834a6bcf6b1db49ae75f3a37748d204a8fce date=2026-04-29 updatedAt=2026-06-27T01:43:55.657Z -->
- Fix connector tool normalization to preserve output formatting callbacks. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:d717b4345093c45378a812ff7bc9de258cdf40a0:changelog:Fixed:2f198ac93c70 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=d717b4345093c45378a812ff7bc9de258cdf40a0 date=2026-04-29 updatedAt=2026-06-27T01:43:55.658Z -->
- Record circuit-breaker outcomes for failed and rejected delegations. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:1d4dff795fec7ed4422ef16d30412e18a1089b85:changelog:Fixed:9e0e23503a86 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=1d4dff795fec7ed4422ef16d30412e18a1089b85 date=2026-04-29 updatedAt=2026-06-27T01:43:55.659Z -->
- Record circuit-breaker failures for unsuccessful and rejected delegations. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:4d7122fa98ad2843b1ac0e4a0bee5b1a13f19f65:changelog:Fixed:ecc882a6fa41 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=4d7122fa98ad2843b1ac0e4a0bee5b1a13f19f65 date=2026-04-29 updatedAt=2026-06-27T01:43:55.660Z -->
- Fix topology auto-switch recovery for thrown topology failures. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:f9a0189269822b86f7821b7cc2891cb9c31a8105:changelog:Fixed:e43423dc92f6 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=f9a0189269822b86f7821b7cc2891cb9c31a8105 date=2026-04-29 updatedAt=2026-06-27T01:43:55.661Z -->
- Fix topology auto-switch recovery from thrown topology failures. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:e625526424d56dfa2e9540785107c255e16ad4db:changelog:Fixed:dd79577a84ca repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=e625526424d56dfa2e9540785107c255e16ad4db date=2026-04-29 updatedAt=2026-06-27T01:43:55.663Z -->
- **Breaking:** Fix inaccurate TeamRuntime pattern labels for contract-net, council, single-participant, and breaker short-circuit results. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:dbac28a5421254fb681a8ef067a144c8feefb4ec:changelog:Fixed:08f7b15659ab repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=dbac28a5421254fb681a8ef067a144c8feefb4ec date=2026-04-29 updatedAt=2026-06-27T01:43:55.663Z -->
- Report accurate TeamRuntime result pattern labels for contract-net, council, single-participant, and circuit-breaker runs. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:5c5c0e1b89375adef58eba9869e52b63cb236a37:changelog:Fixed:72e25da1a9a9 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=5c5c0e1b89375adef58eba9869e52b63cb236a37 date=2026-04-29 updatedAt=2026-06-27T01:43:55.664Z -->
- Log successful tool result audit events without storing raw outputs. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:aa1da3c51d62a83ee8c50308aba9f0c1727dfc13:changelog:Fixed:adc8c3d65445 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=aa1da3c51d62a83ee8c50308aba9f0c1727dfc13 date=2026-04-29 updatedAt=2026-06-27T01:43:55.665Z -->
- **Breaking:** Reject oversized JSON request bodies across server routes. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:a0c8ebf45378fe1d910902095e683629351a71b8:changelog:Fixed:b9eab68187dc repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=a0c8ebf45378fe1d910902095e683629351a71b8 date=2026-04-29 updatedAt=2026-06-27T01:43:55.666Z -->
- **Breaking:** Fix unbounded JSON request handling by rejecting oversized server route payloads before parsing. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:9333fc464fb5de2363e5ce1ba8e94eae158e7712:changelog:Fixed:6352cf0b6b13 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=9333fc464fb5de2363e5ce1ba8e94eae158e7712 date=2026-04-29 updatedAt=2026-06-27T01:43:55.670Z -->
- **Breaking:** Reject unscoped WebSocket control subscriptions by default. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:d849a0ca88bac1af3c4964192bb4e2245df86196:changelog:Fixed:783690d1e2e9 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=d849a0ca88bac1af3c4964192bb4e2245df86196 date=2026-04-29 updatedAt=2026-06-27T01:43:55.670Z -->
- **Breaking:** Require scoped WebSocket control subscriptions by default to prevent wildcard event access. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:e8909c2c091ad14f98436f17f298f15cfde98a60:changelog:Fixed:1dfb077b2340 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=e8909c2c091ad14f98436f17f298f15cfde98a60 date=2026-04-29 updatedAt=2026-06-27T01:43:55.671Z -->
- **Breaking:** Require an explicit backend or fallback for sandbox-enabled codegen. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:1724ccf5c343f8dff106f6027ec1a60c82aa26b6:changelog:Fixed:e0a7d80bcc17 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=1724ccf5c343f8dff106f6027ec1a60c82aa26b6 date=2026-04-29 updatedAt=2026-06-27T01:43:55.672Z -->
- **Breaking:** Fail closed when sandbox-enabled codegen lacks a sandbox backend to prevent unintended local execution. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

## 2026-04-28

### Changed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:009ddb2d0eb81a19137b7bcea7511388925a5e37:changelog:Changed:17950e3058c9 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=009ddb2d0eb81a19137b7bcea7511388925a5e37 date=2026-04-28 updatedAt=2026-06-27T01:43:55.674Z -->
- Batch-load A2A task messages when listing persisted tasks. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:051726056391bda1d7b04d221234036a23d974ec:changelog:Changed:b0464d85d676 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=051726056391bda1d7b04d221234036a23d974ec date=2026-04-28 updatedAt=2026-06-27T01:43:55.675Z -->
- Batch-load A2A task messages when listing Drizzle-backed tasks. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:43a403fe146a9dd34c48e639e9c6eb708b144839:changelog:Changed:58cdf60ae482 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=43a403fe146a9dd34c48e639e9c6eb708b144839 date=2026-04-28 updatedAt=2026-06-27T01:43:55.676Z -->
- **Breaking:** Separate executable and diagnostic flow lowering so executable builds reject unresolved tool references. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:88a738dd7694c8bef311be00997b87d18ec49406:changelog:Changed:19661938f4ec repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=88a738dd7694c8bef311be00997b87d18ec49406 date=2026-04-28 updatedAt=2026-06-27T01:43:55.677Z -->
- **Breaking:** Separate executable and diagnostic flow lowering so unresolved actions throw by default and diagnostic mode emits stubs. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:5eb6a118f3e0114d58c7a7d4330e32081cb29825:changelog:Changed:37251e6c72c6 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=5eb6a118f3e0114d58c7a7d4330e32081cb29825 date=2026-04-28 updatedAt=2026-06-27T01:43:55.678Z -->
- Enforce package-pair boundary rules in domain boundary checks. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:a67d41510928f7a78ab302e91a3c3e37d5960ecc:changelog:Changed:33a25efb7e51 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=a67d41510928f7a78ab302e91a3c3e37d5960ecc date=2026-04-28 updatedAt=2026-06-27T01:43:55.679Z -->
- Move shared team workspace contracts into orchestration and keep playground aliases compatible. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:6a24ac255e931a6ac17bde0665d4f36c473717a7:changelog:Changed:88f8a08d307b repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=6a24ac255e931a6ac17bde0665d4f36c473717a7 date=2026-04-28 updatedAt=2026-06-27T01:43:55.679Z -->
- Move team runtime workspace contracts from playground into orchestration. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:f6c51b94f99e458861050f95d6a9e405c54ba349:changelog:Changed:0e3ac3ddce0b repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=f6c51b94f99e458861050f95d6a9e405c54ba349 date=2026-04-28 updatedAt=2026-06-27T01:43:55.680Z -->
- **Breaking:** Require explicit opt-in before mounting OpenAI-compatible `/v1/*` routes. ([packages/server/docs/ARCHITECTURE.md](packages/server/docs/ARCHITECTURE.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:2ee4db0044c5c125f61258b4db79d39fa46e56ca:changelog:Changed:6899324aee1f repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=2ee4db0044c5c125f61258b4db79d39fa46e56ca date=2026-04-28 updatedAt=2026-06-27T01:43:55.681Z -->
- **Breaking:** Require explicit `openai.enabled` opt-in before mounting OpenAI-compatible `/v1` routes. ([packages/server/docs/ARCHITECTURE.md](packages/server/docs/ARCHITECTURE.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:86d3cedd18cf5aedf9c1047461766b035449ba97:changelog:Changed:034a56a242cc repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=86d3cedd18cf5aedf9c1047461766b035449ba97 date=2026-04-28 updatedAt=2026-06-27T01:43:55.682Z -->
- **Breaking:** Enforce TeamRuntime execution policy limits and reject unsupported timeout or retry fields. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:4e225446b72b05ecc1a4d5f4b66be2946907f9f3:changelog:Changed:1a49a13a9540 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=4e225446b72b05ecc1a4d5f4b66be2946907f9f3 date=2026-04-28 updatedAt=2026-06-27T01:43:55.683Z -->
- **Breaking:** Enforce TeamRuntime execution policy concurrency limits and reject unsupported timeout and retry settings. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:6328fb4bd149a0ee29c095b6b6ed63941ed16750:changelog:Changed:06d921342129 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=6328fb4bd149a0ee29c095b6b6ed63941ed16750 date=2026-04-28 updatedAt=2026-06-27T01:43:55.683Z -->
- Clarify that playground Vue UI internals are not a public package surface. ([packages/agent/docs/api-tiers.md](packages/agent/docs/api-tiers.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:59956a22334d608666ec891a857a8c5a13378314:changelog:Changed:0c16b8ca5f7f repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=59956a22334d608666ec891a857a8c5a13378314 date=2026-04-28 updatedAt=2026-06-27T01:43:55.684Z -->
- Mark playground Vue UI as framework-internal and block package subpath exports. ([packages/agent/docs/api-tiers.md](packages/agent/docs/api-tiers.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:ee228ad2c27a198327b5d116a7f2bfdaae155b88:changelog:Changed:cc120567f7ad repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=ee228ad2c27a198327b5d116a7f2bfdaae155b88 date=2026-04-28 updatedAt=2026-06-27T01:43:55.685Z -->
- **Breaking:** Route HTTP connector resolution through server-owned profiles. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:58f66822823ec12c613294e81661e93b1f1468f2:changelog:Changed:fc01c377b59f repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=58f66822823ec12c613294e81661e93b1f1468f2 date=2026-04-28 updatedAt=2026-06-27T01:43:55.686Z -->
- **Breaking:** Add server-managed HTTP connector profiles and require opt-in for metadata-controlled HTTP connector configuration. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:624840562fa278eb4f931c79c5ff88827a869ba3:changelog:Changed:fc1fcb35ae51 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=624840562fa278eb4f931c79c5ff88827a869ba3 date=2026-04-28 updatedAt=2026-06-27T01:43:55.688Z -->
- Document profile-based HTTP and Git tool safety controls. ([packages/server/README.md](packages/server/README.md), [packages/codegen/src/tools/ARCHITECTURE.md](packages/codegen/src/tools/ARCHITECTURE.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:68c2ad81ecfb2b8b875e6cfa1778cff805524598:changelog:Changed:e2e8aec13371 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=68c2ad81ecfb2b8b875e6cfa1778cff805524598 date=2026-04-28 updatedAt=2026-06-27T01:43:55.689Z -->
- **Breaking:** Require server-owned workspace profiles and explicit policy approval for Git tooling. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:665bec403acb294b163bd4d03d60399ebcd2b0db:changelog:Changed:4c59bad33f36 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=665bec403acb294b163bd4d03d60399ebcd2b0db date=2026-04-28 updatedAt=2026-06-27T01:43:55.689Z -->
- Harden agent tool execution and server route governance while pruning stale planning documents. ([packages/agent/README.md](packages/agent/README.md), [packages/server/README.md](packages/server/README.md), [packages/server/docs/ARCHITECTURE.md](packages/server/docs/ARCHITECTURE.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:cedd7021f4747317060487d24719af68c5e00c9c:changelog:Changed:945b0c3bc2cc repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=cedd7021f4747317060487d24719af68c5e00c9c date=2026-04-28 updatedAt=2026-06-27T01:43:55.690Z -->
- Constrain server route expansion behind plugin boundaries and tighten agent runtime guardrails. ([packages/agent/README.md](packages/agent/README.md), [packages/server/README.md](packages/server/README.md), [packages/server/docs/ARCHITECTURE.md](packages/server/docs/ARCHITECTURE.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:85cb70b8184466fecabe8393160074d83894fb27:changelog:Added:28d2d559828b repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=85cb70b8184466fecabe8393160074d83894fb27 date=2026-04-28 updatedAt=2026-06-27T01:43:55.692Z -->
- Add source import manifest dependency checks. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:250a2a9ec6f1b837e8b571e0c781adb6548e64c5:changelog:Added:640c15f4c318 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=250a2a9ec6f1b837e8b571e0c781adb6548e64c5 date=2026-04-28 updatedAt=2026-06-27T01:43:55.693Z -->
- Enforce declared package-pair boundary rules in domain boundary checks. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:changelog-group:Added:ad07a2a7b568 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=79d463021548ec6f89a22a172b44a21b385a8130 date=2026-04-28 sourceCommits=79d463021548ec6f89a22a172b44a21b385a8130,2120493a37d65d9bc683826698d27185d4fd8819 updatedAt=2026-06-27T01:43:55.696Z -->
- Add adapter workflow ownership metadata for the flow compiler boundary. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:a7664a793d6b33d40ffaadc5f0a2f8ee4853dc57:changelog:Added:2b3f14defc83 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=a7664a793d6b33d40ffaadc5f0a2f8ee4853dc57 date=2026-04-28 updatedAt=2026-06-27T01:43:55.697Z -->
- Add configurable fail-closed handling for tool result safety scanner failures. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:99da8607171b853f74d5fe9f2e2612212c965f16:changelog:Added:30b9671c90b3 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=99da8607171b853f74d5fe9f2e2612212c965f16 date=2026-04-28 updatedAt=2026-06-27T01:43:55.698Z -->
- Add configurable tool result scanner failure handling. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:6b29c1b0d1029d8118d6200866847df2a2c06bcf:changelog:Added:c771d800ddf9 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=6b29c1b0d1029d8118d6200866847df2a2c06bcf date=2026-04-28 updatedAt=2026-06-27T01:43:55.699Z -->
- Add sanitized memory write-back success and failure events. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:3f394a674eb094c98b4ad1e3090669d78384f209:changelog:Added:c67f731bb2df repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=3f394a674eb094c98b4ad1e3090669d78384f209 date=2026-04-28 updatedAt=2026-06-27T01:43:55.700Z -->
- Emit sanitized memory write-back success and failure events. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:30900be94e61d253e74498004d1293739e13e516:changelog:Added:bde5d3de3b78 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=30900be94e61d253e74498004d1293739e13e516 date=2026-04-28 updatedAt=2026-06-27T01:43:55.701Z -->
- Document profile-based HTTP connector and Git workspace safety controls. ([packages/server/README.md](packages/server/README.md), [packages/codegen/src/tools/ARCHITECTURE.md](packages/codegen/src/tools/ARCHITECTURE.md), [packages/codegen/docs/ARCHITECTURE.md](packages/codegen/docs/ARCHITECTURE.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:df722b488725f10b92ca8e7bbdbc6bc617928dad:changelog:Added:c07410c216f0 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=df722b488725f10b92ca8e7bbdbc6bc617928dad date=2026-04-28 updatedAt=2026-06-27T01:43:55.702Z -->
- Add public API allowlists for core, agent, and codegen packages. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:b713a464a13b106dfd56e4c02d9b394c0428eac9:changelog:Added:e0eb4ced6b35 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=b713a464a13b106dfd56e4c02d9b394c0428eac9 date=2026-04-28 updatedAt=2026-06-27T01:43:55.703Z -->
- Add public API allowlists for core, agent, and codegen. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:42f128e6f7df6b45ddea01824dd5ddb95c300ad8:changelog:Added:40448d244882 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=42f128e6f7df6b45ddea01824dd5ddb95c300ad8 date=2026-04-28 updatedAt=2026-06-27T01:43:55.704Z -->
- Add public and server API surface index documentation. ([docs/PUBLIC_API_SURFACE_ALLOWLISTS.md](docs/PUBLIC_API_SURFACE_ALLOWLISTS.md), [docs/SERVER_API_SURFACE_INDEX.md](docs/SERVER_API_SURFACE_INDEX.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:9055563bd6c8bab0773e2f287dc0220086ed657f:changelog:Added:1cf95cfe4050 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=9055563bd6c8bab0773e2f287dc0220086ed657f date=2026-04-28 updatedAt=2026-06-27T01:43:55.706Z -->
- Add runtime facades, policy-governed tool execution, and outbound URL security helpers. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:b70a2c9cc83e872993b69bf89770f28abd24cd9f:changelog:Added:be862bba35d9 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=b70a2c9cc83e872993b69bf89770f28abd24cd9f date=2026-04-28 updatedAt=2026-06-27T01:43:55.707Z -->
- Add package runtime facades, fail-closed tool governance, and outbound URL policy helpers. (ninel.hodzic)
<!-- /workspace-changelog:entry -->

### Fixed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:beaa6c2147c0a17651b6667520ce5ab00c65ba67:changelog:Fixed:b48c4c0ba4a1 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=beaa6c2147c0a17651b6667520ce5ab00c65ba67 date=2026-04-28 updatedAt=2026-06-27T01:43:55.708Z -->
- Fix API key validation and owner-scoped deletion and rotation to prevent cross-owner key changes. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:4bc19a5e22edb91f621e2549c61160c064ef131d:changelog:Fixed:dec755f5c765 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=4bc19a5e22edb91f621e2549c61160c064ef131d date=2026-04-28 updatedAt=2026-06-27T01:43:55.709Z -->
- Fix API key validation, owner-scoped key mutations, and case-insensitive OpenAI-compatible bearer auth. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:ba90d9bded6834f8243d628057d62218dc2ce983:changelog:Fixed:d5da3e6c0be9 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=ba90d9bded6834f8243d628057d62218dc2ce983 date=2026-04-28 updatedAt=2026-06-27T01:43:55.710Z -->
- Fix tool timeout classification so timeout-looking tool errors stay regular errors. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:af2fed3b6ac6c1454da1b3c4c5701434df709250:changelog:Fixed:289741c46392 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=af2fed3b6ac6c1454da1b3c4c5701434df709250 date=2026-04-28 updatedAt=2026-06-27T01:43:55.710Z -->
- Fix tool timeout classification by using typed timeout errors. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:f97a4376eac5a047392ecd4cfb177b1d5f909973:changelog:Fixed:fdaf8e3593e1 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=f97a4376eac5a047392ecd4cfb177b1d5f909973 date=2026-04-28 updatedAt=2026-06-27T01:43:55.711Z -->
- Fix decoding of persisted memory-sharing spaces and pending requests. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:ba54e85edd27af49a5ede81556d586f7b33821a1:changelog:Fixed:6162bc396f4b repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=ba54e85edd27af49a5ede81556d586f7b33821a1 date=2026-04-28 updatedAt=2026-06-27T01:43:55.712Z -->
- Fix persisted memory sharing record decoding to ignore malformed spaces and requests. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:9a6831cebad124cd732e5adf0d5e1db20f709d38:changelog:Fixed:0cc4e7596f47 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=9a6831cebad124cd732e5adf0d5e1db20f709d38 date=2026-04-28 updatedAt=2026-06-27T01:43:55.713Z -->
- Enforce authenticated tenant and owner scope for memory analytics endpoints. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:03e7b0799e3d86b17f4d3e21eac607db74c78bb3:changelog:Fixed:3b51e810a7c1 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=03e7b0799e3d86b17f4d3e21eac607db74c78bb3 date=2026-04-28 updatedAt=2026-06-27T01:43:55.714Z -->
- Fix memory analytics scope enforcement to use authenticated tenant and owner values. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:9ca37b368f33221d20e676ac186664705f9fa17f:changelog:Fixed:8d80597c4c32 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=9ca37b368f33221d20e676ac186664705f9fa17f date=2026-04-28 updatedAt=2026-06-27T01:43:55.715Z -->
- **Breaking:** Reject private, loopback, and link-local MCP HTTP/SSE endpoints unless explicitly allowlisted. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:7feddb1445c74191cfc0731a184cc0e6a235fc23:changelog:Fixed:6d982d80004e repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=7feddb1445c74191cfc0731a184cc0e6a235fc23 date=2026-04-28 updatedAt=2026-06-27T01:43:55.716Z -->
- **Breaking:** Reject private MCP HTTP and SSE endpoints unless hosts are explicitly allowlisted. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:0fab5fd33cf01f49255f95cbde79d24115a2a82c:changelog:Fixed:ceb95f347e02 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=0fab5fd33cf01f49255f95cbde79d24115a2a82c date=2026-04-28 updatedAt=2026-06-27T01:43:55.717Z -->
- **Breaking:** Fix unsafe default WebSocket upgrades by requiring explicit guards for production helpers. ([packages/server/README.md](packages/server/README.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:5d5d0650dcb0eaa3e29d2bf27af1eb681ba356aa:changelog:Fixed:f8fbdcfd6cc1 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=5d5d0650dcb0eaa3e29d2bf27af1eb681ba356aa date=2026-04-28 updatedAt=2026-06-27T01:43:55.718Z -->
- **Breaking:** Reject unauthenticated WebSocket upgrades by default unless callers configure an explicit guard or unsafe development opt-in. ([packages/server/README.md](packages/server/README.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:cc771913198b5479b37e013e0cbab79d3f3120b5:changelog:Fixed:8994c847981d repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=cc771913198b5479b37e013e0cbab79d3f3120b5 date=2026-04-28 updatedAt=2026-06-27T01:43:55.718Z -->
- Harden server and playground responses with default security headers. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:55308ef53425ff642296ba227184151215681463:changelog:Fixed:64364cfd0772 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=55308ef53425ff642296ba227184151215681463 date=2026-04-28 updatedAt=2026-06-27T01:43:55.719Z -->
- Add default security headers to server and playground responses to reduce clickjacking and content-sniffing exposure. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:9114c1aa15cfb11f7230b20b10c096fbbc276b22:changelog:Fixed:3b79140c23da repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=9114c1aa15cfb11f7230b20b10c096fbbc276b22 date=2026-04-28 updatedAt=2026-06-27T01:43:55.722Z -->
- Fix missing internal package dependency declarations for dzupagent packages. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:9ba360bdc48ecd7d8fb92b42f00f7b1931b6cb89:changelog:Fixed:fdb5f0b6e2d7 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=9ba360bdc48ecd7d8fb92b42f00f7b1931b6cb89 date=2026-04-28 updatedAt=2026-06-27T01:43:55.724Z -->
- **Breaking:** Redact raw tool input values from tool audit events. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:6b31b24d2c7fce0f8f97ce52fb33122bb454df59:changelog:Fixed:c2abd8857c19 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=6b31b24d2c7fce0f8f97ce52fb33122bb454df59 date=2026-04-28 updatedAt=2026-06-27T01:43:55.725Z -->
- Redact raw tool input values from audit events and stored compliance details. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:6002bc0d189f4e4c00a12e4271c9e6e4b0a137f8:changelog:Fixed:b9018a955c66 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=6002bc0d189f4e4c00a12e4271c9e6e4b0a137f8 date=2026-04-28 updatedAt=2026-06-27T01:43:55.726Z -->
- Fix streaming tool calls to halt approval-required tools and emit approval requests. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:24e41132d4791a1c63900149518356d0501c7bcc:changelog:Fixed:2158c6739828 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=24e41132d4791a1c63900149518356d0501c7bcc date=2026-04-28 updatedAt=2026-06-27T01:43:55.728Z -->
- Require human approval before executing governed tools in native streaming. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:d82ce79a4c958077d7b3ae1170648bd9f5301508:changelog:Fixed:ffc9f5415812 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=d82ce79a4c958077d7b3ae1170648bd9f5301508 date=2026-04-28 updatedAt=2026-06-27T01:43:55.729Z -->
- Fix native streaming completion to apply guardrail output filters before done events and memory write-back. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:54d6f2a75166020147ffdfc50b5ab401b023296b:changelog:Fixed:8580b88bd1d8 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=54d6f2a75166020147ffdfc50b5ab401b023296b date=2026-04-28 updatedAt=2026-06-27T01:43:55.730Z -->
- Fix native streaming runs to apply output filters before final output and memory write-back. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:b40b8a5b0e3a87f0659f7ad7a7dca5dfe33d2f14:changelog:Fixed:c99bcf010d88 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=b40b8a5b0e3a87f0659f7ad7a7dca5dfe33d2f14 date=2026-04-28 updatedAt=2026-06-27T01:43:55.732Z -->
- Apply token compression and exhaustion halts during native streaming. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:375be2ef695e86fc8914f7c59935f80253f7e549:changelog:Fixed:68385186be06 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=375be2ef695e86fc8914f7c59935f80253f7e549 date=2026-04-28 updatedAt=2026-06-27T01:43:55.733Z -->
- Fix native streaming token lifecycle parity for compression and token exhaustion halts. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:584b5c4f278f3be6dec2750a9da6882225914b67:changelog:Fixed:01bef93121d0 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=584b5c4f278f3be6dec2750a9da6882225914b67 date=2026-04-28 updatedAt=2026-06-27T01:43:55.734Z -->
- Bound Arrow memory fallback context to the configured memory budget. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:38ee0bee82d0add5c8c1641c1906b6f9954fd378:changelog:Fixed:57b50b0307d4 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=38ee0bee82d0add5c8c1641c1906b6f9954fd378 date=2026-04-28 updatedAt=2026-06-27T01:43:55.735Z -->
- Fix Arrow memory fallback to respect the configured memory budget. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:e854fa26e0a9ded30ab0a985a48d0cf52536c0a0:changelog:Fixed:851c9ae43e34 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=e854fa26e0a9ded30ab0a985a48d0cf52536c0a0 date=2026-04-28 updatedAt=2026-06-27T01:43:55.737Z -->
- Fix orchestration circuit breaker attribution for generic failures and unused specialists. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:e4c1fdbc03aba6d524d38011492ba009857f4b13:changelog:Fixed:bc50f8099ca7 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=e4c1fdbc03aba6d524d38011492ba009857f4b13 date=2026-04-28 updatedAt=2026-06-27T01:43:55.738Z -->
- Fix orchestration circuit-breaker attribution for invoked specialists and non-timeout failures. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:8fb08e3ad59d8925ab6622d438e44896ad835a65:changelog:Fixed:1a1a92d9e0a8 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=8fb08e3ad59d8925ab6622d438e44896ad835a65 date=2026-04-28 updatedAt=2026-06-27T01:43:55.739Z -->
- Fix trace row accessibility with native button controls. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:cc40c50af2e7f8f23e0d2ff4b4e1b6323c843337:changelog:Fixed:30c04624d71d repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=cc40c50af2e7f8f23e0d2ff4b4e1b6323c843337 date=2026-04-28 updatedAt=2026-06-27T01:43:55.741Z -->
- Use native buttons for interactive trace inspector and timeline rows. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:250a58483141787652271e86fd962661e7c1aa18:changelog:Fixed:3052b6ceba62 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=250a58483141787652271e86fd962661e7c1aa18 date=2026-04-28 updatedAt=2026-06-27T01:43:55.742Z -->
- **Breaking:** Fix global RBAC to deny unknown management API route groups by default. ([packages/server/README.md](packages/server/README.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:b105aeac778f6e7341c320295dc60c71a1669f30:changelog:Fixed:93f161eda8ab repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=b105aeac778f6e7341c320295dc60c71a1669f30 date=2026-04-28 updatedAt=2026-06-27T01:43:55.743Z -->
- **Breaking:** Fix global RBAC to deny unknown management API routes by default. ([packages/server/README.md](packages/server/README.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:a6e11e9433d961a85da1ef7cd1ceef4089c5cfe5:changelog:Fixed:f35f9bc021b3 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=a6e11e9433d961a85da1ef7cd1ceef4089c5cfe5 date=2026-04-28 updatedAt=2026-06-27T01:43:55.745Z -->
- **Breaking:** Fix unsafe workspace and Git tool access by enforcing root containment and profile-controlled mutations. ([README.md](README.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->

## 2026-04-27

### Changed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:2efdc231f675d3d639fc990e834fda6b27ec731e:changelog:Changed:1f101fa97070 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=2efdc231f675d3d639fc990e834fda6b27ec731e date=2026-04-27 updatedAt=2026-06-27T01:43:55.748Z -->
- **Breaking:** Harden tool execution governance across generated, streamed, and parallel runs while retiring the playground package. ([README.md](README.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:5e4cc4919431a6887588291b43e85d14b97d38aa:changelog:Added:26966021c561 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=5e4cc4919431a6887588291b43e85d14b97d38aa date=2026-04-27 updatedAt=2026-06-27T01:43:55.750Z -->
- Add checkpoint and restore flow validation, lowering, and telemetry. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:5d2ac198dd5a759b979aeca53c5a8672e1260920:changelog:Added:df190510c696 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=5d2ac198dd5a759b979aeca53c5a8672e1260920 date=2026-04-27 updatedAt=2026-06-27T01:43:55.751Z -->
- Add checkpoint and restore validation, lowering, and telemetry events for flow packages. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:97c3b05a033a18f5b32c2a4144e5f7c674e35489:changelog:Added:b25eaf022551 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=97c3b05a033a18f5b32c2a4144e5f7c674e35489 date=2026-04-27 updatedAt=2026-06-27T01:43:55.752Z -->
- Add checkpoint restore flow nodes, stuck-loop recovery hooks, and checkpoint metrics. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:815e054a5995c707ebb04dc5608953087e2a818e:changelog:Added:0faa2a82742d repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=815e054a5995c707ebb04dc5608953087e2a818e date=2026-04-27 updatedAt=2026-06-27T01:43:55.754Z -->
- Add checkpoint restore flow support and metrics. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

### Removed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:891b070502b6ef7ee5ef5e8ae3b1681d9ce404fd:changelog:Removed:e60db35276c0 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=891b070502b6ef7ee5ef5e8ae3b1681d9ce404fd date=2026-04-27 updatedAt=2026-06-27T01:43:55.758Z -->
- **Breaking:** Remove the playground package and enforce configured tool governance across agent generate, stream, and parallel tool execution paths. ([README.md](README.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->

## 2026-04-26

### Changed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:9cc01b7ea4a519b1aedbc5ff3d5e66effdf79160:changelog:Changed:fe290ceb2b0c repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=9cc01b7ea4a519b1aedbc5ff3d5e66effdf79160 date=2026-04-26 updatedAt=2026-06-27T01:43:55.761Z -->
- Clarify DzupAgent product boundaries and add planning baselines for research and self-learning workflows. ([AGENTS.md](AGENTS.md), [CLAUDE.md](CLAUDE.md), [docs/DZUPAGENT_RESEARCH_PLANNING_PIPELINE_2026-04-25.md](docs/DZUPAGENT_RESEARCH_PLANNING_PIPELINE_2026-04-25.md), [docs/self-learning/AUTONOMOUS_WORKFLOW_LEARNING_PLAN_2026-04-25.md](docs/self-learning/AUTONOMOUS_WORKFLOW_LEARNING_PLAN_2026-04-25.md), [packages/agent-adapters/docs/NAMING_CLEANUP_STATUS.md](packages/agent-adapters/docs/NAMING_CLEANUP_STATUS.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:1758f2c15707487c0d515bbac8848e55004715b5:changelog:Changed:89f7b9135e34 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=1758f2c15707487c0d515bbac8848e55004715b5 date=2026-04-26 updatedAt=2026-06-27T01:43:55.762Z -->
- **Breaking:** Add team supervision circuit breakers, stage compile streaming, atomic multi-edit tooling, and registry fleet health APIs. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:3561a28a3bf8f4c576a4c9681531572137aa01c7:changelog:Changed:a749387c1bd9 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=3561a28a3bf8f4c576a4c9681531572137aa01c7 date=2026-04-26 updatedAt=2026-06-27T01:43:55.763Z -->
- **Breaking:** Add team circuit breakers, atomic multi-edit, registry fleet health, and stage-stream compile APIs while removing deprecated package aliases. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:97d42684ba18ee0bd7ce9d4ca81be37637dbeabb:changelog:Changed:7c37ddfffa3d repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=97d42684ba18ee0bd7ce9d4ca81be37637dbeabb date=2026-04-26 updatedAt=2026-06-27T01:43:55.764Z -->
- Define package layer graph and update package and server API tier metadata. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:31d2997bd56835047b0b4df1525161218e5022c6:changelog:Changed:c349832bdb51 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=31d2997bd56835047b0b4df1525161218e5022c6 date=2026-04-26 updatedAt=2026-06-27T01:43:55.766Z -->
- Define package layers and update tier metadata for contract, tooling, and server API surfaces. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:6e44cea18e476ea1ad1dd9cf0b55204581465027:changelog:Changed:ab2cb7b97153 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=6e44cea18e476ea1ad1dd9cf0b55204581465027 date=2026-04-26 updatedAt=2026-06-27T01:43:55.767Z -->
- **Breaking:** Change tool approvals to hard-gate execution while adding OpenAI provider support and modular server composition. ([README.md](README.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:3b37a0b9dbcc5ef854a9727fa82758c601fa9892:changelog:Changed:f7e1232a61a4 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=3b37a0b9dbcc5ef854a9727fa82758c601fa9892 date=2026-04-26 updatedAt=2026-06-27T01:43:55.767Z -->
- Strengthen architecture boundary validation for workspace package classification, layer direction, tooling dependencies, and runtime cycles. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:b1d3a2ff0a1bd160c4e2383f09fc95625bfe8935:changelog:Changed:4dc694bd7d6a repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=b1d3a2ff0a1bd160c4e2383f09fc95625bfe8935 date=2026-04-26 updatedAt=2026-06-27T01:43:55.769Z -->
- Expand architecture boundary checks to enforce package classifications, layer ordering, tooling dependency rules, and runtime dependency cycles. (ninel.hodzic)
<!-- /workspace-changelog:entry -->

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:4f9536c47aed91cbc76a5e7214b2cd96ad2fd274:changelog:Added:583b477cd27e repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=4f9536c47aed91cbc76a5e7214b2cd96ad2fd274 date=2026-04-26 updatedAt=2026-06-27T01:43:55.770Z -->
- Add API tier governance documentation and refresh audit findings. ([docs/API_TIER_GOVERNANCE.md](docs/API_TIER_GOVERNANCE.md), [packages/agent/docs/api-tiers.md](packages/agent/docs/api-tiers.md), [packages/agent-adapters/docs/api-tiers.md](packages/agent-adapters/docs/api-tiers.md), [packages/codegen/docs/api-tiers.md](packages/codegen/docs/api-tiers.md), [docs/DEPENDENCY_ADVISORY_AUDIT.md](docs/DEPENDENCY_ADVISORY_AUDIT.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:1f4127ee747f952eede01f0af6861e66cfd8fbb6:changelog:Added:0417b35e07dc repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=1f4127ee747f952eede01f0af6861e66cfd8fbb6 date=2026-04-26 updatedAt=2026-06-27T01:43:55.771Z -->
- Add API tier governance docs and refresh audit findings. ([docs/API_TIER_GOVERNANCE.md](docs/API_TIER_GOVERNANCE.md), [packages/agent/docs/api-tiers.md](packages/agent/docs/api-tiers.md), [packages/agent-adapters/docs/api-tiers.md](packages/agent-adapters/docs/api-tiers.md), [packages/codegen/docs/api-tiers.md](packages/codegen/docs/api-tiers.md), [docs/DEPENDENCY_ADVISORY_AUDIT.md](docs/DEPENDENCY_ADVISORY_AUDIT.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:4894994a81b0c3b369599d16630e26221a0f704f:changelog:Added:5bcf00128f79 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=4894994a81b0c3b369599d16630e26221a0f704f date=2026-04-26 updatedAt=2026-06-27T01:43:55.772Z -->
- **Breaking:** Add OpenAI adapter support, modular server composition, and approval-aware agent telemetry. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

## 2026-04-24

### Changed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:a70fce5a93b5e3a0a0934d2bafc543f2cea8c018:changelog:Changed:52dc94ae1caa repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=a70fce5a93b5e3a0a0934d2bafc543f2cea8c018 date=2026-04-24 updatedAt=2026-06-27T01:43:55.775Z -->
- **Breaking:** Add tenant-scoped run isolation and permission-checked tool execution while moving memory and context APIs out of core. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:cdc4543fb6b49cbcafc414ded4558bfb577f2388:changelog:Changed:b0858824767c repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=cdc4543fb6b49cbcafc414ded4558bfb577f2388 date=2026-04-24 updatedAt=2026-06-27T01:43:55.776Z -->
- **Breaking:** Add tenant-scoped run isolation, permission-checked tool invocation, approvals, quotas, and persistent checkpoint storage. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:8556921a6a6b2773dd72bc7ee91a302dac0bd455:changelog:Changed:a87f77a64e71 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=8556921a6a6b2773dd72bc7ee91a302dac0bd455 date=2026-04-24 updatedAt=2026-06-27T01:43:55.777Z -->
- **Breaking:** Harden server eval execution and switch run admission to per-key token quota accounting. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:804d735c6e8c2fb0aba53c37f62a19bd11d2d802:changelog:Changed:242cdc24f1a7 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=804d735c6e8c2fb0aba53c37f62a19bd11d2d802 date=2026-04-24 updatedAt=2026-06-27T01:43:55.778Z -->
- **Breaking:** Require explicit eval execution/read-only configuration and move server quotas to per-key resource quota enforcement. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:e1357bb220d315a89653449924ce4f04f88f06cf:changelog:Added:20f9fd257440 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=e1357bb220d315a89653449924ce4f04f88f06cf date=2026-04-24 updatedAt=2026-06-27T01:43:55.779Z -->
- Add DzupAgent baseline, security, architecture, code, design, and agent audit reports. ([docs/AGENT-AUDIT.md](docs/AGENT-AUDIT.md), [docs/ARCHITECTURE-AUDIT.md](docs/ARCHITECTURE-AUDIT.md), [docs/BASELINE.md](docs/BASELINE.md), [docs/CODE-AUDIT.md](docs/CODE-AUDIT.md), [docs/DESIGN-AUDIT.md](docs/DESIGN-AUDIT.md), [docs/SECURITY-AUDIT.md](docs/SECURITY-AUDIT.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:225055e8d175f3b201c263ec2e01c325d9fb6b39:changelog:Added:c01a83bbb6c2 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=225055e8d175f3b201c263ec2e01c325d9fb6b39 date=2026-04-24 updatedAt=2026-06-27T01:43:55.780Z -->
- Add automatic pipeline checkpoint store selection from Redis and Postgres clients. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:417728199955698a174eb8f59e16c89c4edd78da:changelog:Added:c657faba1160 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=417728199955698a174eb8f59e16c89c4edd78da date=2026-04-24 updatedAt=2026-06-27T01:43:55.782Z -->
- Add automatic pipeline checkpoint store selection from Redis or Postgres clients. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

## 2026-04-23

### Changed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:20c4ae93a7dfa8ca4429ff771f884bdf74015f78:changelog:Changed:287f69fd895d repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=20c4ae93a7dfa8ca4429ff771f884bdf74015f78 date=2026-04-23 updatedAt=2026-06-27T01:43:55.785Z -->
- Classify control-plane helpers as secondary server API candidates. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:fc34ccfe6a7ffc3877e5d1a6d0a53c8d09e4cbe4:changelog:Changed:c365c7291de4 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=fc34ccfe6a7ffc3877e5d1a6d0a53c8d09e4cbe4 date=2026-04-23 updatedAt=2026-06-27T01:43:55.786Z -->
- Align agent runtime and adapter APIs around provider registry contracts and shared agent type primitives. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:219b08ee027e71db884b0908d4d96989f057d2a4:changelog:Changed:56e04f2f0cba repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=219b08ee027e71db884b0908d4d96989f057d2a4 date=2026-04-23 updatedAt=2026-06-27T01:43:55.789Z -->
- Align agent runtime, adapter registry, and server run handling with provider registry contracts. (ninel.hodzic)
<!-- /workspace-changelog:entry -->

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:350021c475e7ffde39ccff6ccb3f4eccb9ac5e40:changelog:Added:2f344935ec70 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=350021c475e7ffde39ccff6ccb3f4eccb9ac5e40 date=2026-04-23 updatedAt=2026-06-27T01:43:55.791Z -->
- Add stabilization, MCP, control-plane, and supported-kernel documentation. ([docs/ADR-001-qdrant-isolation-strategy.md](docs/ADR-001-qdrant-isolation-strategy.md), [docs/ADR-002-agent-registry-primary-control-plane.md](docs/ADR-002-agent-registry-primary-control-plane.md), [docs/AGENT_CONTROL_PLANE_ROADMAP_2026-04-23.md](docs/AGENT_CONTROL_PLANE_ROADMAP_2026-04-23.md), [docs/MCP_REBASELINE_2026-04-23.md](docs/MCP_REBASELINE_2026-04-23.md), [docs/STABILIZATION_REBASELINE_2026-04-23.md](docs/STABILIZATION_REBASELINE_2026-04-23.md), [docs/SUPPORTED_KERNEL.md](docs/SUPPORTED_KERNEL.md), [docs/PACKAGE_SUPPORT_INDEX.md](docs/PACKAGE_SUPPORT_INDEX.md), [docs/stabilization/README.md](docs/stabilization/README.md), [.github/pull_request_template.md](.github/pull_request_template.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:a810ef69992a4020d7b0206777b60451742cfb25:changelog:Added:5fee0ee99b0b repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=a810ef69992a4020d7b0206777b60451742cfb25 date=2026-04-23 updatedAt=2026-06-27T01:43:55.792Z -->
- Add package tier and ownership configuration. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:83dd856804241fce71a905c545afc1505b0d915d:changelog:Added:e88d68911b49 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=83dd856804241fce71a905c545afc1505b0d915d date=2026-04-23 updatedAt=2026-06-27T01:43:55.793Z -->
- **Breaking:** Add unified raw event streaming, workflow DSL/runtime support, structured output handling, and expanded server APIs. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:f589cbb86b03255ce3e84ea79ffe3bd5e54c47c5:changelog:Added:0d3660dd803e repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=f589cbb86b03255ce3e84ea79ffe3bd5e54c47c5 date=2026-04-23 updatedAt=2026-06-27T01:43:55.794Z -->
- **Breaking:** Expose modular adapter contracts and expand the MCP control plane with resources, templates, sampling, and agent definition APIs. ([README.md](README.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->

### Fixed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:41440990c2da9902d4c971b532d38ac21cf5ba1f:changelog:Fixed:1c6036675530 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=41440990c2da9902d4c971b532d38ac21cf5ba1f date=2026-04-23 updatedAt=2026-06-27T01:43:55.795Z -->
- Enforce patched @xmldom/xmldom resolution to avoid vulnerable transitive versions. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

## 2026-04-20

### Changed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:9328d63a4af0a9a71d2e6d4a712e9f6445461ead:changelog:Changed:9b11b265c08c repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=9328d63a4af0a9a71d2e6d4a712e9f6445461ead date=2026-04-20 updatedAt=2026-06-27T01:43:55.797Z -->
- **Breaking:** Move OpenAI-compatible server exports under routes/openai-compat and add dzupagent workspace CLI plus configurable mail DLQ delivery. ([README.md](README.md)) (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:286b6dbb89bf3982368d3b4c634ee86bc135c1c4:changelog:Added:0a59150a1e31 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=286b6dbb89bf3982368d3b4c634ee86bc135c1c4 date=2026-04-20 updatedAt=2026-06-27T01:43:55.798Z -->
- Add multi-provider dzupagent import and sync write-back for Gemini, Qwen, Goose, and Crush with dry-run reporting. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:8be94b7bac180bd0081c88aee9e78ef31c4b19ba:changelog:Added:c13cccf2e7e0 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=8be94b7bac180bd0081c88aee9e78ef31c4b19ba date=2026-04-20 updatedAt=2026-06-27T01:43:55.799Z -->
- Add bundle lookup and default registry support to agent adapter skill capability inspection. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:b4b4330eade5578646f0b511f9a266aeb4a861d5:changelog:Added:87fad129c0d2 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=b4b4330eade5578646f0b511f9a266aeb4a861d5 date=2026-04-20 updatedAt=2026-06-27T01:43:55.800Z -->
- Add adapter type surface for run event persistence and Codex git-repo check skipping. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:7d167290348d31d477cfd6eb167b58f934a81489:changelog:Added:71da0ccd3794 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=7d167290348d31d477cfd6eb167b58f934a81489 date=2026-04-20 updatedAt=2026-06-27T01:43:55.801Z -->
- Add sync CLI support, Qdrant-backed RAG wiring, and testing exports for LLM recording and evals. ([packages/rag/docs/qdrant-example.ts](packages/rag/docs/qdrant-example.ts)) (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:4b611c3efacae8b9a5c5093e331f2f613b5bfd97:changelog:Added:f59d1da4f7b1 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=4b611c3efacae8b9a5c5093e331f2f613b5bfd97 date=2026-04-20 updatedAt=2026-06-27T01:43:55.802Z -->
- Add Unified Capability Layer loaders and run event persistence for agent adapters. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:6914d5af35fc335d8bfa5211e21b90de5946eca8:changelog:Added:3ab6ab1038cd repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=6914d5af35fc335d8bfa5211e21b90de5946eca8 date=2026-04-20 updatedAt=2026-06-27T01:43:55.803Z -->
- Add adapter-rules package for compiling canonical provider rules into runtime plans. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:2ac9d48b419a2f751a9820399f7f494521c775fa:changelog:Added:5ac45b949082 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=2ac9d48b419a2f751a9820399f7f494521c775fa date=2026-04-20 updatedAt=2026-06-27T01:43:55.804Z -->
- Add flow AST parsing and workflow compiler packages. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:13974ae29304d54ccde323eca37adbaad4141911:changelog:Added:ea03133a93ec repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=13974ae29304d54ccde323eca37adbaad4141911 date=2026-04-20 updatedAt=2026-06-27T01:43:55.805Z -->
- Add team orchestration, connector resolvers, flow handles, memory reference tracking, and HITL kit scaffolding. ([README.md](README.md)) (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:bdc944c285ca4967a7d89fb34417bd685b70c161:changelog:Added:656993425822 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=bdc944c285ca4967a7d89fb34417bd685b70c161 date=2026-04-20 updatedAt=2026-06-27T01:43:55.806Z -->
- Add playground compile progress and capability matrix views plus app-tools and code-edit-kit packages. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:d3aebdf4e00eeba265c0703710b63b0ff5bda294:changelog:Added:377cf1a69bb4 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=d3aebdf4e00eeba265c0703710b63b0ff5bda294 date=2026-04-20 updatedAt=2026-06-27T01:43:55.807Z -->
- Add server capabilities, OpenAI-compatible completion routes, and mail retry support. ([docs/tooling/DECISIONS_WAVE_11.md](docs/tooling/DECISIONS_WAVE_11.md)) (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:b425ea02addeca94e5bab423558741fa3712b033:changelog:Added:3a9dc8a83f65 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=b425ea02addeca94e5bab423558741fa3712b033 date=2026-04-20 updatedAt=2026-06-27T01:43:55.808Z -->
- Add adapter rule watcher registrations and governance event types. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:a49c72e08c8e96580668f4217d8a528a15fe5b76:changelog:Added:92f9c099ef33 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=a49c72e08c8e96580668f4217d8a528a15fe5b76 date=2026-04-20 updatedAt=2026-06-27T01:43:55.809Z -->
- Add artifact watching, governance events, and Codex skill and agent sync to agent adapters. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:e8e75b3245c12526c4ad6c39794169c2881852cc:changelog:Added:f2a0b8782c08 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=e8e75b3245c12526c4ad6c39794169c2881852cc date=2026-04-20 updatedAt=2026-06-27T01:43:55.811Z -->
- Add first-class workflow resume support and built-in app/code editing tools. ([packages/agent/src/workflow/ARCHITECTURE.md](packages/agent/src/workflow/ARCHITECTURE.md)) (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:d7485f8dd09e5bf70ac524811d6cf4248ec967a3:changelog:Added:ec618700b874 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=d7485f8dd09e5bf70ac524811d6cf4248ec967a3 date=2026-04-20 updatedAt=2026-06-27T01:43:55.812Z -->
- Add `/api/workflows/compile` flow compilation route with JSON and SSE outputs. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->

### Fixed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:ee9a59ca78bcd65a7403722ced5b73e63a97025c:changelog:Fixed:88de9001f61f repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=ee9a59ca78bcd65a7403722ced5b73e63a97025c date=2026-04-20 updatedAt=2026-06-27T01:43:55.816Z -->
- Fix codegen multi-file patch parsing and pipeline executor failure handling. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:5190b08d6d6b014faac5501b70fed603fa627679:changelog:Fixed:2f8a49c8ad72 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=5190b08d6d6b014faac5501b70fed603fa627679 date=2026-04-20 updatedAt=2026-06-27T01:43:55.817Z -->
- Fix Goose and Crush config projection to emit native approval, provider, watcher, and MCP settings. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->

## 2026-04-18

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:6c65f53bbfb9e9efac9be5588a1469b7e79bdfda:changelog:Added:97228d2c4ca2 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=6c65f53bbfb9e9efac9be5588a1469b7e79bdfda date=2026-04-18 updatedAt=2026-06-27T01:43:55.820Z -->
- Add OpenAI-safe Zod schema conversion and adapter interaction events. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:9ca95f9bd90bc2eda5f912eeec924fcbb2305265:changelog:Added:92a661049742 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=9ca95f9bd90bc2eda5f912eeec924fcbb2305265 date=2026-04-18 updatedAt=2026-06-27T01:43:55.821Z -->
- Add adapter interaction policies and interaction events. (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:47a445c25ce5916d86961590492bc12725a39b08:changelog:Added:cbf39c19858a repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=47a445c25ce5916d86961590492bc12725a39b08 date=2026-04-18 updatedAt=2026-06-27T01:43:55.822Z -->
- Add mid-execution interaction handling for agent adapters. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->

### Fixed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:0c339c6ac49c1238e70aeeb55563096ad332bac1:changelog:Fixed:dbd1de810c74 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=0c339c6ac49c1238e70aeeb55563096ad332bac1 date=2026-04-18 updatedAt=2026-06-27T01:43:55.824Z -->
- Fix OpenAI strict structured output generation and add adapter interaction metrics. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->

## 2026-04-17

### Changed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:661676045483fda3d2a750bc10b7340be4dd0581:changelog:Changed:650c9d005066 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=661676045483fda3d2a750bc10b7340be4dd0581 date=2026-04-17 updatedAt=2026-06-27T01:43:55.826Z -->
- **Breaking:** Change core WorkingMemory exports to the new persistence-backed store and add token lifecycle, session search, corpus management, and permission-tier helpers. ([README.md](README.md)) (ninel.hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:c8bad556afb66e63178ff3730b7b5b157e75e89c:changelog:Added:a99d0be620ef repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=c8bad556afb66e63178ff3730b7b5b157e75e89c date=2026-04-17 updatedAt=2026-06-27T01:43:55.828Z -->
- Add AGENTS.md hierarchy discovery, GitHub automation tools, OpenAI tool-call streaming, cluster route exports, and adapter usage forwarding. (Ninel Hodzic, Claude Sonnet 4.6)
<!-- /workspace-changelog:entry -->

## 2026-04-16

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:ab0f4ebfe225a2e5f1957786bf700022033d098e:changelog:Added:2ae6650c6656 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=ab0f4ebfe225a2e5f1957786bf700022033d098e date=2026-04-16 updatedAt=2026-06-27T01:43:55.831Z -->
- Add agent run handles, orchestration routing, journals, mailbox, presets, reflection, and workflow execution support. ([README.md](README.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:5770c21ee015caf4ea1a263eb00689fe0fac4a95:changelog:Added:09557fb51595 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=5770c21ee015caf4ea1a263eb00689fe0fac4a95 date=2026-04-16 updatedAt=2026-06-27T01:43:55.832Z -->
- Add dzupagent import, sync, memory, connector, and codegen streaming support. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:8aad0a381c138fb3599dd867c339d82f550b01a8:changelog:Added:260f8a21c007 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=8aad0a381c138fb3599dd867c339d82f550b01a8 date=2026-04-16 updatedAt=2026-06-27T01:43:55.833Z -->
- Add server workflow APIs, SSE run streaming, OpenAI-compatible routes, and A2A playground views. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:2ac590657aec9ba4afcfa6af6bb6561b3a931ba6:changelog:Added:cf6f0a245c9a repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=2ac590657aec9ba4afcfa6af6bb6561b3a931ba6 date=2026-04-16 updatedAt=2026-06-27T01:43:55.835Z -->
- Add create-dzupagent research scaffolding, optional adapter wiring, and eval trend/scorer tools. (ninel.hodzic)
<!-- /workspace-changelog:entry -->

## 2026-04-15

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:16e22ea3bf4c420cf4bea2dbdf0ec170d8e95a15:changelog:Added:1dd3ad45d509 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=16e22ea3bf4c420cf4bea2dbdf0ec170d8e95a15 date=2026-04-15 updatedAt=2026-06-27T01:43:55.837Z -->
- Add per-turn timeout overrides and timeout diagnostics to the Codex adapter. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

## 2026-04-14

### Changed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:1c10d91dc89340145b39a0d84c5e0f84ed8a634a:changelog:Changed:b31553160689 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=1c10d91dc89340145b39a0d84c5e0f84ed8a634a date=2026-04-14 updatedAt=2026-06-27T01:43:55.839Z -->
- **Breaking:** Restructure the DzupAgent monorepo packages and publishing setup. ([README.md](README.md), [MIGRATION.md](MIGRATION.md), [.changeset/README.md](.changeset/README.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->

## 2026-03-30

### Changed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:8a57b04bc0941fa9569092e1cf25f140e7a63995:changelog:Changed:ea8789a96334 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=8a57b04bc0941fa9569092e1cf25f140e7a63995 date=2026-03-30 updatedAt=2026-06-27T01:43:55.842Z -->
- **Breaking:** Consolidate CLI-backed agent adapters and require explicit terminal completion for orchestration results. ([packages/agent-adapters/README.md](packages/agent-adapters/README.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:e890d657917ac4575fdb35399ae0bea992767457:changelog:Changed:928494098a43 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=e890d657917ac4575fdb35399ae0bea992767457 date=2026-03-30 updatedAt=2026-06-27T01:43:55.843Z -->
- **Breaking:** Compile WorkflowBuilder flows to PipelineRuntime definitions and stop execution when suspended. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:6231c085a8bffb30c09fe1e7ce3a1f4ab9bc1d67:changelog:Changed:0c8d44c40c9c repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=6231c085a8bffb30c09fe1e7ce3a1f4ab9bc1d67 date=2026-03-30 updatedAt=2026-06-27T01:43:55.847Z -->
- **Breaking:** Run codegen phases through the shared pipeline runtime and perform real quality scoring for validation. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:8427c171a1266effba2e9ea46ea8c2e4c6ad88e5:changelog:Changed:03a2de3a9bc3 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=8427c171a1266effba2e9ea46ea8c2e4c6ad88e5 date=2026-03-30 updatedAt=2026-06-27T01:43:55.848Z -->
- **Breaking:** Add distributable ESM package exports for browser and document connectors. ([packages/connectors-browser/README.md](packages/connectors-browser/README.md), [packages/connectors-documents/README.md](packages/connectors-documents/README.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:03ed4637cd734c8d69741b6f66f83ff1329a8170:changelog:Changed:c84093b30f3a repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=03ed4637cd734c8d69741b6f66f83ff1329a8170 date=2026-03-30 updatedAt=2026-06-27T01:43:55.849Z -->
- **Breaking:** Enforce scoped RAG memory keys and apply source-quality metadata during retrieval. ([packages/rag/README.md](packages/rag/README.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:a22ddab777a763bf62851a94f1a3b09201625a5e:changelog:Changed:fd186178f349 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=a22ddab777a763bf62851a94f1a3b09201625a5e date=2026-03-30 updatedAt=2026-06-27T01:43:55.850Z -->
- Normalize Gemini, Qwen, and Crush CLI adapter event records. ([docs/README.md](docs/README.md), [docs/features/event-bus.md](docs/features/event-bus.md)) (Ninel Hodzic, Junie)
<!-- /workspace-changelog:entry -->

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:649626c61e2ca2d615b1490ade07c075af65bc13:changelog:Added:f639c9b6d940 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=649626c61e2ca2d615b1490ade07c075af65bc13 date=2026-03-30 updatedAt=2026-06-27T01:43:55.852Z -->
- Add embedding-backed SQL example retrieval to NL2SQL schema lookup. ([packages/domain-nl2sql/README.md](packages/domain-nl2sql/README.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:5942f1ed3a9d6084e7b89c826f6f204238db13e2:changelog:Added:f4f2ffaf5f32 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=5942f1ed3a9d6084e7b89c826f6f204238db13e2 date=2026-03-30 updatedAt=2026-06-27T01:43:55.853Z -->
- Add scraper extraction options and robots.txt checks. ([packages/scraper/README.md](packages/scraper/README.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:136fd0964c23b55e07e631ad651f028e1cb2cc66:changelog:Added:d43e30bfd549 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=136fd0964c23b55e07e631ad651f028e1cb2cc66 date=2026-03-30 updatedAt=2026-06-27T01:43:55.854Z -->
- Add strict benchmark mode and target executor outputs for eval runs. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:1fba9911f62403050daaad62d84e2709053e5a58:changelog:Added:3da2bb17c7a0 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=1fba9911f62403050daaad62d84e2709053e5a58 date=2026-03-30 updatedAt=2026-06-27T01:43:55.856Z -->
- Add optional server benchmark APIs with baseline comparison and Forge trace context propagation. (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:af61f664b1fcc1b8ad7a807877caf8ce1028d637:changelog:Added:22e910d1b705 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=af61f664b1fcc1b8ad7a807877caf8ce1028d637 date=2026-03-30 updatedAt=2026-06-27T01:43:55.857Z -->
- Add package documentation for cache and Express integrations. ([packages/cache/README.md](packages/cache/README.md), [packages/express/README.md](packages/express/README.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

## 2026-03-29

### Changed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:4a4d14b96c4a3382b59d68a0e2329bc058cba77a:changelog:Changed:3ba7e6e852fe repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=4a4d14b96c4a3382b59d68a0e2329bc058cba77a date=2026-03-29 updatedAt=2026-06-27T01:43:55.860Z -->
- Route adapter workflows through PipelineRuntime and expose compiled pipeline definitions. ([docs/canonical_runtime_migration_map.md](docs/canonical_runtime_migration_map.md), [packages/agent-adapters/README.md](packages/agent-adapters/README.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:d569ade69e4a981cb4ea52c3b675ea688520fdc6:changelog:Added:a5e99ea6bdbf repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=d569ade69e4a981cb4ea52c3b675ea688520fdc6 date=2026-03-29 updatedAt=2026-06-27T01:43:55.862Z -->
- Add agent adapter orchestration, caching, RAG, scraping, Express integration, browser and document connectors, and prompt evaluation packages. ([docs/CC_DZIPAGENT.md](docs/CC_DZIPAGENT.md), [docs/guides/migration-from-custom.md](docs/guides/migration-from-custom.md), [docs/packages/cache.md](docs/packages/cache.md), [docs/packages/express.md](docs/packages/express.md), [docs/packages/rag.md](docs/packages/rag.md), [docs/packages/scraper.md](docs/packages/scraper.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:bbe8614534e6b2ce6cbb018609b9c7b5117375c6:changelog:Added:f91a6c466fa6 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=bbe8614534e6b2ce6cbb018609b9c7b5117375c6 date=2026-03-29 updatedAt=2026-06-27T01:43:55.863Z -->
- Add repository contributor guide and package inventory notes. ([AGENTS.md](AGENTS.md), [CLAUDE.md](CLAUDE.md), [plans/init-packages-note.md](plans/init-packages-note.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->

## 2026-03-28

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:bbd852582120667240c07889156155870f74e344:changelog:Added:a84f4009dd41 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=bbd852582120667240c07889156155870f74e344 date=2026-03-28 updatedAt=2026-06-27T01:43:55.865Z -->
- Add NL2SQL streaming events and schema embedding APIs. (Ninel Hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->

## 2026-03-27

### Changed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:75ced5c2e5a5bccefcbefe7610a763ac6e62c67e:changelog:Changed:2743cd1bee3c repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=75ced5c2e5a5bccefcbefe7610a763ac6e62c67e date=2026-03-27 updatedAt=2026-06-27T01:43:55.867Z -->
- **Breaking:** Rename ForgeAgent packages and APIs to DzipAgent. ([CLAUDE.md](CLAUDE.md), [packages/agent/README.md](packages/agent/README.md), [packages/create-dzipagent/README.md](packages/create-dzipagent/README.md)) (Ninel Hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:93da445976926419df52fe5d8b52070330f3351b:changelog:Added:92786410288e repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=93da445976926419df52fe5d8b52070330f3351b date=2026-03-27 updatedAt=2026-06-27T01:43:55.869Z -->
- Add advanced self-correction modules for error detection, root-cause analysis, verification, observability signals, and dynamic rules. (Ninel Hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:836d0c5bfa3470f5d864ae7509604f49c449ca7b:changelog:Added:692f48dfb271 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=836d0c5bfa3470f5d864ae7509604f49c449ca7b date=2026-03-27 updatedAt=2026-06-27T01:43:55.870Z -->
- Add a self-learning feedback loop for pipeline self-correction. (Ninel Hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:7621b9967c5e84873bc1e07c596a14a3183106d1:changelog:Added:7eb8c31bb138 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=7621b9967c5e84873bc1e07c596a14a3183106d1 date=2026-03-27 updatedAt=2026-06-27T01:43:55.872Z -->
- Add self-learning runtime, specialist configuration, performance optimization, and self-correction evaluation benchmarks. (ninel.hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:aba1dddcb8d7f2d94a09bb7ffccc7e5c69497e44:changelog:Added:334904a0033d repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=aba1dddcb8d7f2d94a09bb7ffccc7e5c69497e44 date=2026-03-27 updatedAt=2026-06-27T01:43:55.873Z -->
- Add production self-correction integration for LangGraph learning, feedback capture, dashboards, skill packs, and tenant-scoped memory stores. ([README.md](README.md)) (ninel.hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:79224762593359eba848eabc8fca7cc5b3a11d34:changelog:Added:5fc799a12c4c repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=79224762593359eba848eabc8fca7cc5b3a11d34 date=2026-03-27 updatedAt=2026-06-27T01:43:55.877Z -->
- Add optional `/api/learning` REST routes for self-learning dashboards and feedback management. (ninel.hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:c96212089969f41e6c11f00badba8e09dbb003e7:changelog:Added:f4f8538433a1 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=c96212089969f41e6c11f00badba8e09dbb003e7 date=2026-03-27 updatedAt=2026-06-27T01:43:55.879Z -->
- Add self-learning agent hooks, pipeline calibration events, memory analytics, and create-dzipagent scaffolding features. (Ninel Hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:2de07df461946459dc4bfe0e8cc0da88cea19d3d:changelog:Added:bc23dc5a56ba repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=2de07df461946459dc4bfe0e8cc0da88cea19d3d date=2026-03-27 updatedAt=2026-06-27T01:43:55.880Z -->
- Add unified SQL connectors for eight dialects and an NL2SQL domain package. ([packages/domain-nl2sql/ARCHITECTURE.md](packages/domain-nl2sql/ARCHITECTURE.md)) (Ninel Hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->

### Fixed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:237b601006b8d4a9f801c0bad883d812b78acee5:changelog:Fixed:93f19a18add9 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=237b601006b8d4a9f801c0bad883d812b78acee5 date=2026-03-27 updatedAt=2026-06-27T01:43:55.881Z -->
- Fix TypeScript compilation for SQL connectors and the NL2SQL domain package. (Ninel Hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->

## 2026-03-26

### Changed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:49f2cb5f8bcfbf56b60ad1f070b98fbe0bc6307a:changelog:Changed:779156548572 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=49f2cb5f8bcfbf56b60ad1f070b98fbe0bc6307a date=2026-03-26 updatedAt=2026-06-27T01:43:55.884Z -->
- **Breaking:** Add batch run-log writes and new telemetry, memory, delegation, and supervisor event types. (Ninel Hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:97ff337cb54e4c791e922f28bb1a74645fd22d70:changelog:Changed:407ae7b5a343 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=97ff337cb54e4c791e922f28bb1a74645fd22d70 date=2026-03-26 updatedAt=2026-06-27T01:43:55.885Z -->
- Add adaptive core routing, persisted intent context transfer, trace propagation, and tool statistics APIs. ([README.md](README.md)) (Ninel Hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:4d07b9847d85a4d48507e1d55e02cf53d602a165:changelog:Changed:c57dcda59bed repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=4d07b9847d85a4d48507e1d55e02cf53d602a165 date=2026-03-26 updatedAt=2026-06-27T01:43:55.886Z -->
- Add model escalation, real token usage extraction, structured LLM judging, and configurable pipeline retry behavior. (Ninel Hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:ec78b8cc94f8509b0768e5d836a9d123f4277525:changelog:Changed:db4b71f64462 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=ec78b8cc94f8509b0768e5d836a9d123f4277525 date=2026-03-26 updatedAt=2026-06-27T01:43:55.887Z -->
- **Breaking:** Add LLM-enhanced reflection, per-intent tool ranking, WASM sandbox limits, and playground marketplace UI. (ninel.hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:3344d6a0599ced71367576d8e163803ab1139a2c:changelog:Added:da241cc91efa repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=3344d6a0599ced71367576d8e163803ab1139a2c date=2026-03-26 updatedAt=2026-06-27T01:43:55.888Z -->
- Add adaptive memory retrieval observability, feedback weight learning, and shared namespaces. (Ninel Hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:a51abf4ed6ba6e570dcce0c937b76ebf43bd1fa7:changelog:Added:8abde3cfdb58 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=a51abf4ed6ba6e570dcce0c937b76ebf43bd1fa7 date=2026-03-26 updatedAt=2026-06-27T01:43:55.889Z -->
- **Breaking:** Add BullMQ-backed run queues and scheduled sleep memory consolidation. (Ninel Hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:af611378c338deccf2f25816d7910ab798918ee1:changelog:Added:9b4495850dc4 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=af611378c338deccf2f25816d7910ab798918ee1 date=2026-03-26 updatedAt=2026-06-27T01:43:55.891Z -->
- Add server routing, observability, trace replay, reflection feedback, and Prometheus metrics. (ninel.hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:45c9079401e6bab795b1acfaa37e913c8204d235:changelog:Added:15a67ff56025 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=45c9079401e6bab795b1acfaa37e913c8204d235 date=2026-03-26 updatedAt=2026-06-27T01:43:55.892Z -->
- Add typed agent delegation, specialist supervision, and DAG plan execution. ([README.md](README.md)) (ninel.hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:a672d575c944e54662bdc9c81555f392eb48dff1:changelog:Added:ecbc8f95d4df repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=a672d575c944e54662bdc9c81555f392eb48dff1 date=2026-03-26 updatedAt=2026-06-27T01:43:55.893Z -->
- Add opt-in parallel tool execution, tool argument validation, and run quality reflection to agent runs. ([README.md](README.md)) (ninel.hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:9fe4eadd6e4d786a86e92bdfce195c40c222e037:changelog:Added:33a707eaea42 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=9fe4eadd6e4d786a86e92bdfce195c40c222e037 date=2026-03-26 updatedAt=2026-06-27T01:43:55.894Z -->
- Add LLM plan decomposition, stuck recovery, pipeline tracing, model-tier escalation, CRDT memory, and trace timeline support. (Ninel Hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:d29c764dc8b0291bea678b4ee39b0d82a483dbbb:changelog:Added:6d13e38940dd repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=d29c764dc8b0291bea678b4ee39b0d82a483dbbb date=2026-03-26 updatedAt=2026-06-27T01:43:55.895Z -->
- Add trace timeline replay controls to the playground. (Ninel Hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:a501cc1a9c28786faa2bd0e12fe025fee13b3ea8:changelog:Added:d31a341d6007 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=a501cc1a9c28786faa2bd0e12fe025fee13b3ea8 date=2026-03-26 updatedAt=2026-06-27T01:43:55.897Z -->
- Add server-backed trace replay and tool performance inspection to the playground. (ninel.hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:10f19f71d09e70b8bd389a5987691d27fa39ef48:changelog:Added:fac30df4fce3 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=10f19f71d09e70b8bd389a5987691d27fa39ef48 date=2026-03-26 updatedAt=2026-06-27T01:43:55.898Z -->
- Add recovery copilot, replay debugging, codegen guardrails, team memory graph, deploy confidence checks, and adapter contract tests. ([packages/core/README.md](packages/core/README.md)) (ninel.hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:cf20d248d77200cc532e622486a1c6a51c6e77a9:changelog:Added:028ef26c198f repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=cf20d248d77200cc532e622486a1c6a51c6e77a9 date=2026-03-26 updatedAt=2026-06-27T01:43:55.899Z -->
- Add enterprise agent runtime features across AGENTS.md instructions, memory profiles, parallel tools, self-correction, connectors, deploy confidence, and live trace tooling. ([packages/agent/README.md](packages/agent/README.md), [packages/codegen/README.md](packages/codegen/README.md), [packages/connectors/README.md](packages/connectors/README.md), [packages/core/README.md](packages/core/README.md), [packages/server/README.md](packages/server/README.md)) (Ninel Hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:a9585316b077e48db7df81c7bf8651cb7268bc8b:changelog:Added:db8199ee9c92 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=a9585316b077e48db7df81c7bf8651cb7268bc8b date=2026-03-26 updatedAt=2026-06-27T01:43:55.900Z -->
- Add self-correction modules for reflection loops, recovery feedback, stuck detection, adaptive iteration, and lesson extraction. (Ninel Hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:bdb225b62e4eade69c25f62a5b11cb0310ad2147:changelog:Added:f37287fef40c repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=bdb225b62e4eade69c25f62a5b11cb0310ad2147 date=2026-03-26 updatedAt=2026-06-27T01:43:55.902Z -->
- Add runtime self-correction integrations for stuck detection, trajectory calibration, memory augmentation, and code convention gating. (ninel.hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->

### Fixed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:cc23120217e8982965ae41c7207f7972ba298f20:changelog:Fixed:e474a0278be2 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=cc23120217e8982965ae41c7207f7972ba298f20 date=2026-03-26 updatedAt=2026-06-27T01:43:55.906Z -->
- Fix playground chat isolation and run completion handling during in-flight agent switches. (Ninel Hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:0c0d971556b19cea2e0405bb5a8d58e1e4ab2e79:changelog:Fixed:a82de4e04345 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=0c0d971556b19cea2e0405bb5a8d58e1e4ab2e79 date=2026-03-26 updatedAt=2026-06-27T01:43:55.908Z -->
- Reject HTTP connector requests that escape the configured base origin. (Ninel Hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->

## 2026-03-25

### Changed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:e9acaa2f520688efe8abe606175de588216290c5:changelog:Changed:7492879adba7 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=e9acaa2f520688efe8abe606175de588216290c5 date=2026-03-25 updatedAt=2026-06-27T01:43:55.910Z -->
- **Breaking:** Add scoped WebSocket/SSE event gateway and send EventBridge clients event envelopes. ([packages/server/README.md](packages/server/README.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:b4c9f8a07ef1638a45405fbace0b5e7f2f009d96:changelog:Added:f9bca3900935 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=b4c9f8a07ef1638a45405fbace0b5e7f2f009d96 date=2026-03-25 updatedAt=2026-06-27T01:43:55.911Z -->
- Add ForgeAgent core identity, protocol, registry, pipeline, format, MCP, middleware, and security infrastructure. ([README.md](README.md)) (Ninel Hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:8545d79d02296f86c6ad3def8b8b9d9ec4a78592:changelog:Added:0f3f06178d47 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=8545d79d02296f86c6ad3def8b8b9d9ec4a78592 date=2026-03-25 updatedAt=2026-06-27T01:43:55.913Z -->
- Add advanced memory provenance, shared spaces, encryption, CRDT conflict resolution, causal retrieval, convention, agent-file, multi-modal, and MCP capabilities. (ninel.hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:c26184a51bbd4a825d7e227f38a1f9c8889d2ea4:changelog:Added:e1243506c0f9 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=c26184a51bbd4a825d7e227f38a1f9c8889d2ea4 date=2026-03-25 updatedAt=2026-06-27T01:43:55.914Z -->
- Add ForgeAgent ecosystem packages for observability, evaluations, security testing, playgrounds, scaffolding, orchestration, sandboxing, and server operations. ([packages/agent/README.md](packages/agent/README.md), [packages/otel/README.md](packages/otel/README.md), [packages/evals/README.md](packages/evals/README.md), [packages/testing/README.md](packages/testing/README.md), [packages/server/README.md](packages/server/README.md), [packages/connectors/README.md](packages/connectors/README.md)) (ninel.hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:7e430c7d07862cce09adb93b433aa9cece0e574a:changelog:Added:23ac12056442 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=7e430c7d07862cce09adb93b433aa9cece0e574a date=2026-03-25 updatedAt=2026-06-27T01:43:55.915Z -->
- Add progressive context compression, phase-aware windowing, and cross-intent context transfer. (ninel.hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:60151048677bb287a9806e071a5ec8ea01fd2e96:changelog:Added:d3ce7402f8c1 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=60151048677bb287a9806e071a5ec8ea01fd2e96 date=2026-03-25 updatedAt=2026-06-27T01:43:55.916Z -->
- Add Arrow-based memory IPC package with cross-framework adapters. ([packages/memory-ipc/README.md](packages/memory-ipc/README.md), [packages/test-utils/README.md](packages/test-utils/README.md)) (Ninel Hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:5d4db93e5cede86834145757af13d4fc4485bd6f:changelog:Added:737fa76c1a91 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=5d4db93e5cede86834145757af13d4fc4485bd6f date=2026-03-25 updatedAt=2026-06-27T01:43:55.917Z -->
- Add playground team coordination and staleness pruning for memory consolidation. (Ninel Hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:3d2c7ca28a4bd620773b69bdc7923ac5f2db3493:changelog:Added:db9cc1184d2b repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=3d2c7ca28a4bd620773b69bdc7923ac5f2db3493 date=2026-03-25 updatedAt=2026-06-27T01:43:55.919Z -->
- Add an AgentPlayground API and extend sleep consolidation phase types. (ninel.hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:0c97b9d39a96d1482a58cdc169b507b2a7ace347:changelog:Added:81bf5bd8f99a repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=0c97b9d39a96d1482a58cdc169b507b2a7ace347 date=2026-03-25 updatedAt=2026-06-27T01:43:55.920Z -->
- Add playground barrel exports. (Ninel Hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:93d7cf1af0b0d87265735f0649e8c51885d0ca35:changelog:Added:65aec833f7a9 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=93d7cf1af0b0d87265735f0649e8c51885d0ca35 date=2026-03-25 updatedAt=2026-06-27T01:43:55.921Z -->
- Add threshold settings for sleep consolidation. (Ninel Hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:8c1a6e6fc7c5e6ecfda941945f78a1c70316e6e2:changelog:Added:19db9cf5d78c repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=8c1a6e6fc7c5e6ecfda941945f78a1c70316e6e2 date=2026-03-25 updatedAt=2026-06-27T01:43:55.923Z -->
- Export playground APIs from the agent package index. (ninel.hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:cd4a1c7f05aeef548ee6321d1ced20ac9a4cd5e8:changelog:Added:f3ac03718e7f repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=cd4a1c7f05aeef548ee6321d1ced20ac9a4cd5e8 date=2026-03-25 updatedAt=2026-06-27T01:43:55.924Z -->
- **Breaking:** Add playground orchestration errors and M4 sleep-consolidation phase metrics. (ninel.hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:4939c6aeffe88e488bbe872fe904113021694650:changelog:Added:92d7fd866fd1 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=4939c6aeffe88e488bbe872fe904113021694650 date=2026-03-25 updatedAt=2026-06-27T01:43:55.926Z -->
- Add vector database abstraction with semantic search adapters and embedding providers. (ninel.hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:45dbbd42efae261b77cc609af49765c9a00ebaf4:changelog:Added:28f2af217089 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=45dbbd42efae261b77cc609af49765c9a00ebaf4 date=2026-03-25 updatedAt=2026-06-27T01:43:55.927Z -->
- Add vector store observability, status CLI, and search benchmarks. (ninel.hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:cea72f86bc08c2d66ff34ffdffd5b6da3af12f85:changelog:Added:649d16bc2a21 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=cea72f86bc08c2d66ff34ffdffd5b6da3af12f85 date=2026-03-25 updatedAt=2026-06-27T01:43:55.929Z -->
- Add run-scoped WebSocket subscription control to the playground. (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:a0bb8bc8a7517e31737a246959abbae18e75e2e9:changelog:Added:4f5ae45738e5 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=a0bb8bc8a7517e31737a246959abbae18e75e2e9 date=2026-03-25 updatedAt=2026-06-27T01:43:55.930Z -->
- Add queued run executors and worker processing to the server runtime. ([packages/server/README.md](packages/server/README.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:58d112655c0909eb8b892508ee7a51239ffadebb:changelog:Added:35bed2686145 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=58d112655c0909eb8b892508ee7a51239ffadebb date=2026-03-25 updatedAt=2026-06-27T01:43:55.932Z -->
- Add realtime playground chat streaming with WebSocket handling, SSE fallback, refreshed UI, and Playwright coverage. ([packages/playground/README.md](packages/playground/README.md)) (Ninel Hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:c0fa342179640493cc3b75057b749176980afeee:changelog:Added:6194333f462b repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=c0fa342179640493cc3b75057b749176980afeee date=2026-03-25 updatedAt=2026-06-27T01:43:55.937Z -->
- Add package architecture docs and refresh playground theme utilities. ([packages/agent/docs/ARCHITECTURE.md](packages/agent/docs/ARCHITECTURE.md), [packages/codegen/docs/ARCHITECTURE.md](packages/codegen/docs/ARCHITECTURE.md), [packages/connectors/docs/ARCHITECTURE.md](packages/connectors/docs/ARCHITECTURE.md), [packages/context/docs/ARCHITECTURE.md](packages/context/docs/ARCHITECTURE.md), [packages/core/docs/ARCHITECTURE.md](packages/core/docs/ARCHITECTURE.md), [packages/memory/docs/ARCHITECTURE.md](packages/memory/docs/ARCHITECTURE.md), [packages/memory-ipc/docs/ARCHITECTURE.md](packages/memory-ipc/docs/ARCHITECTURE.md), [packages/otel/docs/ARCHITECTURE.md](packages/otel/docs/ARCHITECTURE.md), [packages/playground/docs/ARCHITECTURE.md](packages/playground/docs/ARCHITECTURE.md), [packages/server/docs/ARCHITECTURE.md](packages/server/docs/ARCHITECTURE.md)) (ninel.hodzic)
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:5f194b0c759faa1850bfae8e5ab3bfa3d0a25bc2:changelog:Added:b4b2793d9390 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=5f194b0c759faa1850bfae8e5ab3bfa3d0a25bc2 date=2026-03-25 updatedAt=2026-06-27T01:43:55.939Z -->
- Add approval-gated run execution, resolved agent tools, and expanded playground management views. (Ninel Hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:2e9554507f9a833830edcf47a5f449b1db301fb6:changelog:Added:cc79ef66225b repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=2e9554507f9a833830edcf47a5f449b1db301fb6 date=2026-03-25 updatedAt=2026-06-27T01:43:55.941Z -->
- Add playground agent and run management views with runtime tool resolution. (Ninel Hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->

### Fixed

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:84a34bc179d8e75f1d12e8026c7bfdffb1a424ca:changelog:Fixed:254e885d8939 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=84a34bc179d8e75f1d12e8026c7bfdffb1a424ca date=2026-03-25 updatedAt=2026-06-27T01:43:55.943Z -->
- **Breaking:** Fix run cancellation propagation and quota reservation enforcement. ([README.md](README.md)) (ninel.hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:40e259b799818e03a527bdbdc7233dffcd2d2b6a:changelog:Fixed:698cdcc0e3a1 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=40e259b799818e03a527bdbdc7233dffcd2d2b6a date=2026-03-25 updatedAt=2026-06-27T01:43:55.944Z -->
- Fix OpenTelemetry handling for agent stream delta and done events. (ninel.hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->

## 2026-03-24

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:e7dc196fd84855e8d8cb4508c8229401b7bf2027:changelog:Added:4905b66fd3ef repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=e7dc196fd84855e8d8cb4508c8229401b7bf2027 date=2026-03-24 updatedAt=2026-06-27T01:43:55.948Z -->
- **Breaking:** Add ForgeAgent framework packages for workflows, approvals, server APIs, connectors, evaluations, and codegen safeguards. ([README.md](README.md)) (Ninel Hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:fe89cb65ed62f324ccbb52b69d6a9e13c5e68cd4:changelog:Added:b4100d57d291 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=fe89cb65ed62f324ccbb52b69d6a9e13c5e68cd4 date=2026-03-24 updatedAt=2026-06-27T01:43:55.949Z -->
- Add ForgeAgent runtime, safety, orchestration, codegen automation, interoperability, and server extension modules. ([README.md](README.md)) (ninel.hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:b2d5640025630cb2915caa6ada362919336f99a2:changelog:Added:f208ad746e54 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=b2d5640025630cb2915caa6ada362919336f99a2 date=2026-03-24 updatedAt=2026-06-27T01:43:55.951Z -->
- Add standalone @forgeagent/memory and @forgeagent/context packages with @forgeagent/core compatibility re-exports. ([packages/context/README.md](packages/context/README.md), [packages/memory/README.md](packages/memory/README.md)) (Ninel Hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->

## 2026-03-23

### Added

<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:d4a9daba49e0b4db96b3aa088151028ea7c5a882:changelog:Added:9f13f7df849f repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=d4a9daba49e0b4db96b3aa088151028ea7c5a882 date=2026-03-23 updatedAt=2026-06-27T01:43:55.955Z -->
- Add ForgeAgent core and codegen packages. ([README.md](README.md)) (ninel.hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:236cebcdfc81b85fa77b6b187ac1d5c487ec0322:changelog:Added:d3507dc0002b repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=236cebcdfc81b85fa77b6b187ac1d5c487ec0322 date=2026-03-23 updatedAt=2026-06-27T01:43:55.957Z -->
- Add package README documentation for the core and codegen APIs. ([packages/codegen/README.md](packages/codegen/README.md), [packages/core/README.md](packages/core/README.md)) (ninel.hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:ca227d677db3b9484da01d9c44833778f7ef4ba3:changelog:Added:57b870033abd repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=ca227d677db3b9484da01d9c44833778f7ef4ba3 date=2026-03-23 updatedAt=2026-06-27T01:43:55.958Z -->
- Expose core helper APIs, including feature description completeness scoring. (Ninel Hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
<!-- workspace-changelog:entry id=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent:df6f976113de79698e95c7e3f0fc4a9113e6933f:changelog:Added:fb5af75b1eb9 repo=out/workspace-changelog-remote/full-rebuild-ssh-20260626T0853Z/worktrees/dzupagent commit=df6f976113de79698e95c7e3f0fc4a9113e6933f date=2026-03-23 updatedAt=2026-06-27T01:43:55.960Z -->
- Add core prompt fragments and memory consolidation utilities. (ninel.hodzic, Claude Opus 4.6 (1M context))
<!-- /workspace-changelog:entry -->
