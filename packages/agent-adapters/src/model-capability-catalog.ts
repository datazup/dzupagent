import type {
  ProviderRouteBinding, ProviderRouteCapability, ProviderRouteModelCapabilityEvidence,
} from "./model-discovery-types.js";
import type { AdapterProviderId } from "./types.js";
import capabilityReceipts from "./provider-catalog/capability-receipts.json" with { type: "json" };

/** Catalog routes. `claude-cli` is catalog-only until route evidence binds it. */
export type ModelCapabilityRoute = ProviderRouteBinding["route"] | "claude-cli";
/** Catalog capability keys. `structured.output/v1` is catalog-only until route evidence carries it. */
export type ModelCapabilityKey = ProviderRouteCapability | "structured.output/v1";
export type ModelCapabilitySupport = "supported" | "unsupported" | "unknown";

export interface ModelCapabilityCatalogEntry {
  route: ModelCapabilityRoute;
  modelId: string;
  connectorVersion: string;
  qualification: "fixture";
  /** Qualification receipt this entry is transcribed from. */
  receiptId?: string | undefined;
  capabilities: Readonly<Record<ProviderRouteCapability, ModelCapabilitySupport>
    & Partial<Record<"structured.output/v1", ModelCapabilitySupport>>>;
}

/** A citable qualification receipt; `record` locates the document that holds it. */
export interface CapabilityReceipt {
  id: string;
  providerId: AdapterProviderId;
  record: string;
  summary: string;
  pins: string;
}

/** The provider catalog coordinates each catalog route belongs to. */
export const MODEL_CAPABILITY_ROUTE_PROVIDERS: Readonly<Record<ModelCapabilityRoute, {
  providerId: AdapterProviderId; backend: "cli" | "http";
}>> = Object.freeze({
  "codex-cli": Object.freeze({ providerId: "codex", backend: "cli" }),
  "claude-cli": Object.freeze({ providerId: "claude", backend: "cli" }),
  "openai-api": Object.freeze({ providerId: "openai", backend: "http" }),
});

const RECEIPTS_SCHEMA = "dzupagent/capability-receipts/v1";
const SUPPORT_VALUES = new Set<unknown>(["supported", "unsupported", "unknown"]);
const REQUIRED_KEYS: readonly ProviderRouteCapability[] = ["tool.use/v1", "streaming/v1"];
const CAPABILITY_KEYS = new Set<string>([...REQUIRED_KEYS, "structured.output/v1"]);

const invalid = (reason: string): Error => new Error(`CAPABILITY_RECEIPTS_INVALID:${reason}`);
const record = (value: unknown, reason: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(reason);
  return value as Record<string, unknown>;
};
const text = (value: unknown, reason: string): string => {
  if (typeof value !== "string" || value.trim() === "") throw invalid(reason);
  return value;
};
const list = (value: unknown, reason: string): unknown[] => {
  if (!Array.isArray(value)) throw invalid(reason);
  return value;
};

