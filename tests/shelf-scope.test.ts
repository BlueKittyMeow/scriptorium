import { describe, it, expect } from 'vitest';
import {
	ownerSpaces,
	topLevelsFor,
	childrenOfIn,
	moveTargetsFor,
	canFileOn
} from '../src/lib/shelf-scope.js';

/**
 * Per-owner shelf spaces (collections v2.1) — pure scoping helpers. These are
 * the unit-testable core of the library's owner-scoped rendering: which owner
 * spaces exist, which shelves belong to whom, which shelves a card may be
 * filed onto, and whether a drag-drop target is legal for a card.
 */

const c = (
	id: string,
	title: string,
	parent_id: string | null,
	owner_id: string | null,
	sort_order = 1,
	owner_username: string | null = null
) => ({ id, title, parent_id, owner_id, sort_order, owner_username });

// Two owners with shelves: the writer (lara) has a universe with two eras plus
// a second top-level; the archivist (meredith) has one top-level of her own.
const COLS = [
	c('u1', 'Silvers Universe', null, 'w', 1, 'lara'),
	c('e1', 'Tigrenache Era', 'u1', 'w', 2, 'lara'),
	c('e2', 'Ghaeran Era', 'u1', 'w', 1, 'lara'),
	c('u2', 'Poetry', null, 'w', 2, 'lara'),
	c('a1', 'Reference', null, 'a', 1, 'meredith')
];

describe('ownerSpaces', () => {
	it('returns one space per distinct shelf owner', () => {
		const spaces = ownerSpaces(COLS, 'lara');
		expect(spaces).toHaveLength(2);
		expect(spaces.map((s) => s.ownerId).sort()).toEqual(['a', 'w']);
	});

	it('puts the current user’s space first, then others alphabetically', () => {
		expect(ownerSpaces(COLS, 'meredith').map((s) => s.ownerUsername)).toEqual([
			'meredith',
			'lara'
		]);
		expect(ownerSpaces(COLS, 'lara').map((s) => s.ownerUsername)).toEqual(['meredith', 'lara'].reverse());
	});

	it('groups unowned (legacy NULL-owner) shelves into a trailing null space', () => {
		const withOrphan = [...COLS, c('x1', 'Orphan Shelf', null, null, 1, null)];
		const spaces = ownerSpaces(withOrphan, 'lara');
		expect(spaces).toHaveLength(3);
		expect(spaces[spaces.length - 1].ownerId).toBeNull();
	});

	it('ignores child collections when deciding which owners have spaces', () => {
		// An owner represented only by a child era (corrupt data) still counts once.
		const spaces = ownerSpaces(COLS, 'nobody');
		expect(spaces.map((s) => s.ownerId).sort()).toEqual(['a', 'w']);
	});
});

describe('topLevelsFor / childrenOfIn', () => {
	it('returns only the owner’s top-level shelves, by sort_order', () => {
		expect(topLevelsFor(COLS, 'w').map((x) => x.id)).toEqual(['u1', 'u2']);
		expect(topLevelsFor(COLS, 'a').map((x) => x.id)).toEqual(['a1']);
		expect(topLevelsFor(COLS, null)).toEqual([]);
	});

	it('childrenOfIn returns a parent’s children by sort_order', () => {
		expect(childrenOfIn(COLS, 'u1').map((x) => x.id)).toEqual(['e2', 'e1']);
		expect(childrenOfIn(COLS, 'a1')).toEqual([]);
	});
});

describe('moveTargetsFor', () => {
	it('lists exactly the novel owner’s shelves, hierarchically, eras flagged indented', () => {
		const targets = moveTargetsFor(COLS, 'w');
		expect(targets.map((t) => t.id)).toEqual(['u1', 'e2', 'e1', 'u2']);
		expect(targets.map((t) => t.indented)).toEqual([false, true, true, false]);
	});

	it('excludes other owners’ shelves entirely', () => {
		const targets = moveTargetsFor(COLS, 'a');
		expect(targets.map((t) => t.id)).toEqual(['a1']);
	});

	it('an unowned novel may only target unowned shelves', () => {
		expect(moveTargetsFor(COLS, null)).toEqual([]);
		const withOrphan = [...COLS, c('x1', 'Orphan Shelf', null, null)];
		expect(moveTargetsFor(withOrphan, null).map((t) => t.id)).toEqual(['x1']);
	});
});

describe('canFileOn', () => {
	it('always allows Unsorted (null target)', () => {
		expect(canFileOn(null, 'w')).toBe(true);
		expect(canFileOn(null, null)).toBe(true);
	});

	it('allows same-owner shelves, rejects cross-owner shelves', () => {
		const [u1, , , , a1] = COLS;
		expect(canFileOn(u1, 'w')).toBe(true);
		expect(canFileOn(a1, 'w')).toBe(false);
		expect(canFileOn(u1, 'a')).toBe(false);
	});

	it('treats NULL owner on both sides as a match (legacy tolerance)', () => {
		expect(canFileOn(c('x1', 'Orphan', null, null), null)).toBe(true);
		expect(canFileOn(c('x1', 'Orphan', null, null), 'w')).toBe(false);
	});
});
