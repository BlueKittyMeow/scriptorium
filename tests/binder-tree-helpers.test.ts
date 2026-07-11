import { describe, it, expect } from 'vitest';
import type { TreeNode } from '../src/lib/types.js';
import {
	findParentId,
	getDefaultDocumentParent,
	findNodeById,
	isDescendantOf,
	getVisibleSiblingsOf,
	computeSwapMove,
	getMoveTargets,
	computeAppendSortOrder
} from '../src/lib/binder-tree.js';

/**
 * Binder touch-affordance QoL (mobile reorder/move, new-doc parent default):
 * pure tree-shape logic extracted to src/lib/binder-tree.ts so it can be
 * unit-tested directly instead of only via source-grep. The workspace page
 * (src/routes/novels/[id]/+page.svelte) imports these and wires them to the
 * SAME reorder endpoint the drag-and-drop handler already uses.
 */

function doc(id: string, sort_order: number, children: TreeNode[] = []): TreeNode {
	return { id, type: 'document', title: `Doc ${id}`, sort_order, deleted_at: null, children };
}

function folder(id: string, sort_order: number, children: TreeNode[] = []): TreeNode {
	return { id, type: 'folder', title: `Folder ${id}`, sort_order, deleted_at: null, children };
}

describe('findParentId / getDefaultDocumentParent', () => {
	it('returns null for a root-level node', () => {
		const tree = [doc('d1', 1)];
		expect(findParentId(tree, 'd1')).toBeNull();
	});

	it('returns the parent folder id for a nested node', () => {
		const tree = [folder('f1', 1, [doc('d1', 1)])];
		expect(findParentId(tree, 'd1')).toBe('f1');
	});

	it('returns undefined when the node is not in the tree', () => {
		const tree = [doc('d1', 1)];
		expect(findParentId(tree, 'nope')).toBeUndefined();
	});

	it('getDefaultDocumentParent: null when there is no active document', () => {
		const tree = [folder('f1', 1, [doc('d1', 1)])];
		expect(getDefaultDocumentParent(tree, null)).toBeNull();
	});

	it('getDefaultDocumentParent: root when the active document is at root', () => {
		const tree = [doc('d1', 1)];
		expect(getDefaultDocumentParent(tree, 'd1')).toBeNull();
	});

	it('getDefaultDocumentParent: the active document\'s folder when nested', () => {
		const tree = [folder('f1', 1, [doc('d1', 1)])];
		expect(getDefaultDocumentParent(tree, 'd1')).toBe('f1');
	});

	it('getDefaultDocumentParent: falls back to root if the active doc vanished from the tree', () => {
		const tree = [folder('f1', 1, [])];
		expect(getDefaultDocumentParent(tree, 'ghost')).toBeNull();
	});
});

describe('findNodeById / isDescendantOf', () => {
	it('finds a nested node by id', () => {
		const inner = doc('d1', 1);
		const tree = [folder('f1', 1, [inner])];
		expect(findNodeById(tree, 'd1')).toBe(inner);
	});

	it('returns null when not found', () => {
		expect(findNodeById([doc('d1', 1)], 'nope')).toBeNull();
	});

	it('detects a direct child as a descendant', () => {
		const f1 = folder('f1', 1, [doc('d1', 1)]);
		expect(isDescendantOf(f1, 'd1')).toBe(true);
	});

	it('detects a grandchild as a descendant', () => {
		const f1 = folder('f1', 1, [folder('f2', 1, [doc('d1', 1)])]);
		expect(isDescendantOf(f1, 'd1')).toBe(true);
	});

	it('a folder is not its own descendant', () => {
		const f1 = folder('f1', 1, [doc('d1', 1)]);
		expect(isDescendantOf(f1, 'f1')).toBe(false);
	});

	it('an unrelated node is not a descendant', () => {
		const f1 = folder('f1', 1, [doc('d1', 1)]);
		expect(isDescendantOf(f1, 'other')).toBe(false);
	});
});

describe('getVisibleSiblingsOf', () => {
	it('root-level siblings exclude soft-deleted nodes', () => {
		const tree = [doc('d1', 1), { ...doc('d2', 2), deleted_at: '2026-01-01' }, doc('d3', 3)];
		const { siblings, parentId } = getVisibleSiblingsOf(tree, 'd1');
		expect(parentId).toBeNull();
		expect(siblings.map((s) => s.id)).toEqual(['d1', 'd3']);
	});

	it('nested siblings resolve to their parent folder', () => {
		const tree = [folder('f1', 1, [doc('d1', 1), doc('d2', 2)])];
		const { siblings, parentId } = getVisibleSiblingsOf(tree, 'd2');
		expect(parentId).toBe('f1');
		expect(siblings.map((s) => s.id)).toEqual(['d1', 'd2']);
	});
});

