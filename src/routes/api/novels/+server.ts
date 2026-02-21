import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { v4 as uuid } from 'uuid';
import { ensureNovelDirs } from '$lib/server/files.js';
import { requireUser } from '$lib/server/auth.js';
import { logAction } from '$lib/server/audit.js';

// GET /api/novels — list all non-deleted novels
export const GET: RequestHandler = async ({ locals }) => {
	requireUser(locals);
	const novels = locals.db.prepare(`
		SELECT n.*, COALESCE(SUM(d.word_count), 0) as total_word_count
		FROM novels n
		LEFT JOIN documents d ON d.novel_id = n.id AND d.deleted_at IS NULL
		WHERE n.deleted_at IS NULL
		GROUP BY n.id
		ORDER BY n.updated_at DESC
	`).all();
	return json(novels);
};

// POST /api/novels — create a new novel
export const POST: RequestHandler = async ({ request, locals }) => {
	requireUser(locals);
	const body = await request.json();
	const id = uuid();
	const now = new Date().toISOString();

	locals.db.prepare(`
		INSERT INTO novels (id, title, subtitle, status, word_count_target, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`).run(id, body.title || 'Untitled Novel', body.subtitle || null, body.status || 'draft', body.word_count_target || null, now, now);

	ensureNovelDirs(id);

	logAction(locals.db, locals.user!.id, 'novel.create', 'novel', id, `Created "${body.title || 'Untitled Novel'}"`);

	const novel = locals.db.prepare('SELECT * FROM novels WHERE id = ?').get(id);
	return json(novel, { status: 201 });
};
