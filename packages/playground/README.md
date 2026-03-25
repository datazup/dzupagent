# @forgeagent/playground

Tailwind-powered Vue 3 playground for running ForgeAgent conversations and inspecting execution in real time.

This package is private to this monorepo and is not published to npm.

## Main Features

- Agent chat workspace with model/agent switching
- Realtime updates via WebSocket with SSE fallback
- Inspector tabs for trace timeline, memory browser, config, and run history
- Responsive split layout optimized for desktop and mobile
- Tailwind CSS v4 theme tokens in `src/assets/main.css`
- Pinia stores for chat, traces, memory, and connection state

## How To Use

### 1. Install dependencies

```bash
cd packages/forgeagent-playground
npm install
```

### 2. Run the playground in dev mode

```bash
npm run dev
```

By default, Vite proxies `/api/*` requests to the ForgeAgent backend.

### 3. Configure backend endpoints (optional)

Create `.env.local` (or set shell env vars):

```bash
VITE_WS_URL=ws://localhost:8787/ws
VITE_WS_PATH=/ws
```

- `VITE_WS_URL` takes priority when set.
- If not set, the app derives WS URL from current origin.

### 4. Build for production

```bash
npm run build
```

The generated assets are written to `dist/` and can be served by `@forgeagent/server` on `/playground`.

## Scripts

```bash
npm run dev         # Vite dev server
npm run build       # Typecheck + production build
npm run typecheck   # Vue typecheck
npm run test        # Unit tests (Vitest)
npm run test:e2e    # Playwright E2E
```

## Project Layout

```text
src/
  App.vue
  views/PlaygroundView.vue
  components/chat/*
  components/inspector/*
  stores/*
  composables/*
  assets/main.css
```

## Notes

- UI styling is built with Tailwind utilities + CSS custom properties.
- Realtime trace events are normalized from WS/SSE and pushed into the trace store.

## License

MIT
