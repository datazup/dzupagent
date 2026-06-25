/**
 * Slack connector — tools for sending messages and interacting with Slack.
 */
import { z } from "zod";
import {
  fetchWithOutboundUrlPolicy,
  type OutboundUrlSecurityPolicy,
} from "@dzupagent/core/security";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { filterTools } from "../connector-types.js";
import type { ConnectorToolkit } from "../connector-contract.js";

export interface SlackConnectorConfig {
  token: string;
  enabledTools?: string[];
  /** Optional outbound URL policy override for Slack API calls. */
  outboundUrlPolicy?: OutboundUrlSecurityPolicy;
}

const SLACK_API = "https://slack.com/api";

// ---------------------------------------------------------------------------
// Webhook event types
// ---------------------------------------------------------------------------

export interface SlackEventEnvelope {
  token?: string;
  team_id?: string;
  api_app_id?: string;
  event?: SlackEvent;
  type: string;
  event_id?: string;
  event_time?: number;
}

export interface SlackEvent {
  type: string;
  subtype?: string;
  channel?: string;
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  reaction?: string;
  item?: {
    type: string;
    channel?: string;
    ts?: string;
  };
}

export type SlackEventType =
  | "message"
  | "app_mention"
  | "reaction_added"
  | "reaction_removed"
  | "member_joined_channel"
  | "channel_created"
  | "file_shared";

// ---------------------------------------------------------------------------
// Block Kit helpers
// ---------------------------------------------------------------------------

export interface SlackBlock {
  type: string;
  [key: string]: unknown;
}

export interface SlackSectionBlock extends SlackBlock {
  type: "section";
  text: { type: "mrkdwn" | "plain_text"; text: string };
  accessory?: SlackBlock;
}

export interface SlackHeaderBlock extends SlackBlock {
  type: "header";
  text: { type: "plain_text"; text: string };
}

export interface SlackDividerBlock extends SlackBlock {
  type: "divider";
}

export interface SlackContextBlock extends SlackBlock {
  type: "context";
  elements: Array<{
    type: "mrkdwn" | "plain_text" | "image";
    text?: string;
    image_url?: string;
    alt_text?: string;
  }>;
}

export interface SlackActionsBlock extends SlackBlock {
  type: "actions";
  elements: SlackBlock[];
}

/**
 * Convert plain text to a Slack Section block with mrkdwn.
 */
export function textToSectionBlock(text: string): SlackSectionBlock {
  return {
    type: "section",
    text: { type: "mrkdwn", text },
  };
}

/**
 * Convert text to a plain_text header block.
 */
export function textToHeaderBlock(text: string): SlackHeaderBlock {
  return {
    type: "header",
    text: { type: "plain_text", text },
  };
}

/**
 * Create a divider block.
 */
export function createDividerBlock(): SlackDividerBlock {
  return { type: "divider" };
}

/**
 * Create a context block from text strings.
 */
export function textsToContextBlock(texts: string[]): SlackContextBlock {
  return {
    type: "context",
    elements: texts.map((t) => ({ type: "mrkdwn" as const, text: t })),
  };
}

/**
 * Convert a text string into a full Block Kit payload (array of blocks).
 * Splits on blank lines to produce multiple section blocks.
 */
export function textToBlocks(text: string): SlackBlock[] {
  if (!text || text.trim() === "") {
    return [textToSectionBlock(text)];
  }
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim());
  if (paragraphs.length === 0) {
    return [textToSectionBlock(text)];
  }
  return paragraphs.map((p) => textToSectionBlock(p.trim()));
}

/**
 * Truncate text to Slack's section block 3000-char limit.
 */
export function truncateForBlock(text: string, maxLen = 3000): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

// ---------------------------------------------------------------------------
// Webhook event parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse an incoming Slack event envelope and return structured event info.
 * Returns null if the envelope is not a valid event callback.
 */
export function parseSlackEventEnvelope(
  payload: unknown,
): SlackEventEnvelope | null {
  if (typeof payload !== "object" || payload === null) return null;
  const env = payload as Record<string, unknown>;
  if (typeof env["type"] !== "string") return null;
  return env as unknown as SlackEventEnvelope;
}

/**
 * Extract the inner Slack event from an envelope.
 */
export function extractSlackEvent(
  envelope: SlackEventEnvelope,
): SlackEvent | null {
  if (envelope.type !== "event_callback") return null;
  return envelope.event ?? null;
}

/**
 * Determine whether a Slack event is a direct message (DM).
 * DMs have a channel starting with 'D'.
 */
export function isDirectMessage(event: SlackEvent): boolean {
  return typeof event.channel === "string" && event.channel.startsWith("D");
}

/**
 * Determine whether a Slack event mentions the bot.
 * app_mention events are always bot mentions; message events may contain <@BOT_ID>.
 */
export function isBotMention(event: SlackEvent, botUserId?: string): boolean {
  if (event.type === "app_mention") return true;
  if (botUserId && event.text) {
    return event.text.includes(`<@${botUserId}>`);
  }
  return false;
}

/**
 * Extract reaction name from a reaction_added/reaction_removed event.
 */
export function extractReactionName(event: SlackEvent): string | null {
  if (event.type !== "reaction_added" && event.type !== "reaction_removed")
    return null;
  return event.reaction ?? null;
}

// ---------------------------------------------------------------------------
// Connector tools
// ---------------------------------------------------------------------------

