import type Database from 'better-sqlite3';

/** Cascade soft-delete a folder and all its children. Removes FTS entries. */
export function cascadeDeleteChildren(db: Database.Database, folderId: string, now: string) {
	const childDocs = db.prepare('SELECT id FROM documents WHERE parent_id = ? AND deleted_at IS NULL').all(folderId) as { id: string }[];
	for (const doc of childDocs) {
		db.prepare('UPDATE documents SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, doc.id);
		db.prepare('DELETE FROM documents_fts WHERE doc_id = ?').run(doc.id);
	}

	const childFolders = db.prepare('SELECT id FROM folders WHERE parent_id = ? AND deleted_at IS NULL').all(folderId) as { id: string }[];
	for (const folder of childFolders) {
		db.prepare('UPDATE folders SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, folder.id);
		cascadeDeleteChildren(db, folder.id, now);
	}
}

/** Re-index a single document in FTS */
export function reindexDocFts(
	db: Database.Database,
	doc: { id: string; title: string; novel_id: string },
	readContentFile: (novelId: string, docId: string) => string | null,
	stripHtml: (html: string) => string
) {
	const content = readContentFile(doc.novel_id, doc.id) || '';
	const plainText = stripHtml(content);
	db.prepare('DELETE FROM documents_fts WHERE doc_id = ?').run(doc.id);
	db.prepare('INSERT INTO documents_fts (doc_id, title, content) VALUES (?, ?, ?)').run(doc.id, doc.title, plainText);
}

/** Restore a folder's children from trash, re-indexing FTS for each document */
export function restoreChildFts(
	db: Database.Database,
	folderId: string,
	now: string,
	readContentFile: (novelId: string, docId: string) => string | null,
	stripHtml: (html: string) => string
) {
	const childDocs = db.prepare('SELECT id, title, novel_id FROM documents WHERE parent_id = ? AND deleted_at IS NOT NULL').all(folderId) as any[];
	for (const doc of childDocs) {
		db.prepare('UPDATE documents SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(now, doc.id);
		reindexDocFts(db, doc, readContentFile, stripHtml);
	}
	const childFolders = db.prepare('SELECT id FROM folders WHERE parent_id = ? AND deleted_at IS NOT NULL').all(folderId) as any[];
	for (const folder of childFolders) {
		db.prepare('UPDATE folders SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(now, folder.id);
		restoreChildFts(db, folder.id, now, readContentFile, stripHtml);
	}
}

/** Soft-delete a novel and all its contents. Preserves FTS for restorability. */
export function softDeleteNovel(db: Database.Database, novelId: string, now: string) {
	db.prepare('UPDATE novels SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, novelId);
	db.prepare('UPDATE folders SET deleted_at = ?, updated_at = ? WHERE novel_id = ? AND deleted_at IS NULL').run(now, now, novelId);
	db.prepare('UPDATE documents SET deleted_at = ?, updated_at = ? WHERE novel_id = ? AND deleted_at IS NULL').run(now, now, novelId);
	// FTS entries intentionally preserved — search exclusion handled by checking deleted_at on join
}
