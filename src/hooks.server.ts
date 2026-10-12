import { getDb } from '$lib/server/db.js';
import {
	SESSION_COOKIE_NAME,
	validateSession,
	extendSession,
	hashSessionToken,
	sessionCookieOptions
} from '$lib/server/auth.js';
import type { Handle, HandleServerError } from '@sveltejs/kit';
import { publicServerError } from '$lib/server/errors.js';

export const handleError: HandleServerError = ({ error, status }) => {
	if (status === 404) return { message: 'This address does not match a Scriptorium page. Return to the library to find your writing.' };
	const failure = publicServerError(error);
	// Operational signal only. Never log requests, cookies, SQL, or document bodies.
	console.error('Scriptorium request failed', { status, code: failure.code });
	return failure;
};

export const handle: Handle = async ({ event, resolve }) => {
	// The empty offline shell contains no server data and works even if storage fails.
	if (event.url.pathname === '/offline' || event.url.pathname === '/offline/__data.json') return resolve(event);
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
				const expiresAt = extendSession(event.locals.db, tokenHash, new Date(row.expires_at));
				event.cookies.set(SESSION_COOKIE_NAME, sessionToken, sessionCookieOptions(event.url, expiresAt));
			}
		} else {
			// Invalid or expired session — clear the cookie
			event.cookies.delete(SESSION_COOKIE_NAME, { path: '/' });
		}
	}

	return resolve(event);
};
