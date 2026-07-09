import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

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

/**
 * Walk up the parent_id chain of folders starting from `parentId`.
 * Returns true if any ancestor folder is soft-deleted OR no longer exists
 * (i.e. the restored node would be unreachable in the binder). A null
 * `parentId` means the node is already at the root — chain is intact.
 */
export function hasBrokenAncestorChain(db: Database.Database, parentId: string | null | undefined): boolean {
	let currentId = parentId ?? null;
	const seen = new Set<string>();
	while (currentId) {
		if (seen.has(currentId)) return true; // defensive: cycle
		seen.add(currentId);
		const parent = db
			.prepare('SELECT id, parent_id, deleted_at FROM folders WHERE id = ?')
			.get(currentId) as { id: string; parent_id: string | null; deleted_at: string | null } | undefined;
		if (!parent) return true; // ancestor row missing
		if (parent.deleted_at) return true; // ancestor still trashed
		currentId = parent.parent_id;
	}
	return false;
}

/**
 * Permanently purge a single document: FTS row, snapshot rows, content file,
 * and snapshot directory. Shared by the document and folder purge paths so
 * file cleanup lives in one place.
 */
export function purgeDocument(
	db: Database.Database,
	dataRoot: string,
	doc: { id: string; novel_id: string }
) {
	db.prepare('DELETE FROM documents_fts WHERE doc_id = ?').run(doc.id);
	db.prepare('DELETE FROM snapshots WHERE document_id = ?').run(doc.id);

	const docFile = path.join(dataRoot, doc.novel_id, 'docs', `${doc.id}.html`);
	if (fs.existsSync(docFile)) fs.unlinkSync(docFile);
	const snapDir = path.join(dataRoot, doc.novel_id, 'snapshots', doc.id);
	if (fs.existsSync(snapDir)) fs.rmSync(snapDir, { recursive: true, force: true });

	db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
}

/**
 * Recursively purge a folder and every descendant folder/document, cleaning up
 * their FTS rows, snapshot rows, content files and snapshot dirs. Mirrors
 * cascadeDeleteChildren but for permanent deletion. Descendants are matched by
 * parent_id regardless of deleted_at, since the whole subtree is being removed.
 * Call inside a transaction.
 */
export function purgeFolderRecursive(db: Database.Database, dataRoot: string, folderId: string) {
	const childDocs = db
		.prepare('SELECT id, novel_id FROM documents WHERE parent_id = ?')
		.all(folderId) as { id: string; novel_id: string }[];
	for (const doc of childDocs) {
		purgeDocument(db, dataRoot, doc);
	}

	const childFolders = db
		.prepare('SELECT id FROM folders WHERE parent_id = ?')
		.all(folderId) as { id: string }[];
	for (const folder of childFolders) {
		purgeFolderRecursive(db, dataRoot, folder.id);
	}

	db.prepare('DELETE FROM folders WHERE id = ?').run(folderId);
}

/** Soft-delete a novel and all its contents. Preserves FTS for restorability. */
export function softDeleteNovel(db: Database.Database, novelId: string, now: string) {
	db.prepare('UPDATE novels SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, novelId);
	db.prepare('UPDATE folders SET deleted_at = ?, updated_at = ? WHERE novel_id = ? AND deleted_at IS NULL').run(now, now, novelId);
	db.prepare('UPDATE documents SET deleted_at = ?, updated_at = ? WHERE novel_id = ? AND deleted_at IS NULL').run(now, now, novelId);
	// FTS entries intentionally preserved — search exclusion handled by checking deleted_at on join
}
