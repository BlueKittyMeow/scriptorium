import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/auth.js';
import { logAction } from '$lib/server/audit.js';
import { assertValidFeedbackStatus } from '$lib/server/validate.js';

// PUT /api/feedback/:id { status?, response? } — both fields optional and
// distinguished by key presence (omitted = untouched, same convention as
// PUT /api/novels/:id's collection_id/stack_label). response: null clears
// it explicitly.
//
// LOOSENESS (documented, not an oversight): the archivist-only status-select
// + response-textarea controls live client-side (src/routes/help/
// +page.svelte) — this endpoint itself accepts the request from an
// archivist OR a writer, because a writer's "Reply" affordance on
// question-type items also PUTs here (it sets response and status:
// 'answered'). Full role gating awaits the per-novel access-level work
// (docs/ux-and-stats-ideas.md §C.1); until then, household transparency
// means anyone signed in can move a feedback item's status forward.
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals);
	const body = await request.json();

	const existing = locals.db.prepare('SELECT * FROM feedback WHERE id = ?').get(params.id) as
		| { status: string; response: string | null }
		| undefined;
	if (!existing) throw error(404, 'Feedback item not found');

	const now = new Date().toISOString();

	let status = existing.status;
	if ('status' in body) {
		status = assertValidFeedbackStatus(body.status);
	}

	let response = existing.response;
	if ('response' in body) {
		if (body.response === null) {
			response = null;
		} else if (typeof body.response === 'string') {
			response = body.response;
		} else {
			throw error(400, 'response must be a string or null');
		}
	}

	locals.db
		.prepare('UPDATE feedback SET status = ?, response = ?, updated_at = ? WHERE id = ?')
		.run(status, response, now, params.id);

	logAction(locals.db, locals.user!.id, 'feedback.update', 'feedback', params.id);

	const updated = locals.db
		.prepare(
			`SELECT f.*, u.username AS author_username
			 FROM feedback f
			 JOIN users u ON u.id = f.author_id
			 WHERE f.id = ?`
		)
		.get(params.id);
	return json(updated);
};
