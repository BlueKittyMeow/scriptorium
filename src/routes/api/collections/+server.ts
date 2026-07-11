import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { v4 as uuid } from 'uuid';
import { requireUser } from '$lib/server/auth.js';
import { logAction } from '$lib/server/audit.js';
import { assertValidCollectionTitle } from '$lib/server/validate.js';
import { assertValidParentCollection, nextSiblingSortOrder } from '$lib/server/collections.js';

// GET /api/collections — full list, ordered so each top-level group is
// followed by its children, both by sort_order. The library rebuilds the
// hierarchy from parent_id, but a deterministic order keeps things stable.
export const GET: RequestHandler = async ({ locals }) => {
	requireUser(locals);
	const collections = locals.db
		.prepare(
			`SELECT * FROM collections
			 ORDER BY COALESCE(parent_id, id), (parent_id IS NOT NULL), sort_order, created_at`
		)
		.all();
	return json(collections);
};

// POST /api/collections { title, parent_id? } — create a collection.
export const POST: RequestHandler = async ({ request, locals }) => {
	requireUser(locals);
	const body = await request.json();

	const title = assertValidCollectionTitle(body.title);

	// parent_id is optional. A present, non-null value must reference an
	// existing top-level collection (one level of nesting max).
	let parentId: string | null = null;
	if ('parent_id' in body && body.parent_id !== null && body.parent_id !== undefined) {
		if (typeof body.parent_id !== 'string') {
			throw error(400, 'parent_id must be a string or null');
		}
		assertValidParentCollection(locals.db, body.parent_id);
		parentId = body.parent_id;
	}

	const id = uuid();
	const now = new Date().toISOString();
	const sortOrder = nextSiblingSortOrder(locals.db, parentId);

	locals.db
		.prepare(
			`INSERT INTO collections (id, title, parent_id, sort_order, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
		)
		.run(id, title, parentId, sortOrder, now, now);

	logAction(locals.db, locals.user!.id, 'collection.create', 'collection', id, `Created "${title}"`);

	const collection = locals.db.prepare('SELECT * FROM collections WHERE id = ?').get(id);
	return json(collection, { status: 201 });
};
