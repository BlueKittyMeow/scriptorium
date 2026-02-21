import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	SESSION_COOKIE_NAME,
	hashSessionToken,
	destroySession
} from '$lib/server/auth.js';

export const POST: RequestHandler = async ({ cookies, locals }) => {
	const token = cookies.get(SESSION_COOKIE_NAME);

	if (token) {
		const tokenHash = hashSessionToken(token);
		destroySession(locals.db, tokenHash);
		cookies.delete(SESSION_COOKIE_NAME, { path: '/' });
	}

	return json({ success: true });
};
