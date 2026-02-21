import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { v4 as uuid } from 'uuid';
import { readContentFile, writeSnapshotFile, countWords, stripHtml } from '$lib/server/files.js';
import { requireUser } from '$lib/server/auth.js';

// GET /api/documents/:id/snapshots — list snapshots (paginated)
export const GET: RequestHandler = async ({ params, locals, url }) => {
	requireUser(locals);
	const doc = locals.db.prepare('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL').get(params.id);
	if (!doc) throw error(404, 'Document not found');

	const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 100);
	const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);

	const snapshots = locals.db.prepare(
		'SELECT id, document_id, word_count, reason, created_at FROM snapshots WHERE document_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?'
	).all(params.id, limit, offset);

	return json(snapshots);
};

// POST /api/documents/:id/snapshots — manual snapshot
export const POST: RequestHandler = async ({ params, locals }) => {
	requireUser(locals);
	const doc = locals.db.prepare('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL').get(params.id) as any;
	if (!doc) throw error(404, 'Document not found');

	const content = readContentFile(doc.novel_id, doc.id) || '';
	const now = new Date().toISOString();
	const snapId = uuid();
	const wordCount = countWords(stripHtml(content));
	const snapPath = writeSnapshotFile(doc.novel_id, doc.id, snapId, content);

	const createSnapshot = locals.db.transaction(() => {
		locals.db.prepare(`
			INSERT INTO snapshots (id, document_id, content_path, word_count, reason, created_at)
			VALUES (?, ?, ?, ?, ?, ?)
		`).run(snapId, doc.id, snapPath, wordCount, 'manual', now);

		locals.db.prepare('UPDATE documents SET last_snapshot_at = ? WHERE id = ?').run(now, doc.id);
	});
	createSnapshot();

	return json({ id: snapId, document_id: doc.id, word_count: wordCount, reason: 'manual', created_at: now }, { status: 201 });
};
