import type Database from 'better-sqlite3';
import { error } from '@sveltejs/kit';

export interface CollectionRow {
	id: string;
	title: string;
	parent_id: string | null;
	sort_order: number;
	created_at: string;
	updated_at: string;
}

/** Fetch a collection row, or undefined if it doesn't exist. */
export function getCollection(db: Database.Database, id: string): CollectionRow | undefined {
	return db.prepare('SELECT * FROM collections WHERE id = ?').get(id) as CollectionRow | undefined;
}

/** True if the collection has at least one child collection. */
export function hasChildren(db: Database.Database, id: string): boolean {
	const row = db.prepare('SELECT 1 FROM collections WHERE parent_id = ? LIMIT 1').get(id);
	return !!row;
}

/**
 * Validate a requested parent_id for a collection (one level of nesting max).
 * Throws a SvelteKit 400 unless the parent exists, is itself top-level
 * (parent_id IS NULL), and isn't the collection being edited. When `childId`
 * is supplied (the PUT case), also forbids parenting a collection that itself
 * has children — that would create a second level.
 *
 * Callers pass this only when parent_id is a non-null value; explicit-null
 * (promote to top-level) is always allowed and handled by the caller.
 */
export function assertValidParentCollection(
	db: Database.Database,
	parentId: string,
	childId?: string
): void {
	if (childId && parentId === childId) {
		throw error(400, 'a collection cannot be its own parent');
	}
	const parent = getCollection(db, parentId);
	if (!parent) {
		throw error(400, 'parent_id must reference an existing collection');
	}
	if (parent.parent_id !== null) {
		throw error(400, 'collections may nest only one level deep');
	}
	if (childId && hasChildren(db, childId)) {
		throw error(400, 'a collection with children cannot itself be nested');
	}
}

/** Next sort_order at the end of a sibling group (children of parentId, or top-level when null). */
export function nextSiblingSortOrder(db: Database.Database, parentId: string | null): number {
	const row = db
		.prepare(
			parentId === null
				? 'SELECT MAX(sort_order) AS m FROM collections WHERE parent_id IS NULL'
				: 'SELECT MAX(sort_order) AS m FROM collections WHERE parent_id = ?'
		)
		.get(...(parentId === null ? [] : [parentId])) as { m: number | null };
	return (row.m ?? 0) + 1;
}
