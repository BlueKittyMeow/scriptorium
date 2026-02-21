import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import fs from 'fs';
import { requireUser } from '$lib/server/auth.js';

// GET /api/documents/:id/snapshots/:snapId — read snapshot content
export const GET: RequestHandler = async ({ params, locals }) => {
	requireUser(locals);
	// Verify the parent document exists and is not soft-deleted
	const doc = locals.db.prepare('SELECT id FROM documents WHERE id = ? AND deleted_at IS NULL').get(params.id);
	if (!doc) throw error(404, 'Document not found');

	const snapshot = locals.db.prepare(
		'SELECT * FROM snapshots WHERE id = ? AND document_id = ?'
	).get(params.snapId, params.id) as any;

	if (!snapshot) throw error(404, 'Snapshot not found');

	let content = '';
	try {
		content = fs.readFileSync(snapshot.content_path, 'utf-8');
	} catch {
		throw error(404, 'Snapshot file not found on disk');
	}

	return json({ ...snapshot, content });
};
