import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import fs from 'fs';

// GET /api/documents/:id/snapshots/:snapId — read snapshot content
export const GET: RequestHandler = async ({ params, locals }) => {
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
