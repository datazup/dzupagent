/**
 * Sub-agent spawner — creates context-isolated child agents.
 * Inspired by DeepAgentsJS SubAgentMiddleware pattern.
 *
 * Supports both single-turn invocations (spawn) and full
 * ReAct tool-calling loops (spawnReAct).
 */
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { ModelRegistry } from "../llm/model-registry.js";
import { extractTokenUsage } from "../llm/invoke.js";
import { attachStructuredOutputCapabilities } from "../llm/structured-output-capabilities.js";
import { mergeFileChanges } from "./file-merge.js";
import { REACT_DEFAULTS } from "./subagent-types.js";
import type {
  SubAgentConfig,
  SubAgentResult,
  SubAgentSpawnerOptions,
  SubAgentUsage,
} from "./subagent-types.js";
import { resolveSpawnDepth, runAtSpawnDepth } from "./spawn-depth-context.js";
import {
  DEFAULT_SUBAGENT_INJECTION_GUARD,
  checkToolPolicy,
  emitToolCalled,
  emitToolError,
  emitToolResult,
  fenceToolResult,
  inputMetadataKeysOf,
  type SubAgentGuardrailContext,
} from "./subagent-guardrails.js";

interface ToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

/** File-writing tool names whose results may contain file paths */
const FILE_TOOL_NAMES = new Set(["write_file", "edit_file", "create_file"]);

export class SubAgentSpawner {
  constructor(
    private registry: ModelRegistry,
    private options?: SubAgentSpawnerOptions,
  ) {}

  /**
   * Spawn an isolated sub-agent with its own context window.
   * Single-turn invocation — no tool-calling loop.
   *
   * @param config - Sub-agent configuration
   * @param task - The task description (becomes HumanMessage)
   * @param parentFiles - Optional parent VFS to pass as context
   */
  async spawn(
    config: SubAgentConfig,
    task: string,
    parentFiles?: Record<string, string>,
  ): Promise<SubAgentResult> {
    // 1. Resolve model
    const model = this.resolveModel(config);

    // 2. Build system prompt with skills
    const systemPrompt = await this.buildSystemPrompt(config);

    // 3. Build context from parent files
    const contextBlock = this.buildContextBlock(config, parentFiles);

    // 4. Invoke the model directly (simple single-turn)
    const messages: BaseMessage[] = [
      new SystemMessage(systemPrompt),
      new HumanMessage(task + contextBlock),
    ];

    const effectiveModel =
      config.tools && config.tools.length > 0 && "bindTools" in model
        ? ((
            model as BaseChatModel & {
              bindTools: (tools: StructuredToolInterface[]) => BaseChatModel;
            }
          ).bindTools(config.tools) as BaseChatModel)
        : model;

    const response = await effectiveModel.invoke(
      messages,
      config.signal ? { signal: config.signal } : undefined,
    );

    // 5. Extract files from response (if any tool calls produced files)
    const files: Record<string, string> = {};

    return {
      messages: [response],
      files,
      metadata: {
        agentName: config.name,
        modelUsed:
          (model as BaseChatModel & { model?: string }).model ?? "unknown",
      },
    };
  }

  /**
   * Spawn a sub-agent that runs a full ReAct tool-calling loop.
   *
   * The loop: invoke model -> check for tool calls -> execute tools ->
   * append tool results -> repeat until no tool calls or limits reached.
   *
   * @param config - Sub-agent configuration (must include tools for meaningful use)
   * @param task - The task description
   * @param parentFiles - Optional parent VFS to pass as context
   */
  async spawnReAct(
    config: SubAgentConfig,
    task: string,
    parentFiles?: Record<string, string>,
  ): Promise<SubAgentResult> {
    const maxDepth = this.options?.maxDepth ?? REACT_DEFAULTS.maxDepth;
    // DZUPAGENT-AGENT-C-04: depth comes from the ambient spawn-depth context
    // when the caller did not pin `_depth`, so a sub-agent that recurses via a
    // spawn tool is counted even though no code assigns `_depth`.
    const currentDepth = resolveSpawnDepth(config._depth);

    if (currentDepth >= maxDepth) {
      return {
        messages: [
          new AIMessage(
            `[Sub-agent "${config.name}" stopped: max recursion depth ${maxDepth} reached]`,
          ),
        ],
        files: {},
        metadata: {
          agentName: config.name,
          stoppedReason: "max_depth",
          depth: currentDepth,
        },
        hitIterationLimit: false,
      };
    }

    // Run the whole loop — model turns and tool invocations alike — one level
    // deeper, so any spawn started from inside a tool inherits depth + 1.
    return runAtSpawnDepth(currentDepth + 1, () =>
      this.runReActLoop(config, task, currentDepth, parentFiles),
    );
  }

