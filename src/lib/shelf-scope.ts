/**
 * Per-owner shelf spaces (collections v2.1) — pure scoping helpers for the
 * library bookshelf. Every collection belongs to one user's shelf space
 * (owner_id); these functions answer the scoping questions the UI needs:
 * which owner spaces exist, which shelves belong to an owner, which shelves
 * a novel may be filed onto, and whether a drag target is legal for a card.
 *
 * Pure and framework-free so they are unit-testable (tests/shelf-scope.test.ts).
 */

export interface ShelfCollection {
	id: string;
	title: string;
	parent_id: string | null;
	sort_order: number;
	owner_id?: string | null;
	owner_username?: string | null;
}

export interface OwnerSpace {
	ownerId: string | null;
	ownerUsername: string | null;
}

export interface MoveTarget {
	id: string;
	title: string;
	indented: boolean;
}

const bySortOrder = (a: ShelfCollection, b: ShelfCollection) => a.sort_order - b.sort_order;

/**
 * The distinct owner spaces that have shelves, in render order: the current
 * user's space first, then the rest alphabetically by username, with a
 * trailing null space for any unowned (legacy) shelves.
 */
export function ownerSpaces(
	collections: ShelfCollection[],
	currentUsername?: string | null
): OwnerSpace[] {
	const seen = new Set<string>();
	const spaces: OwnerSpace[] = [];
	let hasUnowned = false;
	for (const c of collections) {
		const ownerId = c.owner_id ?? null;
		if (ownerId === null) {
			hasUnowned = true;
			continue;
		}
		if (!seen.has(ownerId)) {
			seen.add(ownerId);
			spaces.push({ ownerId, ownerUsername: c.owner_username ?? null });
		}
	}
	spaces.sort((a, b) => {
		if (a.ownerUsername === currentUsername) return -1;
		if (b.ownerUsername === currentUsername) return 1;
		return (a.ownerUsername ?? '').localeCompare(b.ownerUsername ?? '');
	});
	if (hasUnowned) spaces.push({ ownerId: null, ownerUsername: null });
	return spaces;
}

/** The owner's top-level shelves ("universes"), by sort_order. */
export function topLevelsFor(
	collections: ShelfCollection[],
	ownerId: string | null
): ShelfCollection[] {
	return collections
		.filter((c) => c.parent_id === null && (c.owner_id ?? null) === (ownerId ?? null))
		.sort(bySortOrder);
}

/** A parent's child shelves ("eras"), by sort_order. */
export function childrenOfIn(collections: ShelfCollection[], parentId: string): ShelfCollection[] {
	return collections.filter((c) => c.parent_id === parentId).sort(bySortOrder);
}

/**
 * The shelves a novel may be filed onto — exactly its owner's, in
 * hierarchical order (each universe followed by its eras, flagged indented).
 * Unsorted (null) is always a valid target and is the caller's to offer.
 */
export function moveTargetsFor(
	collections: ShelfCollection[],
	novelOwnerId: string | null
): MoveTarget[] {
	const targets: MoveTarget[] = [];
	for (const top of topLevelsFor(collections, novelOwnerId)) {
		targets.push({ id: top.id, title: top.title, indented: false });
		for (const era of childrenOfIn(collections, top.id)) {
			targets.push({ id: era.id, title: era.title, indented: true });
		}
	}
	return targets;
}

/**
 * May this novel be filed onto this shelf? Unsorted (null collection) is
 * always allowed; otherwise the shelf's owner must match the novel's owner
 * (NULL matches NULL, tolerating unowned legacy rows). This is the client
 * mirror of the server's 400 on cross-owner assignment.
 */
export function canFileOn(
	collection: ShelfCollection | null | undefined,
	novelOwnerId: string | null
): boolean {
	if (!collection) return true;
	return (collection.owner_id ?? null) === (novelOwnerId ?? null);
}
