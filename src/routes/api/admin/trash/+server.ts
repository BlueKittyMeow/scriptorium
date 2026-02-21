import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireArchivist } from '$lib/server/auth.js';

// GET /api/admin/trash — list all soft-deleted items
export const GET: RequestHandler = async ({ locals }) => {
	requireArchivist(locals);

	const novels = locals.db.prepare(
		`SELECT id, title, 'novel' as type, deleted_at FROM novels WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`
	).all();

	const folders = locals.db.prepare(
		`SELECT f.id, f.title, 'folder' as type, f.deleted_at, n.title as novel_title
		 FROM folders f JOIN novels n ON f.novel_id = n.id
		 WHERE f.deleted_at IS NOT NULL ORDER BY f.deleted_at DESC`
	).all();

	const documents = locals.db.prepare(
		`SELECT d.id, d.title, 'document' as type, d.deleted_at, n.title as novel_title
		 FROM documents d JOIN novels n ON d.novel_id = n.id
		 WHERE d.deleted_at IS NOT NULL ORDER BY d.deleted_at DESC`
	).all();

	return json({ items: [...novels, ...folders, ...documents] });
};
