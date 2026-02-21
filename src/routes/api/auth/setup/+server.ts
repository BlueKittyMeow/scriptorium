import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import crypto from 'crypto';
import { hashPassword } from '$lib/server/auth.js';

export const POST: RequestHandler = async ({ request, locals }) => {
	// Only works when zero users exist
	const userCount = locals.db
		.prepare('SELECT COUNT(*) as c FROM users')
		.get() as { c: number };

	if (userCount.c > 0) {
		throw error(403, 'Setup already complete');
	}

	const body = await request.json();
	const username = typeof body.username === 'string' ? body.username.trim() : '';
	const password = typeof body.password === 'string' ? body.password : '';

	if (!username) {
		throw error(400, 'Username is required');
	}
	if (password.length < 8) {
		throw error(400, 'Password must be at least 8 characters');
	}

	const id = crypto.randomUUID();
	const passwordHash = await hashPassword(password);
	const now = new Date().toISOString();

	locals.db.prepare(
		`INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
		 VALUES (?, ?, ?, 'archivist', ?, ?)`
	).run(id, username, passwordHash, now, now);

	return json({ success: true }, { status: 201 });
};
