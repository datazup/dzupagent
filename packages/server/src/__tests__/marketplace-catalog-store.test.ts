/**
 * Unit tests for InMemoryCatalogStore — CRUD operations and search.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  InMemoryCatalogStore,
  CatalogNotFoundError,
  CatalogSlugConflictError,
} from '../marketplace/catalog-store.js'
import type { CatalogStore } from '../marketplace/catalog-store.js'

describe('InMemoryCatalogStore', () => {
  let store: CatalogStore

  beforeEach(() => {
    store = new InMemoryCatalogStore()
  })

  // -------------------------------------------------------------------------
  // create()
  // -------------------------------------------------------------------------

  describe('create()', () => {
    it('creates a catalog entry with all fields', async () => {
      const entry = await store.create({
        slug: 'summarizer-v2',
        name: 'Summarizer V2',
        description: 'Summarizes text',
        version: '2.0.0',
        tags: ['nlp', 'summarization'],
        author: 'alice',
        readme: '# Summarizer',
        publishedAt: '2026-01-01T00:00:00Z',
        isPublic: true,
      })

      expect(entry.id).toBeTruthy()
      expect(entry.slug).toBe('summarizer-v2')
      expect(entry.name).toBe('Summarizer V2')
      expect(entry.description).toBe('Summarizes text')
      expect(entry.version).toBe('2.0.0')
      expect(entry.tags).toEqual(['nlp', 'summarization'])
      expect(entry.author).toBe('alice')
      expect(entry.readme).toBe('# Summarizer')
      expect(entry.publishedAt).toBe('2026-01-01T00:00:00Z')
      expect(entry.isPublic).toBe(true)
      expect(entry.createdAt).toBeTruthy()
      expect(entry.updatedAt).toBeTruthy()
    })

    it('creates entry with defaults for optional fields', async () => {
      const entry = await store.create({
        slug: 'minimal',
        name: 'Minimal',
        description: null,
        version: '1.0.0',
        tags: [],
        author: null,
        readme: null,
        publishedAt: null,
        isPublic: true,
      })

      expect(entry.description).toBeNull()
      expect(entry.tags).toEqual([])
      expect(entry.author).toBeNull()
      expect(entry.readme).toBeNull()
      expect(entry.publishedAt).toBeNull()
      expect(entry.isPublic).toBe(true)
    })

    it('uses provided id when given', async () => {
      const entry = await store.create({
        id: 'custom-id-123',
        slug: 'custom',
        name: 'Custom',
        description: null,
        version: '1.0.0',
        tags: [],
        author: null,
        readme: null,
        publishedAt: null,
        isPublic: true,
      })
      expect(entry.id).toBe('custom-id-123')
    })

    it('generates id when not provided', async () => {
      const entry = await store.create({
        slug: 'auto-id',
        name: 'Auto ID',
        description: null,
        version: '1.0.0',
        tags: [],
        author: null,
        readme: null,
        publishedAt: null,
        isPublic: true,
      })
      expect(entry.id).toBeTruthy()
      expect(entry.id).not.toBe('')
    })

    it('throws CatalogSlugConflictError on duplicate slug', async () => {
      await store.create({
        slug: 'duplicate',
        name: 'First',
        description: null,
        version: '1.0.0',
        tags: [],
        author: null,
        readme: null,
        publishedAt: null,
        isPublic: true,
      })

      await expect(
        store.create({
          slug: 'duplicate',
          name: 'Second',
          description: null,
          version: '2.0.0',
          tags: [],
          author: null,
          readme: null,
          publishedAt: null,
          isPublic: true,
        }),
      ).rejects.toThrow(CatalogSlugConflictError)
    })

    it('allows different slugs', async () => {
      const a = await store.create({
        slug: 'slug-a',
        name: 'A',
        description: null,
        version: '1.0.0',
        tags: [],
        author: null,
        readme: null,
        publishedAt: null,
        isPublic: true,
      })
      const b = await store.create({
        slug: 'slug-b',
        name: 'B',
        description: null,
        version: '1.0.0',
        tags: [],
        author: null,
        readme: null,
        publishedAt: null,
        isPublic: true,
      })
      expect(a.id).not.toBe(b.id)
    })
  })

  // -------------------------------------------------------------------------
  // getById() / getBySlug()
  // -------------------------------------------------------------------------

  describe('getById()', () => {
    it('returns entry by id', async () => {
      const created = await store.create({
        slug: 'test-get',
        name: 'Test',
        description: null,
        version: '1.0.0',
        tags: [],
        author: null,
        readme: null,
        publishedAt: null,
        isPublic: true,
      })
      const found = await store.getById(created.id)
      expect(found).toEqual(created)
    })

    it('returns null for nonexistent id', async () => {
      const found = await store.getById('nonexistent')
      expect(found).toBeNull()
    })
  })

  describe('getBySlug()', () => {
    it('returns entry by slug', async () => {
      const created = await store.create({
        slug: 'my-slug',
        name: 'My Agent',
        description: null,
        version: '1.0.0',
        tags: [],
        author: null,
        readme: null,
        publishedAt: null,
        isPublic: true,
      })
      const found = await store.getBySlug('my-slug')
      expect(found).toEqual(created)
    })

    it('returns null for nonexistent slug', async () => {
      const found = await store.getBySlug('no-such-slug')
      expect(found).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // update()
  // -------------------------------------------------------------------------

  describe('update()', () => {
    it('updates name', async () => {
      const created = await store.create({
        slug: 'upd-1',
        name: 'Original',
        description: null,
        version: '1.0.0',
        tags: [],
        author: null,
        readme: null,
        publishedAt: null,
        isPublic: true,
      })
      const updated = await store.update(created.id, { name: 'Updated' })
      expect(updated.name).toBe('Updated')
      expect(updated.slug).toBe('upd-1')
      expect(updated.id).toBe(created.id)
    })

    it('updates tags', async () => {
      const created = await store.create({
        slug: 'upd-tags',
        name: 'Tags',
        description: null,
        version: '1.0.0',
        tags: ['a'],
        author: null,
        readme: null,
        publishedAt: null,
        isPublic: true,
      })
      const updated = await store.update(created.id, { tags: ['a', 'b', 'c'] })
      expect(updated.tags).toEqual(['a', 'b', 'c'])
    })

    it('updates version', async () => {
      const created = await store.create({
        slug: 'upd-ver',
        name: 'Version',
        description: null,
        version: '1.0.0',
        tags: [],
        author: null,
        readme: null,
        publishedAt: null,
        isPublic: true,
      })
      const updated = await store.update(created.id, { version: '2.0.0' })
      expect(updated.version).toBe('2.0.0')
    })

    it('updates isPublic', async () => {
      const created = await store.create({
        slug: 'upd-public',
        name: 'Public',
        description: null,
        version: '1.0.0',
        tags: [],
        author: null,
        readme: null,
        publishedAt: null,
        isPublic: true,
      })
      const updated = await store.update(created.id, { isPublic: false })
      expect(updated.isPublic).toBe(false)
    })

    it('updates updatedAt timestamp', async () => {
      const created = await store.create({
        slug: 'upd-ts',
        name: 'Timestamps',
        description: null,
        version: '1.0.0',
        tags: [],
        author: null,
        readme: null,
        publishedAt: null,
        isPublic: true,
      })
      // Small delay so updatedAt differs
      await new Promise((r) => setTimeout(r, 5))
      const updated = await store.update(created.id, { name: 'New' })
      expect(updated.updatedAt).not.toBe(created.updatedAt)
      expect(updated.createdAt).toBe(created.createdAt)
    })

    it('throws CatalogNotFoundError for nonexistent id', async () => {
      await expect(
        store.update('nonexistent', { name: 'X' }),
      ).rejects.toThrow(CatalogNotFoundError)
    })

    it('throws CatalogSlugConflictError when slug conflicts with another entry', async () => {
      await store.create({
        slug: 'taken-slug',
        name: 'Taken',
        description: null,
        version: '1.0.0',
        tags: [],
        author: null,
        readme: null,
        publishedAt: null,
        isPublic: true,
      })
      const other = await store.create({
        slug: 'other-slug',
        name: 'Other',
        description: null,
        version: '1.0.0',
        tags: [],
        author: null,
        readme: null,
        publishedAt: null,
        isPublic: true,
      })
      await expect(
        store.update(other.id, { slug: 'taken-slug' }),
      ).rejects.toThrow(CatalogSlugConflictError)
    })

    it('allows updating slug to the same value (no conflict with self)', async () => {
      const created = await store.create({
        slug: 'self-slug',
        name: 'Self',
        description: null,
        version: '1.0.0',
        tags: [],
        author: null,
        readme: null,
        publishedAt: null,
        isPublic: true,
      })
      const updated = await store.update(created.id, { slug: 'self-slug', name: 'Self Updated' })
      expect(updated.slug).toBe('self-slug')
      expect(updated.name).toBe('Self Updated')
    })
  })

  // -------------------------------------------------------------------------
  // delete()
  // -------------------------------------------------------------------------

  describe('delete()', () => {
    it('deletes an existing entry', async () => {
      const created = await store.create({
        slug: 'del-1',
        name: 'Delete Me',
        description: null,
        version: '1.0.0',
        tags: [],
        author: null,
        readme: null,
        publishedAt: null,
        isPublic: true,
      })
      await store.delete(created.id)
      const found = await store.getById(created.id)
      expect(found).toBeNull()
    })

    it('throws CatalogNotFoundError for nonexistent id', async () => {
      await expect(store.delete('nonexistent')).rejects.toThrow(CatalogNotFoundError)
    })

    it('allows slug reuse after deletion', async () => {
      const created = await store.create({
        slug: 'reusable',
        name: 'First',
        description: null,
        version: '1.0.0',
        tags: [],
        author: null,
        readme: null,
        publishedAt: null,
        isPublic: true,
      })
      await store.delete(created.id)
      const second = await store.create({
        slug: 'reusable',
        name: 'Second',
        description: null,
        version: '2.0.0',
        tags: [],
        author: null,
        readme: null,
        publishedAt: null,
        isPublic: true,
      })
      expect(second.slug).toBe('reusable')
      expect(second.name).toBe('Second')
    })
  })

  // -------------------------------------------------------------------------
  // search()
  // -------------------------------------------------------------------------

  describe('search()', () => {
    beforeEach(async () => {
      // Seed with test data
      await store.create({
        slug: 'text-summarizer',
        name: 'Text Summarizer',
        description: 'Summarizes long documents into concise text',
        version: '1.0.0',
        tags: ['nlp', 'summarization'],
        author: 'alice',
        readme: null,
        publishedAt: null,
        isPublic: true,
      })
      await store.create({
        slug: 'code-reviewer',
        name: 'Code Reviewer',
        description: 'Reviews code for bugs and style issues',
        version: '2.0.0',
        tags: ['code', 'review'],
        author: 'bob',
        readme: null,
        publishedAt: null,
        isPublic: true,
      })
      await store.create({
        slug: 'doc-generator',
        name: 'Doc Generator',
        description: 'Generates documentation from code',
        version: '1.5.0',
        tags: ['code', 'documentation'],
        author: 'alice',
        readme: null,
        publishedAt: null,
        isPublic: true,
      })
      await store.create({
        slug: 'sentiment-analyzer',
        name: 'Sentiment Analyzer',
        description: 'Analyzes text sentiment',
        version: '3.0.0',
        tags: ['nlp', 'sentiment'],
        author: 'charlie',
        readme: null,
        publishedAt: null,
        isPublic: true,
      })
      await store.create({
        slug: 'translator',
        name: 'Translator',
        description: 'Translates text between languages',
        version: '1.0.0',
        tags: ['nlp', 'translation'],
        author: 'alice',
        readme: null,
        publishedAt: null,
        isPublic: true,
      })
    })

    it('returns all entries with empty query', async () => {
      const result = await store.search({})
      expect(result.total).toBe(5)
      expect(result.items).toHaveLength(5)
    })

    it('searches by q on name (case-insensitive)', async () => {
      const result = await store.search({ q: 'summarizer' })
      expect(result.total).toBe(1)
      expect(result.items[0]!.slug).toBe('text-summarizer')
    })

    it('searches by q on description (case-insensitive)', async () => {
      const result = await store.search({ q: 'DOCUMENTATION' })
      expect(result.total).toBe(1)
      expect(result.items[0]!.slug).toBe('doc-generator')
    })

    it('searches by q matching multiple entries', async () => {
      const result = await store.search({ q: 'text' })
      // 'Text Summarizer' (name), 'Analyzes text sentiment' (desc), 'Translates text' (desc)
      expect(result.total).toBe(3)
    })

    it('filters by single tag', async () => {
      const result = await store.search({ tags: ['code'] })
      expect(result.total).toBe(2)
      const slugs = result.items.map((i) => i.slug).sort()
      expect(slugs).toEqual(['code-reviewer', 'doc-generator'])
    })

    it('filters by multiple tags (overlap/OR)', async () => {
      const result = await store.search({ tags: ['summarization', 'sentiment'] })
      expect(result.total).toBe(2)
    })

    it('filters by author', async () => {
      const result = await store.search({ author: 'alice' })
      expect(result.total).toBe(3)
    })

    it('combines q and tags filters', async () => {
      const result = await store.search({ q: 'code', tags: ['code'] })
      expect(result.total).toBe(2)
    })

    it('combines q and author filters', async () => {
      const result = await store.search({ q: 'text', author: 'alice' })
      // 'Text Summarizer' by alice, 'Translator' by alice ('Translates text')
      expect(result.total).toBe(2)
    })

    it('combines tags and author filters', async () => {
      const result = await store.search({ tags: ['nlp'], author: 'alice' })
      // text-summarizer (alice, nlp), translator (alice, nlp)
      expect(result.total).toBe(2)
    })

    it('combines q, tags, and author', async () => {
      const result = await store.search({ q: 'Summarizer', tags: ['nlp'], author: 'alice' })
      expect(result.total).toBe(1)
      expect(result.items[0]!.slug).toBe('text-summarizer')
    })

    it('returns empty when no matches', async () => {
      const result = await store.search({ q: 'nonexistent' })
      expect(result.total).toBe(0)
      expect(result.items).toHaveLength(0)
    })

    it('returns empty when tag does not match', async () => {
      const result = await store.search({ tags: ['nonexistent-tag'] })
      expect(result.total).toBe(0)
    })

    it('returns empty when author does not match', async () => {
      const result = await store.search({ author: 'nobody' })
      expect(result.total).toBe(0)
    })

    // -- Pagination --

    it('defaults to limit=20, page=1', async () => {
      const result = await store.search({})
      expect(result.items).toHaveLength(5) // all 5 fit in default limit
    })

    it('paginates with limit=2, page=1', async () => {
      const result = await store.search({ limit: 2, page: 1 })
      expect(result.items).toHaveLength(2)
      expect(result.total).toBe(5)
    })

    it('paginates with limit=2, page=2', async () => {
      const result = await store.search({ limit: 2, page: 2 })
      expect(result.items).toHaveLength(2)
      expect(result.total).toBe(5)
    })

    it('paginates with limit=2, page=3 (last page)', async () => {
      const result = await store.search({ limit: 2, page: 3 })
      expect(result.items).toHaveLength(1)
      expect(result.total).toBe(5)
    })

    it('returns empty items for page beyond range', async () => {
      const result = await store.search({ limit: 2, page: 100 })
      expect(result.items).toHaveLength(0)
      expect(result.total).toBe(5)
    })

    it('clamps limit to max 100', async () => {
      const result = await store.search({ limit: 500 })
      // All 5 entries returned (within max 100 limit)
      expect(result.items).toHaveLength(5)
    })

    it('clamps limit to min 1', async () => {
      const result = await store.search({ limit: 0 })
      expect(result.items).toHaveLength(1)
    })

    it('clamps page to min 1', async () => {
      const result = await store.search({ page: -1 })
      expect(result.items).toHaveLength(5)
    })
  })
})
