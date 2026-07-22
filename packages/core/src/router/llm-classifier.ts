/**
 * LLM-based intent classification — used as fallback when keywords don't match.
 */
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ForgeError } from "../errors/forge-error.js";
import { defaultLogger } from "../utils/logger.js";

export class LLMClassifier {
  constructor(
    private model: BaseChatModel,
    private promptTemplate: string,
    private validIntents: string[],
  ) {}

  /**
   * Classify user text into one of the valid intents via LLM.
   * The promptTemplate should contain {message} and {intents} placeholders.
   *
   * Return contract (ERR-M-04):
   * - Returns the matched intent string on a successful match.
   * - Returns `null` for a GENUINE no-match (the model responded but the reply
   *   matched no valid intent).
   * - THROWS `ForgeError{ code: 'PROVIDER_UNAVAILABLE', recoverable: true }` on a
   *   provider transport failure (outage/timeout). A transport failure is thus
   *   distinguishable from a genuine no-match instead of collapsing to the same
   *   `null`, and the underlying error is logged for observability.
   */
  async classify(text: string): Promise<string | null> {
    const prompt = this.promptTemplate
      .replace("{message}", text)
      .replace("{intents}", this.validIntents.join(", "));

    let response;
    try {
      response = await this.model.invoke([
        new SystemMessage(
          "You are an intent classifier. Respond with ONLY the intent name, nothing else.",
        ),
        new HumanMessage(prompt),
      ]);
    } catch (err) {
      // Provider transport failure — NOT a no-match. Log and surface a typed,
      // recoverable error so callers can distinguish it from a genuine null.
      defaultLogger.warn("[core] intent classifier transport failure", {
        operation: "router.classify",
        error: err instanceof Error ? err.message : String(err),
      });
      throw new ForgeError({
        code: "PROVIDER_UNAVAILABLE",
        message: "Intent classification provider call failed",
        recoverable: true,
        context: { operation: "router.classify" },
        ...(err instanceof Error ? { cause: err } : {}),
      });
    }

    const result =
      typeof response.content === "string"
        ? response.content.trim().toLowerCase()
        : "";

    // Validate the response is a known intent
    if (this.validIntents.includes(result)) {
      return result;
    }

    // Try partial match (LLM might return extra text)
    for (const intent of this.validIntents) {
      if (result.includes(intent)) {
        return intent;
      }
    }

    // Genuine no-match: the model responded but nothing matched.
    return null;
  }
}
