import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import crypto from 'crypto';
import { requireArchivist, hashPassword } from '$lib/server/auth.js';
import { logAction } from '$lib/server/audit.js';

// GET /api/admin/users — list all users
export const GET: RequestHandler = async ({ locals }) => {
	requireArchivist(locals);

	const users = locals.db
		.prepare('SELECT id, username, role, created_at, updated_at FROM users ORDER BY created_at')
		.all();

	return json({ users });
};

// POST /api/admin/users — create a new user
export const POST: RequestHandler = async ({ request, locals }) => {
	requireArchivist(locals);

	const body = await request.json();
	const username = typeof body.username === 'string' ? body.username.trim() : '';
	const password = typeof body.password === 'string' ? body.password : '';
	const role = body.role === 'archivist' ? 'archivist' : 'writer';

	if (!username) {
		throw error(400, 'Username is required');
	}
	if (password.length < 8) {
		throw error(400, 'Password must be at least 8 characters');
	}

	// Check for duplicate username
	const existing = locals.db
		.prepare('SELECT id FROM users WHERE username = ?')
		.get(username);
	if (existing) {
		throw error(409, 'Username already exists');
	}

	const id = crypto.randomUUID();
	const passwordHash = await hashPassword(password);
	const now = new Date().toISOString();

	locals.db.prepare(
		`INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`
	).run(id, username, passwordHash, role, now, now);

	logAction(locals.db, locals.user!.id, 'user.create', 'user', id, `Created ${role} "${username}"`);

	return json({ user: { id, username, role, created_at: now, updated_at: now } }, { status: 201 });
};