  private async runReActLoop(
    config: SubAgentConfig,
    task: string,
    currentDepth: number,
    parentFiles?: Record<string, string>,
  ): Promise<SubAgentResult> {
    const maxIterations = config.maxIterations ?? REACT_DEFAULTS.maxIterations;
    const timeoutMs = config.timeoutMs ?? REACT_DEFAULTS.timeoutMs;

    // 1. Resolve model and bind tools
    const baseModel = this.resolveModel(config);
    const tools = config.tools ?? [];
    const toolMap = new Map(tools.map((t) => [t.name, t]));

    const model =
      tools.length > 0 && "bindTools" in baseModel
        ? ((
            baseModel as BaseChatModel & {
              bindTools: (tools: StructuredToolInterface[]) => BaseChatModel;
            }
          ).bindTools(tools) as BaseChatModel)
        : baseModel;

    // 2. Build initial messages
    const systemPrompt = await this.buildSystemPrompt(config);
    const contextBlock = this.buildContextBlock(config, parentFiles);
    const allMessages: BaseMessage[] = [
      new SystemMessage(systemPrompt),
      new HumanMessage(task + contextBlock),
    ];

    // 3. Guardrail context (DZUPAGENT-AGENT-C-04). Every member is inert when
    //    the corresponding option was not supplied, except injection fencing
    //    which defaults on.
    const guardrails: SubAgentGuardrailContext = {
      agentId: this.options?.agentId ?? config.name,
      executionRunId:
        config.executionRunId ?? `subagent_${crypto.randomUUID()}`,
      eventBus: this.options?.eventBus,
      promptInjectionGuard:
        this.options?.wrapToolResults === false
          ? undefined
          : (this.options?.promptInjectionGuard ??
            DEFAULT_SUBAGENT_INJECTION_GUARD),
      toolPermissionPolicy: this.options?.toolPermissionPolicy,
      toolGovernance: this.options?.toolGovernance,
    };

    // 4. Cancellation: own timeout plus the parent's signal. The signal is
    //    wired into `model.invoke` AND every `tool.invoke`, so an abort
    //    interrupts work in flight rather than only the next iteration.
    const controller = new AbortController();
    let abortReason: "timeout" | "cancelled" | undefined;
    const timer = setTimeout(() => {
      abortReason ??= "timeout";
      controller.abort();
    }, timeoutMs);

    const parentSignal = config.signal;
    const onParentAbort = (): void => {
      abortReason ??= "cancelled";
      controller.abort();
    };
    if (parentSignal) {
      if (parentSignal.aborted) onParentAbort();
      else parentSignal.addEventListener("abort", onParentAbort, { once: true });
    }

    const abortMessage = (): string =>
      abortReason === "cancelled"
        ? `[Sub-agent "${config.name}" stopped: cancelled by parent]`
        : `[Sub-agent "${config.name}" stopped: timeout after ${timeoutMs}ms]`;

    // 4. Run ReAct loop
    const usage: SubAgentUsage = {
      inputTokens: 0,
      outputTokens: 0,
      llmCalls: 0,
    };
    const files: Record<string, string> = {};
    let hitIterationLimit = false;
    const modelName =
      (baseModel as BaseChatModel & { model?: string }).model ?? "unknown";

    try {
      for (let iteration = 0; iteration < maxIterations; iteration++) {
        if (controller.signal.aborted) {
          allMessages.push(new AIMessage(abortMessage()));
          break;
        }

        // Invoke LLM under the run's abort signal
        let response: BaseMessage;
        try {
          response = await model.invoke(allMessages, {
            signal: controller.signal,
          });
        } catch (err: unknown) {
          if (controller.signal.aborted) {
            allMessages.push(new AIMessage(abortMessage()));
            break;
          }
          throw err;
        }
        usage.llmCalls++;

        // Track token usage
        const iterUsage = extractTokenUsage(response, modelName);
        usage.inputTokens += iterUsage.inputTokens;
        usage.outputTokens += iterUsage.outputTokens;

        allMessages.push(response);

        // Check for tool calls
        const ai = response as AIMessage;
        const toolCalls = ai.tool_calls as ToolCall[] | undefined;

        if (!toolCalls || toolCalls.length === 0) {
          // No tool calls — final response
          break;
        }

        // Execute each tool call
        for (const tc of toolCalls) {
          // SEC-L-02: crypto.randomUUID for unpredictable fallback IDs
          const toolCallId =
            tc.id ??
            `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
          const tool = toolMap.get(tc.name);
          const inputMetadataKeys = inputMetadataKeysOf(tc.args);

          if (!tool) {
            const message = `Error: Tool "${tc.name}" not found. Available tools: ${[...toolMap.keys()].join(", ")}`;
            emitToolError(guardrails, {
              toolName: tc.name,
              toolCallId,
              durationMs: 0,
              inputMetadataKeys,
              errorCode: "TOOL_NOT_FOUND",
              message,
            });
            allMessages.push(
              new ToolMessage({
                content: message,
                tool_call_id: toolCallId,
                name: tc.name,
              }),
            );
            continue;
          }

          // Pre-execution policy gate: permission policy, then governance
          // access / approval.
          const decision = checkToolPolicy(guardrails, tc.name, tc.args);
          if (decision.kind !== "allow") {
            if (decision.kind === "blocked") {
              emitToolError(guardrails, {
                toolName: tc.name,
                toolCallId,
                durationMs: 0,
                inputMetadataKeys,
                errorCode: decision.errorCode,
                message: decision.content,
              });
            }
            allMessages.push(
              new ToolMessage({
                content: decision.content,
                tool_call_id: toolCallId,
                name: tc.name,
              }),
            );
            continue;
          }

          emitToolCalled(guardrails, {
            toolName: tc.name,
            toolCallId,
            args: tc.args,
          });
          const startedAt = Date.now();

          try {
            const result = await tool.invoke(tc.args, {
              signal: controller.signal,
            });
            const resultStr =
              typeof result === "string" ? result : JSON.stringify(result);

            emitToolResult(guardrails, {
              toolName: tc.name,
              toolCallId,
              durationMs: Date.now() - startedAt,
              inputMetadataKeys,
            });

            allMessages.push(
              new ToolMessage({
                // Tool output crosses a trust boundary — fence it so the model
                // cannot read an injected payload as instruction.
                content: fenceToolResult(guardrails, resultStr),
                tool_call_id: toolCallId,
                name: tc.name,
              }),
            );

            // Extract file data from write_file / edit_file / create_file tool calls
            this.extractFilesFromToolCall(tc.name, tc.args, resultStr, files);
          } catch (err: unknown) {
            // Non-fatal: return error as ToolMessage so the LLM can recover
            const errMsg = err instanceof Error ? err.message : String(err);
            emitToolError(guardrails, {
              toolName: tc.name,
              toolCallId,
              durationMs: Date.now() - startedAt,
              inputMetadataKeys,
              errorCode: controller.signal.aborted
                ? "TOOL_TIMEOUT"
                : "TOOL_EXECUTION_FAILED",
              message: errMsg,
            });
            allMessages.push(
              new ToolMessage({
                content: fenceToolResult(
                  guardrails,
                  `Error executing tool "${tc.name}": ${errMsg}`,
                ),
                tool_call_id: toolCallId,
                name: tc.name,
              }),
            );
          }

          // An abort mid-batch must stop the remaining tool calls too.
          if (controller.signal.aborted) break;
        }

        // Check if this was the last allowed iteration
        if (iteration === maxIterations - 1) {
          hitIterationLimit = true;
        }
      }
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    }

    return {
      messages: allMessages,
      files,
      metadata: {
        agentName: config.name,
        modelUsed: modelName,
        depth: currentDepth,
        executionRunId: guardrails.executionRunId,
        ...(abortReason ? { stoppedReason: abortReason } : {}),
      },
      usage,
      hitIterationLimit,
    };
  }

  /**
   * Spawn a sub-agent and merge its file results back into a parent VFS.
   *
   * When the config includes tools, uses spawnReAct for a full tool-calling
   * loop. Otherwise falls back to single-turn spawn.
   */
  async spawnAndMerge(
    config: SubAgentConfig,
    task: string,
    parentFiles: Record<string, string>,
  ): Promise<{ result: SubAgentResult; mergedFiles: Record<string, string> }> {
    const result =
      config.tools && config.tools.length > 0
        ? await this.spawnReAct(config, task, parentFiles)
        : await this.spawn(config, task, parentFiles);
    const mergedFiles = mergeFileChanges(parentFiles, result.files);
    return { result, mergedFiles };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private resolveModel(config: SubAgentConfig): BaseChatModel {
    const attachCapabilities = (model: BaseChatModel): BaseChatModel =>
      attachStructuredOutputCapabilities(
        model,
        config.structuredOutputCapabilities,
      );

    if (!config.model) {
      return attachCapabilities(this.registry.getModel("codegen"));
    }
    if (typeof config.model === "string") {
      return attachCapabilities(this.registry.getModel(config.model));
    }
    return attachCapabilities(config.model);
  }

  /**
   * Build system prompt, appending loaded skill content.
   */
  private async buildSystemPrompt(config: SubAgentConfig): Promise<string> {
    let systemPrompt = config.systemPrompt;
    if (
      config.skills &&
      config.skills.length > 0 &&
      this.options?.skillLoader
    ) {
      const allSkills = await this.options.skillLoader.discoverSkills();
      const configSkills = config.skills;
      const relevantSkills = allSkills.filter((s) =>
        configSkills.includes(s.name),
      );
      for (const skill of relevantSkills) {
        const content = await this.options.skillLoader.loadSkillContent(
          skill.name,
        );
        if (content) {
          systemPrompt += `\n\n## Skill: ${skill.name}\n\n${content}`;
        }
      }
    }
    return systemPrompt;
  }

