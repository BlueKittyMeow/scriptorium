import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { v4 as uuid } from 'uuid';
import { readContentFile, writeContentFile, writeSnapshotFile, readSnapshotFile, stripHtml, countWords } from '$lib/server/files.js';

// POST /api/documents/:id/restore/:snapshotId — non-destructive restore
export const POST: RequestHandler = async ({ params, locals }) => {
	const now = new Date().toISOString();

	// 1. Validate document exists and is not deleted
	const doc = locals.db.prepare('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL').get(params.id) as any;
	if (!doc) throw error(404, 'Document not found');

	// 2. Validate snapshot exists and belongs to this document
	const snapshot = locals.db.prepare(
		'SELECT * FROM snapshots WHERE id = ? AND document_id = ?'
	).get(params.snapshotId, params.id) as any;
	if (!snapshot) throw error(404, 'Snapshot not found');

	// 3. Read snapshot content from disk
	const snapshotContent = readSnapshotFile(snapshot.content_path);
	if (snapshotContent === null) throw error(404, 'Snapshot file not found on disk');

	// 4. Read current document content from disk
	const currentContent = readContentFile(doc.novel_id, doc.id) || '';

	// 5. Write pre-restore snapshot file (atomic)
	const preRestoreId = uuid();
	const preRestorePath = writeSnapshotFile(doc.novel_id, doc.id, preRestoreId, currentContent);

	// 6. Write restored content to document file (atomic)
	writeContentFile(doc.novel_id, doc.id, snapshotContent);

	// 7. DB transaction: all metadata updates atomic
	const restoredPlainText = stripHtml(snapshotContent);
	const restoredWordCount = countWords(restoredPlainText);
	const currentWordCount = countWords(stripHtml(currentContent));

	const doRestore = locals.db.transaction(() => {
		// 7a. Insert pre-restore snapshot row
		locals.db.prepare(`
			INSERT INTO snapshots (id, document_id, content_path, word_count, reason, created_at)
			VALUES (?, ?, ?, ?, ?, ?)
		`).run(preRestoreId, doc.id, preRestorePath, currentWordCount, 'pre-restore', now);

		// 7b. Update document metadata
		locals.db.prepare(`
			UPDATE documents SET word_count = ?, updated_at = ?, last_snapshot_at = ? WHERE id = ?
		`).run(restoredWordCount, now, now, doc.id);

		// 7c. Update FTS index with restored plain text
		locals.db.prepare('DELETE FROM documents_fts WHERE doc_id = ?').run(doc.id);
		locals.db.prepare('INSERT INTO documents_fts (doc_id, title, content) VALUES (?, ?, ?)').run(
			doc.id, doc.title, restoredPlainText
		);
	});
	doRestore();

	// 8. Return updated document + pre-restore snapshot ID
	const updated = locals.db.prepare('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL').get(params.id);
	return json({ document: updated, pre_restore_snapshot_id: preRestoreId });
};
