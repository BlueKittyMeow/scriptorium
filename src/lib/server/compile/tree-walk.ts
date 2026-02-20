import type Database from 'better-sqlite3';
import type { CompileDocument } from './types.js';

/**
 * Collect documents for compilation in tree sort order.
 * Walks folders recursively, respecting sort_order, deleted_at, and compile_include.
 *
 * @param db - Database instance
 * @param novelId - Novel to compile
 * @param includeIds - Optional explicit list of document IDs to include (overrides compile_include flags)
 */
export function collectCompileDocuments(
	db: Database.Database,
	novelId: string,
	includeIds?: string[]
): CompileDocument[] {
	const folders = db.prepare(
		'SELECT id, parent_id, sort_order FROM folders WHERE novel_id = ? AND deleted_at IS NULL ORDER BY sort_order'
	).all(novelId) as { id: string; parent_id: string | null; sort_order: number }[];

	const documents = db.prepare(
		'SELECT id, parent_id, title, sort_order, compile_include FROM documents WHERE novel_id = ? AND deleted_at IS NULL ORDER BY sort_order'
	).all(novelId) as { id: string; parent_id: string | null; title: string; sort_order: number; compile_include: number }[];

	const result: CompileDocument[] = [];

	// Pre-index children by parent_id for O(1) lookup (avoids O(N²) repeated .filter())
	const foldersByParent = new Map<string | null, typeof folders>();
	for (const f of folders) {
		const key = f.parent_id;
		if (!foldersByParent.has(key)) foldersByParent.set(key, []);
		foldersByParent.get(key)!.push(f);
	}

	const docsByParent = new Map<string | null, typeof documents>();
	for (const d of documents) {
		const key = d.parent_id;
		if (!docsByParent.has(key)) docsByParent.set(key, []);
		docsByParent.get(key)!.push(d);
	}

	const includeSet = includeIds ? new Set(includeIds) : null;

	function walkSorted(parentId: string | null): void {
		const childFolders = foldersByParent.get(parentId) || [];
		const childDocs = docsByParent.get(parentId) || [];

		// Merge folders and documents by sort_order
		const items: { type: 'folder' | 'document'; sort_order: number; id: string; title?: string; compile_include?: number }[] = [
			...childFolders.map(f => ({ type: 'folder' as const, sort_order: f.sort_order, id: f.id })),
			...childDocs.map(d => ({ type: 'document' as const, sort_order: d.sort_order, id: d.id, title: d.title, compile_include: d.compile_include }))
		];
		items.sort((a, b) => a.sort_order - b.sort_order);

		for (const item of items) {
			if (item.type === 'document') {
				if (includeSet) {
					if (includeSet.has(item.id)) {
						result.push({ id: item.id, title: item.title!, novelId });
					}
				} else if (item.compile_include) {
					result.push({ id: item.id, title: item.title!, novelId });
				}
			} else {
				walkSorted(item.id);
			}
		}
	}

	walkSorted(null);
	return result;
}
