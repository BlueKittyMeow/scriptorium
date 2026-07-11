import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { v4 as uuid } from 'uuid';
import { requireUser } from '$lib/server/auth.js';
import { logAction } from '$lib/server/audit.js';
import { assertValidFeedbackType, assertValidFeedbackTitle } from '$lib/server/validate.js';

// GET /api/feedback — full list, newest first, author username joined in.
// No role gating (household transparency; the per-novel access-level work
// in docs/ux-and-stats-ideas.md §C.1 will revisit permissions broadly).
// Any signed-in user may read every request/bug/question — same spirit as
// GET /api/collections.
export const GET: RequestHandler = async ({ locals }) => {
	requireUser(locals);
	const rows = locals.db
		.prepare(
			`SELECT f.*, u.username AS author_username
			 FROM feedback f
			 JOIN users u ON u.id = f.author_id
			 ORDER BY f.created_at DESC`
		)
		.all();
	return json(rows);
};

// POST /api/feedback { type, title, body? } — file a feature request, bug
// report, or question. The author is always the caller — unlike novel/
// collection ownership there is no impersonation picker here, so any
// author_id in the payload is ignored.
export const POST: RequestHandler = async ({ request, locals }) => {
	const user = requireUser(locals);
	const body = await request.json();

	const type = assertValidFeedbackType(body.type);
	const title = assertValidFeedbackTitle(body.title);

	let details: string | null = null;
	if (body.body !== undefined && body.body !== null) {
		if (typeof body.body !== 'string') {
			throw error(400, 'body must be a string');
		}
		details = body.body.trim() ? body.body.trim() : null;
	}

	const id = uuid();
	const now = new Date().toISOString();

	locals.db
		.prepare(
			`INSERT INTO feedback (id, author_id, type, title, body, status, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`
		)
		.run(id, user.id, type, title, details, now, now);

	logAction(locals.db, user.id, 'feedback.create', 'feedback', id, title);

	const row = locals.db
		.prepare(
			`SELECT f.*, u.username AS author_username
			 FROM feedback f
			 JOIN users u ON u.id = f.author_id
			 WHERE f.id = ?`
		)
		.get(id);
	return json(row, { status: 201 });
};
