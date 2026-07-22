/**
 * Drizzle ORM schema — agent marketplace catalog and API-key auth tables.
 */
import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Agent Catalog (Marketplace)
// ---------------------------------------------------------------------------

export const agentCatalog = pgTable(
  "agent_catalog",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    version: text("version").notNull(),
    tags: text("tags").array().default([]).notNull(),
    author: text("author"),
    readme: text("readme"),
    publishedAt: timestamp("published_at"),
    isPublic: boolean("is_public").default(true).notNull(),
    tenantId: text("tenant_id").notNull().default("default"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("agent_catalog_tenant_slug_idx").on(table.tenantId, table.slug),
    index("agent_catalog_author_idx").on(table.author),
    index("agent_catalog_tenant_id_idx").on(table.tenantId),
  ]
);

// ---------------------------------------------------------------------------
// API Keys
// ---------------------------------------------------------------------------

/**
 * API keys used for authenticating clients against the server.
 *
 * The raw key is never stored — only the SHA-256 hex digest. The raw value is
 * returned exactly once at creation time; callers are responsible for storing
 * it securely. Keys can be scoped to an owner, time-limited via `expiresAt`,
 * and revoked by setting `revokedAt`.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** SHA-256 hex digest of the raw key (64 chars). */
    keyHash: varchar("key_hash", { length: 64 }).notNull().unique(),
    /** The user/agent id that owns this key. */
    ownerId: varchar("owner_id", { length: 255 }).notNull(),
    /** Human-readable label for the key. */
    name: varchar("name", { length: 255 }),
    /** Rate-limit tier, consumed by the rate-limiter middleware. */
    rateLimitTier: varchar("rate_limit_tier", { length: 50 })
      .default("standard")
      .notNull(),
    /**
     * MC-S02: RBAC role. Defaults to 'user'. Admin-only endpoints (MCP
     * registration, cluster management) require 'admin'.
     */
    role: text("role").notNull().default("user"),
    /**
     * MC-S02: Tenant scope carried by this key. Downstream records stamped
     * with this key inherit the value; list queries filter by tenantId so
     * keys from different tenants cannot observe each other's data.
     */
    tenantId: text("tenant_id").notNull().default("default"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at"),
    revokedAt: timestamp("revoked_at"),
    lastUsedAt: timestamp("last_used_at"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  },
  (table) => [
    index("api_keys_owner_id_idx").on(table.ownerId),
    index("api_keys_key_hash_idx").on(table.keyHash),
    index("api_keys_tenant_id_idx").on(table.tenantId),
  ]
);
