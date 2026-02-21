import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	SESSION_COOKIE_NAME,
	destroyUserSessions,
	requireUser
} from '$lib/server/auth.js';
import { logAction } from '$lib/server/audit.js';

// POST /api/auth/logout-all — destroy all sessions for the current user
export const POST: RequestHandler = async ({ cookies, locals }) => {
	const user = requireUser(locals);

	destroyUserSessions(locals.db, user.id);
	cookies.delete(SESSION_COOKIE_NAME, { path: '/' });

	logAction(locals.db, user.id, 'user.logout_all');

	return json({ success: true });
};
