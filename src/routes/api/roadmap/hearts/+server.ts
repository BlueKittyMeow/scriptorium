import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/auth.js';
import { ROADMAP } from '$lib/roadmap-data.js';

// GET /api/roadmap/hearts — every heart, across all users, with usernames.
// Small table, no pagination; the client derives per-item counts and "did I
// heart this" from the flat list.
export const GET: RequestHandler = async ({ locals }) => {
	requireUser(locals);
	const rows = locals.db
		.prepare(
			`SELECT h.item_key, h.user_id, h.created_at, u.username
			 FROM roadmap_hearts h
			 JOIN users u ON u.id = h.user_id
			 ORDER BY h.created_at`
		)
		.all();
	return json(rows);
};

// POST /api/roadmap/hearts { key } — toggles the current user's heart for a
// roadmap item: insert if absent, delete if present. `key` must reference a
// real ROADMAP entry — validated against the shared data file (imported
// server-side here) so a typo'd key can't create an orphaned heart.
export const POST: RequestHandler = async ({ request, locals }) => {
	const user = requireUser(locals);
	const body = await request.json();
	const key = body?.key;

	if (typeof key !== 'string' || !ROADMAP.some((item) => item.key === key)) {
		throw error(400, 'key must reference an existing roadmap item');
	}

	const existing = locals.db
		.prepare('SELECT 1 FROM roadmap_hearts WHERE item_key = ? AND user_id = ?')
		.get(key, user.id);

	if (existing) {
		locals.db
			.prepare('DELETE FROM roadmap_hearts WHERE item_key = ? AND user_id = ?')
			.run(key, user.id);
		return json({ hearted: false });
	}

	locals.db
		.prepare('INSERT INTO roadmap_hearts (item_key, user_id, created_at) VALUES (?, ?, ?)')
		.run(key, user.id, new Date().toISOString());
	return json({ hearted: true });
};