export function createSlackConnector(
  config: SlackConnectorConfig,
): DynamicStructuredTool[] {
  const outboundUrlPolicy =
    config.outboundUrlPolicy ?? defaultSlackOutboundPolicy();

  async function slack(
    method: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const res = await fetchWithOutboundUrlPolicy(
      `${SLACK_API}/${method}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      {
        policy: outboundUrlPolicy,
      },
    );
    return res.json();
  }

  const all: DynamicStructuredTool[] = [
    new DynamicStructuredTool({
      name: "slack_send_message",
      description: "Send a message to a Slack channel",
      schema: z.object({
        channel: z
          .string()
          .describe("Channel ID or name (e.g., #general or C1234567890)"),
        text: z.string().describe("Message text (supports Slack markdown)"),
        thread_ts: z
          .string()
          .optional()
          .describe("Thread timestamp for replies"),
      }),
      func: async ({ channel, text, thread_ts }) => {
        const data = (await slack("chat.postMessage", {
          channel,
          text,
          thread_ts,
        })) as Record<string, unknown>;
        return data["ok"]
          ? `Message sent to ${channel}`
          : `Error: ${data["error"] ?? "unknown"}`;
      },
    }),

    new DynamicStructuredTool({
      name: "slack_list_channels",
      description: "List Slack channels the bot has access to",
      schema: z.object({
        limit: z
          .number()
          .optional()
          .describe("Max channels to return (default: 20)"),
      }),
      func: async ({ limit }) => {
        const data = (await slack("conversations.list", {
          limit: limit ?? 20,
          types: "public_channel,private_channel",
        })) as Record<string, unknown>;
        if (!data["ok"]) return `Error: ${data["error"] ?? "unknown"}`;
        const channels = (data["channels"] ?? []) as Array<
          Record<string, unknown>
        >;
        return channels.map((c) => `#${c["name"]} (${c["id"]})`).join("\n");
      },
    }),

    new DynamicStructuredTool({
      name: "slack_search_messages",
      description: "Search messages across Slack channels",
      schema: z.object({
        query: z.string().describe("Search query"),
        count: z.number().optional().describe("Max results (default: 10)"),
      }),
      func: async ({ query, count }) => {
        const data = (await slack("search.messages", {
          query,
          count: count ?? 10,
        })) as Record<string, unknown>;
        if (!data["ok"]) return `Error: ${data["error"] ?? "unknown"}`;
        const messages =
          ((data["messages"] as Record<string, unknown>)?.["matches"] as Array<
            Record<string, unknown>
          >) ?? [];
        return messages
          .map(
            (m) =>
              `[${(m["channel"] as Record<string, unknown> | undefined)?.["name"] ?? "?"}] ${m["text"]}`,
          )
          .join("\n\n");
      },
    }),

    new DynamicStructuredTool({
      name: "slack_add_reaction",
      description: "Add an emoji reaction to a Slack message",
      schema: z.object({
        channel: z.string().describe("Channel ID containing the message"),
        timestamp: z.string().describe("Timestamp of the message to react to"),
        name: z
          .string()
          .describe("Emoji name without colons (e.g., thumbsup, rocket)"),
      }),
      func: async ({ channel, timestamp, name }) => {
        const data = (await slack("reactions.add", {
          channel,
          timestamp,
          name,
        })) as Record<string, unknown>;
        return data["ok"]
          ? `Reaction :${name}: added`
          : `Error: ${data["error"] ?? "unknown"}`;
      },
    }),

    new DynamicStructuredTool({
      name: "slack_remove_reaction",
      description: "Remove an emoji reaction from a Slack message",
      schema: z.object({
        channel: z.string().describe("Channel ID containing the message"),
        timestamp: z.string().describe("Timestamp of the message"),
        name: z
          .string()
          .describe("Emoji name without colons (e.g., thumbsup, rocket)"),
      }),
      func: async ({ channel, timestamp, name }) => {
        const data = (await slack("reactions.remove", {
          channel,
          timestamp,
          name,
        })) as Record<string, unknown>;
        return data["ok"]
          ? `Reaction :${name}: removed`
          : `Error: ${data["error"] ?? "unknown"}`;
      },
    }),

    new DynamicStructuredTool({
      name: "slack_get_reactions",
      description: "Get reactions on a Slack message",
      schema: z.object({
        channel: z.string().describe("Channel ID containing the message"),
        timestamp: z.string().describe("Timestamp of the message"),
      }),
      func: async ({ channel, timestamp }) => {
        const data = (await slack("reactions.get", {
          channel,
          timestamp,
          full: true,
        })) as Record<string, unknown>;
        if (!data["ok"]) return `Error: ${data["error"] ?? "unknown"}`;
        const message = (data["message"] as Record<string, unknown>) ?? {};
        const reactions =
          (message["reactions"] as Array<Record<string, unknown>>) ?? [];
        if (reactions.length === 0) return "No reactions";
        return reactions.map((r) => `:${r["name"]}: ×${r["count"]}`).join("  ");
      },
    }),
  ];

  return filterTools(all, config.enabledTools);
}

function defaultSlackOutboundPolicy(): OutboundUrlSecurityPolicy {
  return { allowedHosts: ["slack.com"] };
}

/**
 * Create a ConnectorToolkit for Slack API operations.
 * Wraps `createSlackConnector` in the unified toolkit pattern.
 */
export function createSlackConnectorToolkit(
  config: SlackConnectorConfig,
): ConnectorToolkit {
  return {
    name: "slack",
    tools: createSlackConnector(config),
    enabledTools: config.enabledTools,
  };
}
