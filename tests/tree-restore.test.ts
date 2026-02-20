import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb, seedNovelWithDocs } from './helpers.js';
import { cascadeDeleteChildren, restoreChildFts, softDeleteNovel } from '$lib/server/tree-ops.js';

let db: Database.Database;
let novelId: string;
let folderId: string;
let doc1Id: string;
let doc2Id: string;

beforeEach(() => {
	db = createTestDb();
	({ novelId, folderId, doc1Id, doc2Id } = seedNovelWithDocs(db));
});

// Mock readContentFile — in tests, no files on disk, return empty string
const mockReadContent = () => '';
const mockStripHtml = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Bug: Broken FTS re-indexing on folder restore
 *
 * When a folder is soft-deleted, its child docs' FTS entries are removed.
 * When the folder is restored, restoreChildFts should re-insert FTS entries.
 */
describe('folder restore FTS re-indexing', () => {
	it('should re-index child documents in FTS when folder is restored', () => {
		const now = new Date().toISOString();

		// Verify FTS entries exist before deletion
		const ftsBefore = db.prepare('SELECT * FROM documents_fts WHERE doc_id IN (?, ?)').all(doc1Id, doc2Id);
		expect(ftsBefore).toHaveLength(2);

		// --- DELETE folder (cascades to children, removes FTS) ---
		db.prepare('UPDATE folders SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, folderId);
		cascadeDeleteChildren(db, folderId, now);

		// Verify FTS entries are gone
		const ftsAfterDelete = db.prepare('SELECT * FROM documents_fts WHERE doc_id IN (?, ?)').all(doc1Id, doc2Id);
		expect(ftsAfterDelete).toHaveLength(0);

		// --- RESTORE folder ---
		db.prepare('UPDATE folders SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(now, folderId);
		restoreChildFts(db, folderId, now, mockReadContent, mockStripHtml);

		// --- Assert: FTS entries re-created, documents un-deleted ---
		const ftsAfterRestore = db.prepare('SELECT * FROM documents_fts WHERE doc_id IN (?, ?)').all(doc1Id, doc2Id);
		expect(ftsAfterRestore).toHaveLength(2);

		const docs = db.prepare('SELECT deleted_at FROM documents WHERE id IN (?, ?)').all(doc1Id, doc2Id) as any[];
		expect(docs.every((d: any) => d.deleted_at === null)).toBe(true);
	});
});

/**
 * Bug: FTS hard-deleted on novel soft-delete
 *
 * The novel DELETE endpoint should preserve FTS entries when soft-deleting,
 * so that a future restore doesn't leave documents unsearchable.
 */
describe('novel soft-delete FTS preservation', () => {
	it('should preserve FTS entries when novel is soft-deleted', () => {
		const now = new Date().toISOString();

		// Verify FTS entries exist
		const ftsBefore = db.prepare('SELECT * FROM documents_fts WHERE doc_id IN (?, ?)').all(doc1Id, doc2Id);
		expect(ftsBefore).toHaveLength(2);

		// --- Soft-delete novel using shared function ---
		softDeleteNovel(db, novelId, now);

		// FTS entries should still be present (not hard-deleted)
		const ftsAfterDelete = db.prepare('SELECT * FROM documents_fts WHERE doc_id IN (?, ?)').all(doc1Id, doc2Id);
		expect(ftsAfterDelete).toHaveLength(2);

		// --- Restore novel ---
		db.prepare('UPDATE novels SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(now, novelId);
		db.prepare('UPDATE folders SET deleted_at = NULL, updated_at = ? WHERE novel_id = ?').run(now, novelId);
		db.prepare('UPDATE documents SET deleted_at = NULL, updated_at = ? WHERE novel_id = ?').run(now, novelId);

		// FTS entries should still be intact
		const ftsAfterRestore = db.prepare('SELECT * FROM documents_fts WHERE doc_id IN (?, ?)').all(doc1Id, doc2Id);
		expect(ftsAfterRestore).toHaveLength(2);
	});
});
