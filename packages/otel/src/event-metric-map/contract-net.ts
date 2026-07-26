import { asEvent } from "./shared.js";
import type { MetricMapFragment } from "./types.js";

/**
 * Contract-net negotiation metrics.
 *
 * Every metric is labelled with `cfp_id` so the phases of a single
 * Call-For-Proposals (announce → bid → award → complete/fail) can be joined
 * into one negotiation. The free-form `task` string is deliberately not a
 * label -- it is unbounded and would blow up cardinality.
 */
export const contractNetMetricMap = {
  // --- Contract-Net Protocol ---
  "contractnet:announced": [
    {
      metricName: "dzip_contractnet_announced_total",
      type: "counter",
      description:
        "Total contract-net Call-For-Proposals broadcast to specialists",
      labelKeys: ["cfp_id"],
      extract: (e) => {
        const ev = asEvent<"contractnet:announced">(e);
        return { value: 1, labels: { cfp_id: ev.cfpId } };
      },
    },
  ],

  "contractnet:bid_received": [
    {
      metricName: "dzip_contractnet_bid_received_total",
      type: "counter",
      description: "Total contract-net bids received from specialists",
      labelKeys: ["cfp_id", "agent_id"],
      extract: (e) => {
        const ev = asEvent<"contractnet:bid_received">(e);
        return { value: 1, labels: { cfp_id: ev.cfpId, agent_id: ev.agentId } };
      },
    },
  ],

  "contractnet:awarded": [
    {
      metricName: "dzip_contractnet_awarded_total",
      type: "counter",
      description: "Total contract-net awards to a winning bidder",
      labelKeys: ["cfp_id", "winner_id"],
      extract: (e) => {
        const ev = asEvent<"contractnet:awarded">(e);
        return {
          value: 1,
          labels: { cfp_id: ev.cfpId, winner_id: ev.winnerId },
        };
      },
    },
  ],

  "contractnet:completed": [
    {
      metricName: "dzip_contractnet_completed_total",
      type: "counter",
      description: "Total contract-net contracts completed successfully",
      labelKeys: ["cfp_id", "agent_id"],
      extract: (e) => {
        const ev = asEvent<"contractnet:completed">(e);
        return { value: 1, labels: { cfp_id: ev.cfpId, agent_id: ev.agentId } };
      },
    },
    {
      metricName: "dzip_contractnet_duration_ms",
      type: "histogram",
      description: "Contract-net execution duration in milliseconds",
      labelKeys: ["cfp_id", "agent_id"],
      extract: (e) => {
        const ev = asEvent<"contractnet:completed">(e);
        return {
          value: ev.durationMs,
          labels: { cfp_id: ev.cfpId, agent_id: ev.agentId },
        };
      },
    },
  ],

  "contractnet:failed": [
    {
      metricName: "dzip_contractnet_failed_total",
      type: "counter",
      description: "Total contract-net negotiation failures, by phase",
      labelKeys: ["cfp_id", "phase", "agent_id"],
      extract: (e) => {
        const ev = asEvent<"contractnet:failed">(e);
        // `agentId` is absent on bidding-stage failures (nobody bid). Emit a
        // stable placeholder so the metric keeps a consistent label set.
        return {
          value: 1,
          labels: {
            cfp_id: ev.cfpId,
            phase: ev.phase,
            agent_id: ev.agentId ?? "none",
          },
        };
      },
    },
  ],
} satisfies MetricMapFragment;
