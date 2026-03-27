# @dzipagent/playground Architecture

## Purpose
`@dzipagent/playground` is the interactive UI client for DzipAgent. It provides a chat-first operator surface with realtime run visibility, trace/memory inspection, and configuration/history panels.

## Main Responsibilities
- Provide the end-user chat workflow for agent interaction.
- Track run lifecycle state and render streaming assistant output.
- Display trace timeline, memory data, and configuration in inspector tabs.
- Maintain app state via Pinia stores and composables.
- Integrate with Forge server APIs and websocket control/events.

## Module Structure
Top-level modules under `src/`:
- `App.vue`, `main.ts`, `router/index.ts`, `views/PlaygroundView.vue`.
- `components/chat/`: input, panel, message list/bubble.
- `components/inspector/`: config/history/memory/trace tabs.
- `stores/`: `chat-store`, `trace-store`, `memory-store`, `ws-store`.
- `composables/`: `useApi`, `useWebSocket`.
- `types.ts` and `assets/main.css` for UI contracts/theme.

## How It Works (User Interaction Flow)
1. User selects an agent and sends a message.
2. `chat-store` creates run via `/api/runs` and tracks `runId`.
3. `ws-store` subscribes to run-scoped realtime events.
4. Streaming deltas update the in-progress assistant message.
5. Terminal run state triggers trace refresh and final output reconciliation.
6. Inspector stores render timeline/memory/history views.

## Main Features
- Streaming-friendly chat UX with fallback-safe finalization logic.
- Inspector tabs for operational introspection.
- WS/SSE-aligned event normalization.
- Tailwind-based responsive layout tuned for split-pane workflows.
- E2E + unit-test support for chat flow and store behavior.

## Integration Boundaries
- Designed to run against `@dzipagent/server` APIs and websocket routes.
- No direct dependency on core/agent internals; communicates over HTTP/WS contracts.
- Can be served statically by server route `/playground`.

## Extensibility Points
- Add inspector tabs for new observability domains.
- Add store modules for domain-specific run metadata.
- Extend websocket subscription filters for fine-grained streams.
- Add route-level views for workflows beyond chat.

## Quality and Test Posture
- Unit tests cover stores/composables and streaming UI behavior; Playwright e2e validates integrated runtime UX.
