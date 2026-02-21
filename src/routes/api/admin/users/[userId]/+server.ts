import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireArchivist, hashPassword, destroyUserSessions } from '$lib/server/auth.js';

// PATCH /api/admin/users/:userId — update user (password, role)
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	requireArchivist(locals);

	const { userId } = params;
	const body = await request.json();

	const user = locals.db
		.prepare('SELECT id, username, role FROM users WHERE id = ?')
		.get(userId) as { id: string; username: string; role: string } | undefined;

	if (!user) {
		throw error(404, 'User not found');
	}

	const updates: string[] = [];
	const values: any[] = [];

	// Password change
	if (body.password && typeof body.password === 'string') {
		if (body.password.length < 8) {
			throw error(400, 'Password must be at least 8 characters');
		}
		const passwordHash = await hashPassword(body.password);
		updates.push('password_hash = ?');
		values.push(passwordHash);
	}

	// Role change — must check last-archivist constraint in a transaction
	if (body.role && body.role !== user.role) {
		if (body.role !== 'writer' && body.role !== 'archivist') {
			throw error(400, 'Invalid role');
		}

		if (user.role === 'archivist' && body.role === 'writer') {
			// Demoting an archivist — check we're not the last one
			const archivistCount = locals.db
				.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'archivist'")
				.get() as { c: number };

			if (archivistCount.c <= 1) {
				throw error(400, 'Cannot demote the last archivist');
			}
		}

		updates.push('role = ?');
		values.push(body.role);
	}

	if (updates.length === 0) {
		throw error(400, 'No changes specified');
	}

	updates.push('updated_at = ?');
	values.push(new Date().toISOString());
	values.push(userId);

	// Wrap in transaction for atomicity (especially the last-archivist check)
	locals.db.transaction(() => {
		// Re-check last archivist inside transaction to prevent race condition
		if (body.role === 'writer' && user.role === 'archivist') {
			const archivistCount = locals.db
				.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'archivist'")
				.get() as { c: number };
			if (archivistCount.c <= 1) {
				throw error(400, 'Cannot demote the last archivist');
			}
		}

		locals.db.prepare(
			`UPDATE users SET ${updates.join(', ')} WHERE id = ?`
		).run(...values);

		// Invalidate all sessions for this user on password or role change
		destroyUserSessions(locals.db, userId);
	})();

	return json({ success: true });
};

// DELETE /api/admin/users/:userId — delete user
export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireArchivist(locals);

	const { userId } = params;

	if (userId === locals.user!.id) {
		throw error(400, 'Cannot delete yourself');
	}

	const user = locals.db
		.prepare('SELECT id, role FROM users WHERE id = ?')
		.get(userId) as { id: string; role: string } | undefined;

	if (!user) {
		throw error(404, 'User not found');
	}

	// Check last archivist
	if (user.role === 'archivist') {
		const archivistCount = locals.db
			.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'archivist'")
			.get() as { c: number };

		if (archivistCount.c <= 1) {
			throw error(400, 'Cannot delete the last archivist');
		}
	}

	locals.db.transaction(() => {
		destroyUserSessions(locals.db, userId);
		locals.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
	})();

	return json({ success: true });
};
