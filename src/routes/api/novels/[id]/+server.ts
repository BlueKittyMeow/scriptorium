import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { softDeleteNovel } from '$lib/server/tree-ops.js';
import { requireUser } from '$lib/server/auth.js';

// GET /api/novels/:id
export const GET: RequestHandler = async ({ params, locals }) => {
	requireUser(locals);
	const novel = locals.db.prepare(`
		SELECT n.*, COALESCE(SUM(d.word_count), 0) as total_word_count
		FROM novels n
		LEFT JOIN documents d ON d.novel_id = n.id AND d.deleted_at IS NULL
		WHERE n.id = ? AND n.deleted_at IS NULL
		GROUP BY n.id
	`).get(params.id);

	if (!novel) throw error(404, 'Novel not found');
	return json(novel);
};

// PUT /api/novels/:id — update novel metadata
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals);
	const body = await request.json();
	const now = new Date().toISOString();

	const existing = locals.db.prepare('SELECT * FROM novels WHERE id = ? AND deleted_at IS NULL').get(params.id);
	if (!existing) throw error(404, 'Novel not found');

	locals.db.prepare(`
		UPDATE novels SET
			title = COALESCE(?, title),
			subtitle = COALESCE(?, subtitle),
			status = COALESCE(?, status),
			word_count_target = COALESCE(?, word_count_target),
			updated_at = ?
		WHERE id = ?
	`).run(body.title, body.subtitle, body.status, body.word_count_target, now, params.id);

	const novel = locals.db.prepare('SELECT * FROM novels WHERE id = ?').get(params.id);
	return json(novel);
};

// DELETE /api/novels/:id — soft-delete
export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireUser(locals);
	const now = new Date().toISOString();

	const existing = locals.db.prepare('SELECT * FROM novels WHERE id = ? AND deleted_at IS NULL').get(params.id);
	if (!existing) throw error(404, 'Novel not found');

	const doSoftDelete = locals.db.transaction(() => {
		softDeleteNovel(locals.db, params.id, now);
	});
	doSoftDelete();

	return json({ success: true });
};
