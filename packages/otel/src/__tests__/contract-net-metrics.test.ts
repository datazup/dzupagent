/**
 * Contract-net protocol metric mapping.
 *
 * The five `contractnet:*` variants landed in @dzupagent/core's
 * `OrchestrationDomainEvent` union (event-types-orchestration.ts) explicitly so
 * that "otel/metrics can observe contract-net phases without decoding an opaque
 * `messageType` string". These tests pin that observability contract: every
 * variant maps to at least one metric, every negotiation is correlatable by
 * `cfp_id`, and the two-phase failure mode stays distinguishable.
 */

import { describe, it, expect } from "vitest";
import { contractNetMetricMap } from "../event-metric-map/contract-net.js";
import { EVENT_METRIC_MAP } from "../event-metric-map.js";
import type { DzupEvent } from "@dzupagent/core";

const CONTRACT_NET_EVENTS = [
  "contractnet:announced",
  "contractnet:bid_received",
  "contractnet:awarded",
  "contractnet:completed",
  "contractnet:failed",
] as const;

describe("contract-net: metric map coverage", () => {
  it("maps every contractnet:* variant", () => {
    for (const type of CONTRACT_NET_EVENTS) {
      const mappings = contractNetMetricMap[type];
      expect(mappings, `${type} must map to at least one metric`).toBeDefined();
      expect(mappings!.length).toBeGreaterThan(0);
    }
  });

  it("is wired into the aggregate EVENT_METRIC_MAP", () => {
    // A fragment that exists but is never spread into the aggregate map records
    // nothing at runtime -- this is the regression that leaves events typed but
    // invisible.
    for (const type of CONTRACT_NET_EVENTS) {
      expect(
        EVENT_METRIC_MAP[type],
        `${type} missing from EVENT_METRIC_MAP`
      ).toBeDefined();
    }
  });

  it("labels every metric with cfp_id so one negotiation is correlatable", () => {
    for (const type of CONTRACT_NET_EVENTS) {
      for (const mapping of contractNetMetricMap[type]!) {
        expect(
          mapping.labelKeys,
          `${mapping.metricName} must label cfp_id`
        ).toContain("cfp_id");
      }
    }
  });

  it("declares labelKeys that match the labels actually extracted", () => {
    const samples: Record<(typeof CONTRACT_NET_EVENTS)[number], DzupEvent> = {
      "contractnet:announced": {
        type: "contractnet:announced",
        cfpId: "c1",
        task: "refactor",
      },
      "contractnet:bid_received": {
        type: "contractnet:bid_received",
        cfpId: "c1",
        agentId: "a1",
      },
      "contractnet:awarded": {
        type: "contractnet:awarded",
        cfpId: "c1",
        winnerId: "a1",
      },
      "contractnet:completed": {
        type: "contractnet:completed",
        cfpId: "c1",
        agentId: "a1",
        durationMs: 120,
      },
      "contractnet:failed": {
        type: "contractnet:failed",
        cfpId: "c1",
        phase: "bidding",
      },
    } as unknown as Record<(typeof CONTRACT_NET_EVENTS)[number], DzupEvent>;

    for (const type of CONTRACT_NET_EVENTS) {
      for (const mapping of contractNetMetricMap[type]!) {
        const { labels } = mapping.extract(samples[type]);
        expect(
          Object.keys(labels).sort(),
          `${mapping.metricName} label drift`
        ).toEqual([...mapping.labelKeys].sort());
      }
    }
  });
});

describe("contract-net: phase 1 announce", () => {
  it("counts one announcement per cfp", () => {
    const [mapping] = contractNetMetricMap["contractnet:announced"]!;
    const result = mapping!.extract({
      type: "contractnet:announced",
      cfpId: "cfp-1",
      task: "refactor auth",
    } as DzupEvent);
    expect(result.value).toBe(1);
    expect(result.labels.cfp_id).toBe("cfp-1");
    expect(mapping!.metricName).toBe("dzip_contractnet_announced_total");
    expect(mapping!.type).toBe("counter");
  });

  it("does not label by task text", () => {
    // Task strings are free-form and unbounded; using one as a label would blow
    // up metric cardinality.
    const [mapping] = contractNetMetricMap["contractnet:announced"]!;
    expect(mapping!.labelKeys).not.toContain("task");
  });
});

