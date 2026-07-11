import type { TreeNode } from './types.js';

/**
 * Pure tree-shape helpers shared between the binder's drag-and-drop path
 * (desktop) and its touch-friendly button/picker path (coarse pointers).
 * Both paths call the SAME reorder endpoint (PUT /api/novels/:id/tree)
 * with the same { node_id, node_type, new_parent_id, new_sort_order }
 * payload — these functions only compute that payload's parent/sort_order
 * half from the current in-memory tree.
 */

/**
 * Parent id of `targetId` in the tree. `null` means root-level; `undefined`
 * means the node isn't in the tree at all (so callers can tell "at root"
 * apart from "not found").
 */
export function findParentId(
	nodes: TreeNode[],
	targetId: string,
	parentId: string | null = null
): string | null | undefined {
	for (const n of nodes) {
		if (n.id === targetId) return parentId;
		const found = findParentId(n.children, targetId, n.id);
		if (found !== undefined) return found;
	}
	return undefined;
}

/**
 * Default parent for a newly created document: the currently active
 * document's parent folder (null = root), or root if there's no active
 * document (or it's no longer in the tree).
 */
export function getDefaultDocumentParent(tree: TreeNode[], activeDocId: string | null): string | null {
	if (!activeDocId) return null;
	const parentId = findParentId(tree, activeDocId);
	return parentId === undefined ? null : parentId;
}

/** Find a node (and its subtree) anywhere in the tree by id. */
export function findNodeById(nodes: TreeNode[], targetId: string): TreeNode | null {
	for (const n of nodes) {
		if (n.id === targetId) return n;
		const found = findNodeById(n.children, targetId);
		if (found) return found;
	}
	return null;
}

/** True if `targetId` is a descendant of `node` (node itself doesn't count). */
export function isDescendantOf(node: TreeNode, targetId: string): boolean {
	for (const child of node.children) {
		if (child.id === targetId) return true;
		if (child.type === 'folder' && isDescendantOf(child, targetId)) return true;
	}
	return false;
}

/** Visible (non-deleted) siblings of `targetId` and their shared parent id. */
export function getVisibleSiblingsOf(
	tree: TreeNode[],
	targetId: string
): { siblings: TreeNode[]; parentId: string | null } {
	const rootVisible = tree.filter((n) => !n.deleted_at);
	if (rootVisible.some((n) => n.id === targetId)) {
		return { siblings: rootVisible, parentId: null };
	}
	function search(nodes: TreeNode[]): { siblings: TreeNode[]; parentId: string } | null {
		for (const node of nodes) {
			const visible = node.children.filter((c) => !c.deleted_at);
			if (visible.some((c) => c.id === targetId)) {
				return { siblings: visible, parentId: node.id };
			}
			const found = search(node.children);
			if (found) return found;
		}
		return null;
	}
	return search(tree) || { siblings: [], parentId: null };
}

/**
 * Compute the { parentId, sortOrder } needed to swap a node with its
 * previous/next visible sibling under the same parent — same before/after
 * placement math as the drag-and-drop drop handler. Returns null at the
 * first/last boundary (caller should hide/disable the button there).
 */
export function computeSwapMove(
	tree: TreeNode[],
	nodeId: string,
	direction: 'up' | 'down'
): { parentId: string | null; sortOrder: number } | null {
	const { siblings, parentId } = getVisibleSiblingsOf(tree, nodeId);
	const currentIdx = siblings.findIndex((s) => s.id === nodeId);
	if (currentIdx === -1) return null;
	if (direction === 'up' && currentIdx === 0) return null;
	if (direction === 'down' && currentIdx === siblings.length - 1) return null;

	const filtered = siblings.filter((s) => s.id !== nodeId);
	const targetSibling = siblings[direction === 'up' ? currentIdx - 1 : currentIdx + 1];
	const idxInFiltered = filtered.findIndex((s) => s.id === targetSibling.id);

	let sortOrder: number;
	if (direction === 'up') {
		sortOrder =
			idxInFiltered <= 0
				? (filtered[0]?.sort_order ?? 1) - 1
				: (filtered[idxInFiltered - 1].sort_order + filtered[idxInFiltered].sort_order) / 2;
	} else {
		sortOrder =
			idxInFiltered >= filtered.length - 1
				? (filtered[idxInFiltered]?.sort_order ?? 0) + 1
				: (filtered[idxInFiltered].sort_order + filtered[idxInFiltered + 1].sort_order) / 2;
	}
	return { parentId, sortOrder };
}

/**
 * Flatten all non-deleted folders into a depth-tagged list for the
 * "Move into…" picker, excluding `node` itself and (if it's a folder) any
 * of its own descendants — a folder can never be moved into itself or a
 * child of itself.
 */
export function getMoveTargets(
	tree: TreeNode[],
	node: TreeNode
): { id: string; title: string; depth: number }[] {
	const result: { id: string; title: string; depth: number }[] = [];
	function walk(nodes: TreeNode[], depth: number) {
		for (const n of nodes) {
			if (n.deleted_at || n.type !== 'folder') continue;
			if (n.id === node.id) continue;
			if (node.type === 'folder' && isDescendantOf(node, n.id)) continue;
			result.push({ id: n.id, title: n.title, depth });
			walk(n.children, depth + 1);
		}
	}
	walk(tree, 0);
	return result;
}

/**
 * sort_order for appending a node as the last visible child of `parentId`
 * (null = root), excluding the node itself from the computation — used when
 * re-parenting via the "Move into…" picker (mirrors the drop-"inside" case).
 */
export function computeAppendSortOrder(tree: TreeNode[], parentId: string | null, excludeId: string): number {
	const parentNode = parentId === null ? null : findNodeById(tree, parentId);
	const children = parentId === null ? tree : parentNode?.children ?? [];
	const visible = children.filter((c) => !c.deleted_at && c.id !== excludeId);
	return visible.length === 0 ? 1 : Math.max(...visible.map((c) => c.sort_order)) + 1;
}
