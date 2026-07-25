import type {
  PrimitiveDefinitionV2,
  PrimitiveRegistryV2,
} from "../primitives/types.js";
import type {
  FlowSchemaRef,
  FlowSchemaRegistry,
} from "../schemas/types.js";

export type MigratableContractRef =
  | PrimitiveDefinitionV2["ref"]
  | FlowSchemaRef;

export type VersionMigrationRef =
  `migration://${"primitive" | "schema"}/${string}@${string}-to-${string}`;

export type VersionMigrationClassification =
  | "equivalent"
  | "compatible"
  | "lossy"
  | "incompatible";

export interface VersionMigrationDefinition {
  readonly schema: "dzupagent.versionMigrationDefinition/v1";
  readonly ref: VersionMigrationRef;
  readonly owner: string;
  readonly fromRef: MigratableContractRef;
  readonly toRef: MigratableContractRef;
  readonly fromSemanticHash: `sha256:${string}`;
  readonly toSemanticHash: `sha256:${string}`;
  readonly classification: VersionMigrationClassification;
  readonly transformRef?: string;
  readonly semanticProjectionRef?: string;
  readonly rollback:
    | {
        readonly kind: "exact";
        readonly transformRef: string;
      }
    | {
        readonly kind: "manual";
        readonly instructions: string;
      }
    | {
        readonly kind: "unavailable";
        readonly reason: string;
      };
  readonly migrationHash: `sha256:${string}`;
}

export type VersionMigrationDefinitionInput = Omit<
  VersionMigrationDefinition,
  "migrationHash"
>;

export interface VersionMigrationRegistry {
  readonly schema: "dzupagent.versionMigrationRegistry/v1";
  readonly registryHash: `sha256:${string}`;
  get(ref: VersionMigrationRef): VersionMigrationDefinition | undefined;
  find(
    fromRef: MigratableContractRef,
    toRef: MigratableContractRef,
  ): VersionMigrationDefinition | undefined;
  list(): readonly VersionMigrationDefinition[];
}

export interface VersionMigrationRegistryOptions {
  readonly primitiveRegistry?: PrimitiveRegistryV2;
  readonly schemaRegistry?: FlowSchemaRegistry;
}

export type VersionMigrationHandler = (value: unknown) => unknown;

export interface VersionMigrationHandlers {
  readonly transforms: Readonly<
    Record<string, VersionMigrationHandler | undefined>
  >;
  readonly projections?: Readonly<
    Record<string, VersionMigrationHandler | undefined>
  >;
}

export interface VersionMigrationPreview {
  readonly schema: "dzupagent.versionMigrationPreview/v1";
  readonly migrationRef: VersionMigrationRef;
  readonly migrationHash: `sha256:${string}`;
  readonly classification: VersionMigrationClassification;
  readonly status: "previewed" | "blocked-incompatible";
  readonly fromRef: MigratableContractRef;
  readonly toRef: MigratableContractRef;
  readonly fromSemanticHash: `sha256:${string}`;
  readonly toSemanticHash: `sha256:${string}`;
  readonly beforeDigest: `sha256:${string}`;
  readonly afterDigest?: `sha256:${string}`;
  readonly changed: boolean;
  readonly semanticEquivalent?: boolean;
  readonly beforeSemanticDigest?: `sha256:${string}`;
  readonly afterSemanticDigest?: `sha256:${string}`;
  readonly rollback:
    | {
        readonly kind: "exact";
        readonly digest: `sha256:${string}`;
        readonly restoresInput: boolean;
      }
    | {
        readonly kind: "manual" | "unavailable";
        readonly detail: string;
      };
  readonly output?: unknown;
}

export interface VersionMigrationFixture {
  readonly id: string;
  readonly input: unknown;
  readonly expectedOutput?: unknown;
}

export interface VersionMigrationFixtureResult {
  readonly id: string;
  readonly passed: boolean;
  readonly expectedOutputDigest?: `sha256:${string}`;
  readonly preview: VersionMigrationPreview;
  readonly diagnostics: readonly string[];
}

export interface VersionMigrationQualificationReport {
  readonly schema: "dzupagent.versionMigrationQualification/v1";
  readonly migrationRef: VersionMigrationRef;
  readonly migrationHash: `sha256:${string}`;
  readonly fixtureSetHash: `sha256:${string}`;
  readonly ready: boolean;
  readonly results: readonly VersionMigrationFixtureResult[];
}
