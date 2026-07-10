import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { v4 as uuid } from 'uuid';
import { ensureNovelDirs } from '$lib/server/files.js';
import { requireUser } from '$lib/server/auth.js';
import { logAction } from '$lib/server/audit.js';

/**
 * Resolve the owner_id to write for a create/import.
 * - Only archivists may assign ownership to another user.
 * - The requested owner_id must reference an existing user.
 * - Otherwise (writer, or missing/bogus id) fall back to the acting user.
 */
function resolveOwnerId(locals: App.Locals, requested: unknown): string {
	const self = locals.user!.id;
	if (locals.user!.role !== 'archivist') return self;
	if (typeof requested !== 'string' || !requested) return self;
	const exists = locals.db.prepare('SELECT id FROM users WHERE id = ?').get(requested);
	return exists ? requested : self;
}

// GET /api/novels — list all non-deleted novels
export const GET: RequestHandler = async ({ locals }) => {
	requireUser(locals);
	const novels = locals.db.prepare(`
		SELECT n.*, u.username AS owner_username,
		       COALESCE(SUM(d.word_count), 0) as total_word_count
		FROM novels n
		LEFT JOIN users u ON u.id = n.owner_id
		LEFT JOIN documents d ON d.novel_id = n.id AND d.deleted_at IS NULL
		WHERE n.deleted_at IS NULL
		GROUP BY n.id
		ORDER BY n.updated_at DESC
	`).all();
	return json(novels);
};

// POST /api/novels — create a new novel
export const POST: RequestHandler = async ({ request, locals }) => {
	requireUser(locals);
	const body = await request.json();
	const id = uuid();
	const now = new Date().toISOString();

	// Ownership tagging (§C.1 first slice): archivists may assign a novel to
	// any existing user; everyone else owns what they create. A writer's
	// owner_id is never trusted. NOTE: no permission enforcement rides on
	// owner_id yet — any authenticated user may still edit any novel.
	const ownerId = resolveOwnerId(locals, body.owner_id);

	locals.db.prepare(`
		INSERT INTO novels (id, title, subtitle, status, word_count_target, owner_id, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`).run(id, body.title || 'Untitled Novel', body.subtitle || null, body.status || 'draft', body.word_count_target || null, ownerId, now, now);

	ensureNovelDirs(id);

	logAction(locals.db, locals.user!.id, 'novel.create', 'novel', id, `Created "${body.title || 'Untitled Novel'}"`);

	const novel = locals.db.prepare('SELECT * FROM novels WHERE id = ?').get(id);
	return json(novel, { status: 201 });
};
