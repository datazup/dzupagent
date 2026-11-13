---
"@dzupagent/core": minor
---

Add OpenAI Images API support: `createOpenAIImagesProvider` on `@dzupagent/core/llm` (gpt-image-2.6-flare, gpt-image-2.6-sunburst and gpt-image-2; one image per call, pinned sizes, quality, complexity and output format, capped and time-bounded reply) and `createImageGenerationTool` on `@dzupagent/core/tools` (stores the image through a caller-supplied `store`, returns a reference, caps calls with `maxImages`).