describe('computeSwapMove', () => {
	it('moving the first sibling up returns null (nothing to swap with)', () => {
		const tree = [doc('d1', 1), doc('d2', 2)];
		expect(computeSwapMove(tree, 'd1', 'up')).toBeNull();
	});

	it('moving the last sibling down returns null', () => {
		const tree = [doc('d1', 1), doc('d2', 2)];
		expect(computeSwapMove(tree, 'd2', 'down')).toBeNull();
	});

	it('moving a middle node up gives a sort_order before its previous sibling', () => {
		const tree = [doc('d1', 1), doc('d2', 2), doc('d3', 3)];
		const result = computeSwapMove(tree, 'd2', 'up')!;
		expect(result.parentId).toBeNull();
		expect(result.sortOrder).toBeLessThan(1); // ends up before d1 (sort_order 1)
	});

	it('moving the first node down lands it between the next two siblings', () => {
		const tree = [doc('d1', 1), doc('d2', 2), doc('d3', 3)];
		const result = computeSwapMove(tree, 'd1', 'down')!;
		expect(result.sortOrder).toBeGreaterThan(2);
		expect(result.sortOrder).toBeLessThan(3);
	});

	it('swap stays within the same parent for nested nodes', () => {
		const tree = [folder('f1', 1, [doc('d1', 1), doc('d2', 2)])];
		const result = computeSwapMove(tree, 'd2', 'up')!;
		expect(result.parentId).toBe('f1');
	});

	it('returns null for a node not present in the tree', () => {
		expect(computeSwapMove([doc('d1', 1)], 'ghost', 'up')).toBeNull();
	});
});

describe('getMoveTargets', () => {
	it('lists every non-deleted folder, excluding the node itself', () => {
		const f1 = folder('f1', 1);
		const f2 = folder('f2', 2);
		const tree = [f1, f2];
		const targets = getMoveTargets(tree, f1);
		expect(targets.map((t) => t.id)).toEqual(['f2']);
	});

	it('excludes a folder\'s own descendants so it cannot be moved into a child', () => {
		const grandchild = folder('gc', 1);
		const child = folder('child', 1, [grandchild]);
		const tree = [folder('root', 1, [child])];
		const rootNode = tree[0];
		const targets = getMoveTargets(tree, rootNode);
		expect(targets.map((t) => t.id)).not.toContain('root');
		expect(targets.map((t) => t.id)).not.toContain('child');
		expect(targets.map((t) => t.id)).not.toContain('gc');
	});

	it('a document can target any non-deleted folder (no descendant exclusion needed)', () => {
		const d1 = doc('d1', 1);
		const tree = [folder('f1', 1, [d1]), folder('f2', 2)];
		const targets = getMoveTargets(tree, d1);
		expect(targets.map((t) => t.id).sort()).toEqual(['f1', 'f2']);
	});

	it('skips soft-deleted folders', () => {
		const deletedFolder = { ...folder('trashed', 2), deleted_at: '2026-01-01' };
		const tree = [folder('f1', 1), deletedFolder];
		const targets = getMoveTargets(tree, folder('other', 3));
		expect(targets.map((t) => t.id)).not.toContain('trashed');
	});

	it('tags nested folders with increasing depth', () => {
		const tree = [folder('f1', 1, [folder('f2', 1, [folder('f3', 1)])])];
		const targets = getMoveTargets(tree, doc('somedoc', 99));
		expect(targets.find((t) => t.id === 'f1')?.depth).toBe(0);
		expect(targets.find((t) => t.id === 'f2')?.depth).toBe(1);
		expect(targets.find((t) => t.id === 'f3')?.depth).toBe(2);
	});
});

describe('computeAppendSortOrder', () => {
	it('returns 1 for an empty root', () => {
		expect(computeAppendSortOrder([], null, 'x')).toBe(1);
	});

	it('returns max(sort_order) + 1 among root siblings', () => {
		const tree = [doc('d1', 1), doc('d2', 5)];
		expect(computeAppendSortOrder(tree, null, 'unrelated')).toBe(6);
	});

	it('excludes the node itself from the max computation', () => {
		const tree = [doc('d1', 1), doc('d2', 5)];
		expect(computeAppendSortOrder(tree, null, 'd2')).toBe(2);
	});

	it('computes append order within a target folder, not root', () => {
		const tree = [folder('f1', 1, [doc('d1', 1), doc('d2', 3)]), doc('d3', 99)];
		expect(computeAppendSortOrder(tree, 'f1', 'unrelated')).toBe(4);
	});

	it('returns 1 for an empty target folder', () => {
		const tree = [folder('f1', 1, [])];
		expect(computeAppendSortOrder(tree, 'f1', 'unrelated')).toBe(1);
	});
});
