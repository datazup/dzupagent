---
"@dzupagent/core": minor
---

Image generation cost controls: `estimateImageCostUsd` and a pinned `OPENAI_IMAGE_PRICES` table on `@dzupagent/core/llm`; `createImageGenerationTool` gains `maxUsd`, `reserveUsdPerImage` and an `onCost` hook and reports `costUsd`; `createUnixSocketFetch` lets the OpenAI images provider reach a metering proxy on a unix socket.