  /**
   * Build file-context block string from parent files.
   */
  private buildContextBlock(
    config: SubAgentConfig,
    parentFiles?: Record<string, string>,
  ): string {
    if (!parentFiles || Object.keys(parentFiles).length === 0) {
      return "";
    }

    const filtered = config.contextFilter
      ? config.contextFilter({ files: parentFiles })
      : { files: parentFiles };
    const files = (filtered as Record<string, unknown>).files as
      | Record<string, string>
      | undefined;
    if (!files || Object.keys(files).length === 0) {
      return "";
    }

    const fileList = Object.entries(files)
      .map(([path, content]) => `### ${path}\n\`\`\`\n${content}\n\`\`\``)
      .join("\n\n");
    return `\n\n## Existing Files\n\n${fileList}`;
  }

  /**
   * Extract file path/content from tool call arguments or results.
   * Handles common patterns: { path: string, content: string } args for
   * write_file/edit_file/create_file tools.
   */
  private extractFilesFromToolCall(
    toolName: string,
    args: Record<string, unknown>,
    _resultStr: string,
    files: Record<string, string>,
  ): void {
    if (!FILE_TOOL_NAMES.has(toolName)) return;

    const filePath = args["path"] ?? args["file_path"] ?? args["filePath"];
    const content =
      args["content"] ?? args["new_content"] ?? args["newContent"];

    if (typeof filePath === "string" && typeof content === "string") {
      files[filePath] = content;
    }
  }
}
