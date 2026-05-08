/**
 * Internal types and constants for the LanceDB adapter.
 *
 * Defines configuration shapes, SDK type stencils (to avoid `any`), and
 * shared constants used across the LanceDB adapter modules.
 */

import type { DistanceMetric } from '../types.js'

/** Configuration for the LanceDB adapter */
export interface LanceDBAdapterConfig {
  /**
   * LanceDB connection URI.
   * - Local: "~/.dzupagent/lancedb" or "/tmp/lancedb"
   * - S3: "s3://bucket/path"
   * Defaults to ~/.dzupagent/lancedb
   */
  uri?: string

  /**
   * Enable hybrid search (BM25 full-text + vector similarity).
   * Requires LanceDB FTS index to be built on the 'text' column.
   * Default: true
   */
  hybridSearch?: boolean

  /**
   * Weight for vector similarity in hybrid search (0-1).
   * BM25 weight = 1 - vectorWeight.
   * Default: 0.7
   */
  vectorWeight?: number
}

/** Resolved config with all defaults applied */
export interface ResolvedLanceDBConfig {
  uri: string
  hybridSearch: boolean
  vectorWeight: number
}

/** LanceDB distance metric names */
export const DISTANCE_MAP: Record<DistanceMetric, string> = {
  cosine: 'cosine',
  euclidean: 'L2',
  dot_product: 'dot',
}

/** Metadata fields stored alongside the vector (not metadata columns themselves) */
export const RESERVED_COLUMNS = new Set(['id', 'vector', 'text', '_distance', '_rowid'])

/**
 * Internal types for the LanceDB SDK to avoid `any`.
 * These are minimal shapes that match the @lancedb/lancedb API.
 */
export interface LanceDBConnection {
  tableNames(): Promise<string[]>
  createTable(
    name: string,
    data: Record<string, unknown>[],
    options?: Record<string, unknown>,
  ): Promise<LanceDBTable>
  createEmptyTable(
    name: string,
    schema: unknown,
    options?: Record<string, unknown>,
  ): Promise<LanceDBTable>
  openTable(name: string): Promise<LanceDBTable>
  dropTable(name: string): Promise<void>
}

export interface LanceDBTable {
  add(data: Record<string, unknown>[]): Promise<void>
  update(options: { where: string; values: Record<string, unknown> }): Promise<void>
  delete(where: string): Promise<void>
  countRows(filter?: string): Promise<number>
  search(vector: number[]): LanceDBQueryBuilder
  createIndex(column: string, options?: Record<string, unknown>): Promise<void>
  toArrow(): Promise<unknown>
  overwrite(data: Record<string, unknown>[]): Promise<void>
  schema: unknown
}

export interface LanceDBQueryBuilder {
  limit(n: number): LanceDBQueryBuilder
  where(filter: string): LanceDBQueryBuilder
  distanceType(metric: string): LanceDBQueryBuilder
  toArray(): Promise<LanceDBSearchResultRow[]>
  toArrow(): Promise<unknown>
}

export interface LanceDBSearchResultRow {
  id: string
  vector: number[]
  text: string | null
  _distance: number
  [key: string]: unknown
}
