import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/auth.js';
import { readContentFile, readSnapshotFile, stripHtml } from '$lib/server/files.js';
import { computeContentDiff } from '$lib/server/compare/diff.js';

// GET /api/documents/:id/snapshots/:snapId/diff — word-level diff of
// snapshot content (side A, "old") vs current document content (side B, "new")
export const GET: RequestHandler = async ({ params, locals }) => {
	requireUser(locals);
	// Verify the parent document exists and is not soft-deleted
	const doc = locals.db.prepare('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL').get(params.id) as any;
	if (!doc) throw error(404, 'Document not found');

	const snapshot = locals.db.prepare(
		'SELECT * FROM snapshots WHERE id = ? AND document_id = ?'
	).get(params.snapId, params.id) as any;
	if (!snapshot) throw error(404, 'Snapshot not found');

	const snapshotHtml = readSnapshotFile(snapshot.content_path);
	if (snapshotHtml === null) throw error(404, 'Snapshot file not found on disk');

	const currentHtml = readContentFile(doc.novel_id, doc.id) || '';

	const diff = computeContentDiff(stripHtml(snapshotHtml), stripHtml(currentHtml));

	return json({
		...diff,
		reason: snapshot.reason,
		created_at: snapshot.created_at
	});
};
