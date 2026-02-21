import { getDb } from '$lib/server/db.js';
import {
	SESSION_COOKIE_NAME,
	validateSession,
	extendSession,
	hashSessionToken
} from '$lib/server/auth.js';
import type { Handle } from '@sveltejs/kit';

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.db = getDb();
	event.locals.user = null;

	const sessionToken = event.cookies.get(SESSION_COOKIE_NAME);

	if (sessionToken) {
		const result = await validateSession(event.locals.db, sessionToken);
		if (result) {
			event.locals.user = result.user;

			// Sliding expiry — only extend when within 7 days of expiry
			const tokenHash = hashSessionToken(sessionToken);
			const row = event.locals.db
				.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?')
				.get(tokenHash) as { expires_at: string } | undefined;

			if (row) {
				extendSession(event.locals.db, tokenHash, new Date(row.expires_at));
			}
		} else {
			// Invalid or expired session — clear the cookie
			event.cookies.delete(SESSION_COOKIE_NAME, { path: '/' });
		}
	}

	return resolve(event);
};
