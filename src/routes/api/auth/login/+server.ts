import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	verifyPassword,
	createSession,
	cleanExpiredSessions,
	SESSION_COOKIE_NAME,
	SESSION_MAX_AGE
} from '$lib/server/auth.js';

// Simple in-memory rate limiting: 5 attempts per minute per IP
const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60 * 1000;

function checkRateLimit(ip: string): boolean {
	const now = Date.now();
	const entry = attempts.get(ip);

	if (!entry || now > entry.resetAt) {
		attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
		return true;
	}

	if (entry.count >= MAX_ATTEMPTS) {
		return false;
	}

	entry.count++;
	return true;
}

export const POST: RequestHandler = async ({ request, locals, cookies, getClientAddress }) => {
	const ip = getClientAddress();
	if (!checkRateLimit(ip)) {
		throw error(429, 'Too many login attempts. Try again in a minute.');
	}

	const body = await request.json();
	const username = typeof body.username === 'string' ? body.username.trim() : '';
	const password = typeof body.password === 'string' ? body.password : '';

	if (!username || !password) {
		throw error(400, 'Username and password are required');
	}

	const user = locals.db
		.prepare('SELECT id, username, password_hash, role FROM users WHERE username = ?')
		.get(username) as { id: string; username: string; password_hash: string; role: string } | undefined;

	if (!user) {
		throw error(401, 'Invalid credentials');
	}

	const valid = await verifyPassword(password, user.password_hash);
	if (!valid) {
		throw error(401, 'Invalid credentials');
	}

	// Clean expired sessions on login (housekeeping)
	cleanExpiredSessions(locals.db);

	const session = await createSession(locals.db, user.id);

	// Determine if we should set secure flag
	const host = request.headers.get('host') || '';
	const isLocalhost = host.startsWith('localhost') || host.startsWith('127.0.0.1');

	cookies.set(SESSION_COOKIE_NAME, session.token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: !isLocalhost,
		maxAge: SESSION_MAX_AGE
	});

	return json({
		user: {
			id: user.id,
			username: user.username,
			role: user.role
		}
	});
};
