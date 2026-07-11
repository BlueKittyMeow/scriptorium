import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { softDeleteNovel } from '$lib/server/tree-ops.js';
import { requireUser } from '$lib/server/auth.js';
import { logAction } from '$lib/server/audit.js';
import { assertValidNovelStatus, assertValidStackLabel } from '$lib/server/validate.js';

// GET /api/novels/:id
export const GET: RequestHandler = async ({ params, locals }) => {
	requireUser(locals);
	const novel = locals.db.prepare(`
		SELECT n.*, COALESCE(SUM(d.word_count), 0) as total_word_count
		FROM novels n
		LEFT JOIN documents d ON d.novel_id = n.id AND d.deleted_at IS NULL
		WHERE n.id = ? AND n.deleted_at IS NULL
		GROUP BY n.id
	`).get(params.id);

	if (!novel) throw error(404, 'Novel not found');
	return json(novel);
};

// PUT /api/novels/:id — update novel metadata
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals);
	const body = await request.json();
	const now = new Date().toISOString();

	const existing = locals.db.prepare('SELECT * FROM novels WHERE id = ? AND deleted_at IS NULL').get(params.id);
	if (!existing) throw error(404, 'Novel not found');

	// Ownership reassignment is archivist-only (§C.1 first slice). Writers
	// that send owner_id are silently ignored — owner_id stays NULL below so
	// COALESCE keeps the existing owner. NOTE: no permission enforcement rides
	// on owner_id yet; any authenticated user may still edit any novel.
	let ownerId: string | null = null;
	if (locals.user!.role === 'archivist' && typeof body.owner_id === 'string' && body.owner_id) {
		const ownerExists = locals.db.prepare('SELECT id FROM users WHERE id = ?').get(body.owner_id);
		if (ownerExists) ownerId = body.owner_id;
	}

	// 400s on an unrecognized status; null (no-op) when omitted/blank.
	const status = assertValidNovelStatus(body.status);

	locals.db.prepare(`
		UPDATE novels SET
			title = COALESCE(?, title),
			subtitle = COALESCE(?, subtitle),
			status = COALESCE(?, status),
			word_count_target = COALESCE(?, word_count_target),
			owner_id = COALESCE(?, owner_id),
			updated_at = ?
		WHERE id = ?
	`).run(body.title, body.subtitle, status, body.word_count_target, ownerId, now, params.id);

	// Collection assignment + version-stack label. COALESCE can't distinguish
	// "clear to null" from "omitted", so these are handled by key presence:
	// omitted → no-op; explicit null → clear; a value → validate then set.
	if ('collection_id' in body) {
		if (body.collection_id === null) {
			locals.db.prepare('UPDATE novels SET collection_id = NULL, updated_at = ? WHERE id = ?').run(now, params.id);
		} else if (typeof body.collection_id === 'string') {
			const target = locals.db
				.prepare('SELECT id, owner_id FROM collections WHERE id = ?')
				.get(body.collection_id) as { id: string; owner_id: string | null } | undefined;
			if (!target) throw error(400, 'collection_id must reference an existing collection');
			// v2.1: shelves are per-owner — a novel may only be filed onto a
			// shelf belonging to the novel's owner. The effective owner accounts
			// for an archivist reassignment earlier in this same request.
			const novelOwner = (ownerId ?? (existing as { owner_id: string | null }).owner_id) ?? null;
			if ((target.owner_id ?? null) !== novelOwner) {
				throw error(400, 'a novel may only be filed onto a shelf belonging to its owner');
			}
			locals.db.prepare('UPDATE novels SET collection_id = ?, updated_at = ? WHERE id = ?').run(body.collection_id, now, params.id);
		} else {
			throw error(400, 'collection_id must be a string or null');
		}
	}
	if ('stack_label' in body) {
		if (body.stack_label === null) {
			locals.db.prepare('UPDATE novels SET stack_label = NULL, updated_at = ? WHERE id = ?').run(now, params.id);
		} else {
			const label = assertValidStackLabel(body.stack_label);
			locals.db.prepare('UPDATE novels SET stack_label = ?, updated_at = ? WHERE id = ?').run(label, now, params.id);
		}
	}

	const novel = locals.db.prepare('SELECT * FROM novels WHERE id = ?').get(params.id);
	return json(novel);
};

// DELETE /api/novels/:id — soft-delete
export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireUser(locals);
	const now = new Date().toISOString();

	const existing = locals.db.prepare('SELECT * FROM novels WHERE id = ? AND deleted_at IS NULL').get(params.id);
	if (!existing) throw error(404, 'Novel not found');

	const doSoftDelete = locals.db.transaction(() => {
		softDeleteNovel(locals.db, params.id, now);
	});
	doSoftDelete();

	logAction(locals.db, locals.user!.id, 'novel.delete', 'novel', params.id);

	return json({ success: true });
};
