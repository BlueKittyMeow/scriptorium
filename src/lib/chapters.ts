import type { TreeNode } from './types.js';

/** Visible reading order; a trashed ancestor excludes its entire subtree. */
export function readingOrder(nodes: TreeNode[]): TreeNode[] {
	return [...nodes].filter(n => !n.deleted_at).sort((a, b) => a.sort_order - b.sort_order)
		.flatMap(n => n.type === 'document' ? [n] : readingOrder(n.children));
}

/** Each folder owns a separate sequence. Numbers never modify stored titles. */
export function chapterNumbers(nodes: TreeNode[], enabled: boolean): Map<string, number> {
	const result = new Map<string, number>();
	function walk(items: TreeNode[], folderEnabled: boolean) {
		let number = 0;
		for (const n of [...items].filter(n => !n.deleted_at).sort((a, b) => a.sort_order - b.sort_order)) {
			if (n.type === 'folder') walk(n.children, n.numbering_enabled !== 0);
			else if (enabled && folderEnabled && n.numbering_include !== 0) result.set(n.id, ++number);
		}
	}
	walk(nodes, true);
	return result;
}
