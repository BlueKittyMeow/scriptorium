import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/auth.js';
import { logAction } from '$lib/server/audit.js';
import { assertValidCollectionTitle } from '$lib/server/validate.js';
import { assertValidParentCollection, getCollection } from '$lib/server/collections.js';

// PUT /api/collections/:id { title?, parent_id?, sort_order? }
// Every field is optional; omitted vs explicit-null is distinguished by key
// presence so `parent_id: null` promotes to top-level while an omitted
// parent_id is left untouched.
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals);
	const body = await request.json();

	const existing = getCollection(locals.db, params.id);
	if (!existing) throw error(404, 'Collection not found');

	const now = new Date().toISOString();

	let title = existing.title;
	if ('title' in body) {
		title = assertValidCollectionTitle(body.title);
	}

	let parentId = existing.parent_id;
	if ('parent_id' in body) {
		if (body.parent_id === null) {
			// Explicit null: promote to top-level. Always allowed.
			parentId = null;
		} else if (typeof body.parent_id === 'string') {
			// v2.1: the new parent must belong to this collection's owner —
			// shelf subtrees never span two owners.
			assertValidParentCollection(locals.db, body.parent_id, params.id, existing.owner_id);
			parentId = body.parent_id;
		} else {
			throw error(400, 'parent_id must be a string or null');
		}
	}

	let sortOrder = existing.sort_order;
	if ('sort_order' in body) {
		if (typeof body.sort_order !== 'number' || !Number.isFinite(body.sort_order)) {
			throw error(400, 'sort_order must be a finite number');
		}
		sortOrder = body.sort_order;
	}

	locals.db
		.prepare(
			`UPDATE collections SET title = ?, parent_id = ?, sort_order = ?, updated_at = ? WHERE id = ?`
		)
		.run(title, parentId, sortOrder, now, params.id);

	logAction(locals.db, locals.user!.id, 'collection.update', 'collection', params.id);

	const updated = getCollection(locals.db, params.id);
	return json(updated);
};

// DELETE /api/collections/:id — null member novels (fall to Unsorted), promote
// child collections to top-level, then delete. Novels themselves untouched.
export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireUser(locals);

	const existing = getCollection(locals.db, params.id);
	if (!existing) throw error(404, 'Collection not found');

	const now = new Date().toISOString();
	const doDelete = locals.db.transaction(() => {
		locals.db
			.prepare('UPDATE novels SET collection_id = NULL, updated_at = ? WHERE collection_id = ?')
			.run(now, params.id);
		locals.db
			.prepare('UPDATE collections SET parent_id = NULL, updated_at = ? WHERE parent_id = ?')
			.run(now, params.id);
		locals.db.prepare('DELETE FROM collections WHERE id = ?').run(params.id);
	});
	doDelete();

	logAction(locals.db, locals.user!.id, 'collection.delete', 'collection', params.id);

	return json({ success: true });
};
