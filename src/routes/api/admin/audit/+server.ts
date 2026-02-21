import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireArchivist } from '$lib/server/auth.js';

// GET /api/admin/audit — paginated audit log
export const GET: RequestHandler = async ({ locals, url }) => {
	requireArchivist(locals);

	const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
	const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '50')));
	const offset = (page - 1) * limit;

	// Optional filters
	const userId = url.searchParams.get('user_id');
	const action = url.searchParams.get('action');

	let query = `SELECT a.*, u.username FROM audit_log a LEFT JOIN users u ON a.user_id = u.id`;
	const conditions: string[] = [];
	const params: any[] = [];

	if (userId) {
		conditions.push('a.user_id = ?');
		params.push(userId);
	}
	if (action) {
		conditions.push('a.action = ?');
		params.push(action);
	}

	if (conditions.length > 0) {
		query += ` WHERE ${conditions.join(' AND ')}`;
	}

	query += ` ORDER BY a.created_at DESC LIMIT ? OFFSET ?`;
	params.push(limit, offset);

	const entries = locals.db.prepare(query).all(...params);

	const totalQuery = conditions.length > 0
		? `SELECT COUNT(*) as c FROM audit_log a WHERE ${conditions.join(' AND ')}`
		: 'SELECT COUNT(*) as c FROM audit_log';
	const total = (locals.db.prepare(totalQuery).get(...params.slice(0, conditions.length)) as { c: number }).c;

	return json({
		entries,
		pagination: { page, limit, total, pages: Math.ceil(total / limit) }
	});
};