describe("contract-net: phase 2 bidding", () => {
  it("counts each bid with its bidder", () => {
    const [mapping] = contractNetMetricMap["contractnet:bid_received"]!;
    const result = mapping!.extract({
      type: "contractnet:bid_received",
      cfpId: "cfp-1",
      agentId: "specialist-a",
    } as DzupEvent);
    expect(result.value).toBe(1);
    expect(result.labels).toEqual({
      cfp_id: "cfp-1",
      agent_id: "specialist-a",
    });
    expect(mapping!.metricName).toBe("dzip_contractnet_bid_received_total");
  });
});

describe("contract-net: phase 4 award", () => {
  it("counts the award and identifies the winner", () => {
    const [mapping] = contractNetMetricMap["contractnet:awarded"]!;
    const result = mapping!.extract({
      type: "contractnet:awarded",
      cfpId: "cfp-1",
      winnerId: "specialist-b",
    } as DzupEvent);
    expect(result.value).toBe(1);
    expect(result.labels).toEqual({
      cfp_id: "cfp-1",
      winner_id: "specialist-b",
    });
    expect(mapping!.metricName).toBe("dzip_contractnet_awarded_total");
  });
});

describe("contract-net: phase 5 completion", () => {
  it("emits both a counter and a duration histogram", () => {
    const mappings = contractNetMetricMap["contractnet:completed"]!;
    expect(mappings).toHaveLength(2);
    expect(mappings.map((m) => m.type).sort()).toEqual([
      "counter",
      "histogram",
    ]);
  });

  it("records durationMs as the histogram value", () => {
    const histogram = contractNetMetricMap["contractnet:completed"]!.find(
      (m) => m.type === "histogram"
    );
    expect(histogram).toBeDefined();
    const result = histogram!.extract({
      type: "contractnet:completed",
      cfpId: "cfp-1",
      agentId: "specialist-b",
      durationMs: 1234,
    } as DzupEvent);
    expect(result.value).toBe(1234);
    expect(result.labels.agent_id).toBe("specialist-b");
    expect(histogram!.metricName).toBe("dzip_contractnet_duration_ms");
  });

  it("counts completion separately from duration", () => {
    const counter = contractNetMetricMap["contractnet:completed"]!.find(
      (m) => m.type === "counter"
    );
    const result = counter!.extract({
      type: "contractnet:completed",
      cfpId: "cfp-1",
      agentId: "specialist-b",
      durationMs: 1234,
    } as DzupEvent);
    expect(result.value).toBe(1);
    expect(counter!.metricName).toBe("dzip_contractnet_completed_total");
  });
});

describe("contract-net: failure", () => {
  it("distinguishes a bidding-stage failure from an execution-stage failure", () => {
    // `phase` is the discriminator the core union documents: bidding failures
    // mean nobody bid; executing failures mean the winner threw. Collapsing them
    // into one counter would make "no specialist available" indistinguishable
    // from "the specialist crashed".
    const [mapping] = contractNetMetricMap["contractnet:failed"]!;
    const bidding = mapping!.extract({
      type: "contractnet:failed",
      cfpId: "cfp-1",
      phase: "bidding",
      reason: "no bids received",
    } as DzupEvent);
    const executing = mapping!.extract({
      type: "contractnet:failed",
      cfpId: "cfp-2",
      phase: "executing",
      agentId: "specialist-b",
      error: "boom",
    } as DzupEvent);

    expect(bidding.labels.phase).toBe("bidding");
    expect(executing.labels.phase).toBe("executing");
    expect(mapping!.metricName).toBe("dzip_contractnet_failed_total");
  });

  it("substitutes a stable placeholder when the optional agentId is absent", () => {
    // A bidding-stage failure has no agentId. Emitting `undefined` as a label
    // value breaks label-set consistency for the metric.
    const [mapping] = contractNetMetricMap["contractnet:failed"]!;
    const result = mapping!.extract({
      type: "contractnet:failed",
      cfpId: "cfp-1",
      phase: "bidding",
      reason: "no bids received",
    } as DzupEvent);
    expect(result.labels.agent_id).toBe("none");
    expect(result.value).toBe(1);
  });

  it("uses the agentId when the execution stage supplies one", () => {
    const [mapping] = contractNetMetricMap["contractnet:failed"]!;
    const result = mapping!.extract({
      type: "contractnet:failed",
      cfpId: "cfp-2",
      phase: "executing",
      agentId: "specialist-b",
      error: "boom",
    } as DzupEvent);
    expect(result.labels.agent_id).toBe("specialist-b");
  });
});