/** Validates a receipts document; every entry must cite a receipt of its route's provider. */
export function parseCapabilityReceipts(document: unknown): {
  receipts: readonly CapabilityReceipt[]; entries: readonly ModelCapabilityCatalogEntry[];
} {
  const root = record(document, "document");
  if (root.schemaVersion !== RECEIPTS_SCHEMA) throw invalid("schemaVersion");
  const receipts = new Map<string, CapabilityReceipt>();
  for (const item of list(root.receipts, "receipts")) {
    const value = record(item, "receipt");
    const receipt: CapabilityReceipt = Object.freeze({
      id: text(value.id, "receipt.id"),
      providerId: text(value.providerId, "receipt.providerId") as AdapterProviderId,
      record: text(value.record, "receipt.record"),
      summary: text(value.summary, "receipt.summary"),
      pins: text(value.pins, "receipt.pins"),
    });
    if (receipts.has(receipt.id)) throw invalid(`receipt.duplicate:${receipt.id}`);
    receipts.set(receipt.id, receipt);
  }
  const keys = new Set<string>();
  const entries = list(root.entries, "entries").map((item): ModelCapabilityCatalogEntry => {
    const value = record(item, "entry");
    const route = text(value.route, "entry.route") as ModelCapabilityRoute;
    if (!Object.hasOwn(MODEL_CAPABILITY_ROUTE_PROVIDERS, route)) throw invalid(`entry.route:${route}`);
    const receiptId = text(value.receiptId, "entry.receiptId");
    if (receipts.get(receiptId)?.providerId !== MODEL_CAPABILITY_ROUTE_PROVIDERS[route].providerId) {
      throw invalid(`entry.receiptId:${receiptId}`);
    }
    if (value.qualification !== "fixture") throw invalid("entry.qualification");
    const modelId = text(value.modelId, "entry.modelId");
    const connectorVersion = text(value.connectorVersion, "entry.connectorVersion");
    const key = JSON.stringify([route, modelId, connectorVersion]);
    if (keys.has(key)) throw invalid(`entry.duplicate:${key}`);
    keys.add(key);
    const capabilities = record(value.capabilities, "entry.capabilities");
    for (const [name, support] of Object.entries(capabilities)) {
      if (!CAPABILITY_KEYS.has(name) || !SUPPORT_VALUES.has(support)) throw invalid(`entry.capability:${name}`);
    }
    if (REQUIRED_KEYS.some(name => !Object.hasOwn(capabilities, name))) throw invalid("entry.capabilities.required");
    return Object.freeze({ route, modelId, connectorVersion, qualification: "fixture", receiptId,
      capabilities: Object.freeze({ ...capabilities }) as ModelCapabilityCatalogEntry["capabilities"] });
  });
  return { receipts: Object.freeze([...receipts.values()]), entries: Object.freeze(entries) };
}

const LOADED = parseCapabilityReceipts(capabilityReceipts);

/** Receipts that back `PROVIDER_CATALOG` runnability and the capability catalog. */
export const CAPABILITY_RECEIPTS: readonly CapabilityReceipt[] = LOADED.receipts;

/**
 * Reviewed entries from `provider-catalog/capability-receipts.json`, one per
 * (route, modelId, connectorVersion). Tests inject synthetic entries explicitly.
 */
export const MODEL_CAPABILITY_CATALOG: readonly ModelCapabilityCatalogEntry[] = LOADED.entries;

/** Never projects support without an exact route, model and connector version match. */
export function qualifiedModelCapability(
  route: ModelCapabilityRoute, version: string | null, modelId: string, capability: ModelCapabilityKey,
  catalog: readonly ModelCapabilityCatalogEntry[] = MODEL_CAPABILITY_CATALOG,
): ProviderRouteModelCapabilityEvidence | undefined {
  if (version === null) return undefined;
  const entry = catalog.find(item =>
    item.route === route && item.modelId === modelId && item.connectorVersion === version);
  const support = entry?.capabilities[capability];
  if (!entry || support === undefined) return { support: "unknown" };
  return { support, qualification: entry.qualification, qualifiedConnectorVersion: entry.connectorVersion };
}

/** Route evidence projection: the route capability keys only. */
export function qualifiedModelCapabilities(
  route: ModelCapabilityRoute, version: string | null, modelId: string,
  catalog: readonly ModelCapabilityCatalogEntry[] = MODEL_CAPABILITY_CATALOG,
): Record<ProviderRouteCapability, ProviderRouteModelCapabilityEvidence> | undefined {
  if (version === null) return undefined;
  const project = (capability: ProviderRouteCapability): ProviderRouteModelCapabilityEvidence =>
    qualifiedModelCapability(route, version, modelId, capability, catalog) ?? { support: "unknown" };
  return { "tool.use/v1": project("tool.use/v1"), "streaming/v1": project("streaming/v1") };
}
