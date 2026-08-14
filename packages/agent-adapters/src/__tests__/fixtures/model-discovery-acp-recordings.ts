/**
 * Sanitized ACP stdout recordings. Session IDs are synthetic, and the
 * recordings contain no credentials, host paths, endpoints, or raw provider
 * content. They are parser fixtures only, not live qualification evidence.
 */

export const GEMINI_0_35_3_ACP_MODEL_RECORDING = [
  '{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true}}}',
  '{"jsonrpc":"2.0","id":1,"result":{"sessionId":"00000000-0000-4000-8000-000000000001","models":{"availableModels":[{"modelId":"auto-gemini-2.5","name":"Auto (Gemini 2.5)","description":"Let Gemini CLI choose a model for the task"},{"modelId":"gemini-2.5-pro","name":"gemini-2.5-pro"},{"modelId":"gemini-2.5-flash","name":"gemini-2.5-flash"},{"modelId":"gemini-2.5-flash-lite","name":"gemini-2.5-flash-lite"}],"currentModelId":"auto-gemini-2.5"}}}',
].join("\n");

export const QWEN_0_21_9_ACP_MODEL_RECORDING = [
  '{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true}}}',
  '{"jsonrpc":"2.0","id":1,"result":{"sessionId":"00000000-0000-4000-8000-000000000002","models":{"availableModels":[{"modelId":"qwen3-coder-plus(qwen-oauth)","name":"Qwen3 Coder Plus","description":"Coding Plan model","_meta":{"contextLimit":1000000}},{"modelId":"qwen3-max-preview(qwen-oauth)","name":"Qwen3 Max Preview","description":"Coding Plan model","_meta":{"contextLimit":262144}}],"currentModelId":"qwen3-coder-plus(qwen-oauth)"}}}',
].join("\n");
