import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { v4 as uuid } from 'uuid';
import { writeContentFile } from '$lib/server/files.js';
import { requireUser } from '$lib/server/auth.js';

// POST /api/novels/:id/tree/nodes — create a folder or document
export const POST: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals);
	const body = await request.json();
	const id = uuid();
	const now = new Date().toISOString();

	const novel = locals.db.prepare('SELECT * FROM novels WHERE id = ? AND deleted_at IS NULL').get(params.id);
	if (!novel) throw error(404, 'Novel not found');

	if (body.type === 'folder') {
		locals.db.prepare(`
			INSERT INTO folders (id, novel_id, parent_id, title, folder_type, sort_order, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`).run(id, params.id, body.parent_id || null, body.title || 'New Folder', body.folder_type || null, body.sort_order ?? 1.0, now, now);

		const folder = locals.db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
		return json({ ...folder, type: 'folder' }, { status: 201 });
	} else {
		locals.db.prepare(`
			INSERT INTO documents (id, novel_id, parent_id, title, sort_order, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`).run(id, params.id, body.parent_id || null, body.title || 'Untitled', body.sort_order ?? 1.0, now, now);

		// Create empty content file
		writeContentFile(params.id, id, '');

		// Add to FTS
		locals.db.prepare('INSERT INTO documents_fts (doc_id, title, content) VALUES (?, ?, ?)').run(id, body.title || 'Untitled', '');

		const doc = locals.db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
		return json({ ...doc, type: 'document' }, { status: 201 });
	}
};
