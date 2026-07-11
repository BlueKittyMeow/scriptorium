import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { v4 as uuid } from 'uuid';
import { requireUser } from '$lib/server/auth.js';
import { logAction } from '$lib/server/audit.js';
import { assertValidCollectionTitle } from '$lib/server/validate.js';
import { assertValidParentCollection, nextSiblingSortOrder } from '$lib/server/collections.js';
import { resolveOwnerId } from '$lib/server/import/owner.js';

// GET /api/collections — full list (all owners' shelf spaces; the client
// scopes), ordered so each top-level group is followed by its children, both
// by sort_order. owner_username travels with each row so the library can
// label owner spaces without another fetch.
export const GET: RequestHandler = async ({ locals }) => {
	requireUser(locals);
	const collections = locals.db
		.prepare(
			`SELECT c.*, u.username AS owner_username
			 FROM collections c
			 LEFT JOIN users u ON u.id = c.owner_id
			 ORDER BY COALESCE(c.parent_id, c.id), (c.parent_id IS NOT NULL), c.sort_order, c.created_at`
		)
		.all();
	return json(collections);
};

// POST /api/collections { title, parent_id?, owner_id? } — create a collection.
// Owner semantics mirror imports (resolveOwnerId): an archivist may assign the
// shelf to any existing user; writers (or an archivist naming a ghost) always
// get themselves. A child must share its parent's owner — shelf spaces are
// per-user and subtrees never span owners.
export const POST: RequestHandler = async ({ request, locals }) => {
	requireUser(locals);
	const body = await request.json();

	const title = assertValidCollectionTitle(body.title);
	const ownerId = resolveOwnerId(locals, body.owner_id);

	// parent_id is optional. A present, non-null value must reference an
	// existing top-level collection (one level of nesting max) with the same
	// owner as the collection being created.
	let parentId: string | null = null;
	if ('parent_id' in body && body.parent_id !== null && body.parent_id !== undefined) {
		if (typeof body.parent_id !== 'string') {
			throw error(400, 'parent_id must be a string or null');
		}
		assertValidParentCollection(locals.db, body.parent_id, undefined, ownerId);
		parentId = body.parent_id;
	}

	const id = uuid();
	const now = new Date().toISOString();
	const sortOrder = nextSiblingSortOrder(locals.db, parentId);

	locals.db
		.prepare(
			`INSERT INTO collections (id, title, parent_id, owner_id, sort_order, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		)
		.run(id, title, parentId, ownerId, sortOrder, now, now);

	logAction(locals.db, locals.user!.id, 'collection.create', 'collection', id, `Created "${title}"`);

	const collection = locals.db.prepare('SELECT * FROM collections WHERE id = ?').get(id);
	return json(collection, { status: 201 });
};
