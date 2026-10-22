import { describe, expect, it } from "vitest";

import {
  CAPABILITY_RECEIPTS, MODEL_CAPABILITY_CATALOG, MODEL_CAPABILITY_ROUTE_PROVIDERS,
  parseCapabilityReceipts, qualifiedModelCapabilities, qualifiedModelCapability,
} from "../model-capability-catalog.js";
import { PROVIDER_CATALOG } from "../provider-catalog/catalog.js";
import receiptsDocument from "../provider-catalog/capability-receipts.json" with { type: "json" };
import { FIXTURE_MODEL_CAPABILITY_CATALOG } from "./fixtures/model-capability-catalog.js";

type Row = Record<string, unknown> & { capabilities: Record<string, unknown> };
interface Doc { schemaVersion: string; receipts: Array<Record<string, unknown>>; entries: Row[] }

const document = (): Doc => structuredClone(receiptsDocument) as unknown as Doc;
const entry = (value: Doc): Row => value.entries[0]!;

describe("model capability catalog", () => {
  it("catalog is non-empty", () => {
    expect(MODEL_CAPABILITY_CATALOG.length).toBeGreaterThan(0);
    expect(MODEL_CAPABILITY_CATALOG.map(entry => entry.route).sort()).toEqual(["claude-cli", "codex-cli"]);
    expect(Object.isFrozen(MODEL_CAPABILITY_CATALOG)).toBe(true);
    expect(Object.isFrozen(MODEL_CAPABILITY_CATALOG[0]?.capabilities)).toBe(true);
  });

  it("every entry's route exists in PROVIDER_CATALOG", () => {
    for (const entry of MODEL_CAPABILITY_CATALOG) {
      const { providerId, backend } = MODEL_CAPABILITY_ROUTE_PROVIDERS[entry.route];
      const provider = PROVIDER_CATALOG[providerId];
      expect(provider, entry.route).toBeDefined();
      expect(provider.coordinates.backend, entry.route).toBe(backend);
      // A seeded entry cites the same receipt that makes its provider runnable.
      expect(provider.runnable, entry.route).toBe(true);
      expect(provider.qualificationReceiptId, entry.route).toBe(entry.receiptId);
      expect(CAPABILITY_RECEIPTS.some(receipt => receipt.id === entry.receiptId)).toBe(true);
    }
  });

  it("qualifiedModelCapabilities returns supported for a seeded claude model", () => {
    const seeded = MODEL_CAPABILITY_CATALOG.find(entry => entry.route === "claude-cli")!;
    expect(qualifiedModelCapabilities("claude-cli", seeded.connectorVersion, seeded.modelId)).toEqual({
      "tool.use/v1": { support: "supported", qualification: "fixture", qualifiedConnectorVersion: seeded.connectorVersion },
      "streaming/v1": { support: "supported", qualification: "fixture", qualifiedConnectorVersion: seeded.connectorVersion },
    });
  });

  it("never projects a seeded entry onto another connector version, model or route", () => {
    const unknown = { "tool.use/v1": { support: "unknown" }, "streaming/v1": { support: "unknown" } };
    expect(qualifiedModelCapabilities("claude-cli", "2.1.0", "provider-default")).toEqual(unknown);
    expect(qualifiedModelCapabilities("claude-cli", "unpinned", "claude-sonnet-4")).toEqual(unknown);
    expect(qualifiedModelCapabilities("openai-api", "unpinned", "provider-default")).toEqual(unknown);
    expect(qualifiedModelCapabilities("claude-cli", null, "provider-default")).toBeUndefined();
  });

  it("reports structured.output/v1 at catalog level without a receipt claiming it", () => {
    expect(qualifiedModelCapability("codex-cli", "unpinned", "provider-default", "structured.output/v1"))
      .toEqual({ support: "unknown", qualification: "fixture", qualifiedConnectorVersion: "unpinned" });
    // Entries without the key stay unknown rather than inheriting a claim.
    expect(qualifiedModelCapability("codex-cli", "fixture-1", "model-a", "structured.output/v1",
      FIXTURE_MODEL_CAPABILITY_CATALOG)).toEqual({ support: "unknown" });
    expect(qualifiedModelCapability("codex-cli", null, "model-a", "tool.use/v1")).toBeUndefined();
  });

  it("parses the checked-in receipts document", () => {
    const parsed = parseCapabilityReceipts(receiptsDocument);
    expect(parsed.entries).toEqual(MODEL_CAPABILITY_CATALOG);
    expect(parsed.receipts.map(receipt => receipt.id)).toEqual(["AAI-B002b1d", "AAI-B002b2/E001c2b3"]);
  });

  it.each([
    ["an unknown schema", (value: Doc) => { value.schemaVersion = "v0"; }, "schemaVersion"],
    ["an entry citing a missing receipt", (value: Doc) => { entry(value).receiptId = "NOPE"; },
      "entry.receiptId:NOPE"],
    ["an entry citing another provider's receipt", (value: Doc) => {
      entry(value).receiptId = "AAI-B002b2/E001c2b3"; }, "entry.receiptId:AAI-B002b2/E001c2b3"],
    ["an unknown route", (value: Doc) => { entry(value).route = "gemini-cli"; }, "entry.route:gemini-cli"],
    ["a live qualification", (value: Doc) => { entry(value).qualification = "live"; }, "entry.qualification"],
    ["an unknown capability key", (value: Doc) => {
      entry(value).capabilities["vision/v1"] = "supported"; }, "entry.capability:vision/v1"],
    ["an invalid support value", (value: Doc) => {
      entry(value).capabilities["tool.use/v1"] = "yes"; }, "entry.capability:tool.use/v1"],
    ["a missing required capability", (value: Doc) => {
      delete entry(value).capabilities["streaming/v1"]; }, "entry.capabilities.required"],
    ["a duplicate entry", (value: Doc) => { value.entries.push(entry(value)); }, "entry.duplicate"],
    ["a duplicate receipt", (value: Doc) => { value.receipts.push(value.receipts[0]!); },
      "receipt.duplicate:AAI-B002b1d"],
    ["a receipt without a record", (value: Doc) => { value.receipts[0]!.record = ""; }, "receipt.record"],
  ] as const)("rejects %s", (_name, mutate, reason) => {
    const value = document();
    mutate(value);
    expect(() => parseCapabilityReceipts(value)).toThrow(`CAPABILITY_RECEIPTS_INVALID:${reason}`);
  });
});
