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

	function walk(parentId: string | null): void {
		// Collect documents at this level
		for (const doc of documents.filter(d => d.parent_id === parentId)) {
			if (includeIds) {
				if (includeIds.includes(doc.id)) {
					result.push({ id: doc.id, title: doc.title, novelId });
				}
			} else if (doc.compile_include) {
				result.push({ id: doc.id, title: doc.title, novelId });
			}
		}

		// Recurse into child folders
		for (const folder of folders.filter(f => f.parent_id === parentId)) {
			walk(folder.id);
		}
	}

	// Sort all items (folders + documents) at each level by sort_order
	// The tree API sorts folders before documents, but compile needs interleaved sort
	function walkSorted(parentId: string | null): void {
		const childFolders = folders.filter(f => f.parent_id === parentId);
		const childDocs = documents.filter(d => d.parent_id === parentId);

		// Merge folders and documents by sort_order
		const items: { type: 'folder' | 'document'; sort_order: number; id: string; title?: string; compile_include?: number }[] = [
			...childFolders.map(f => ({ type: 'folder' as const, sort_order: f.sort_order, id: f.id })),
			...childDocs.map(d => ({ type: 'document' as const, sort_order: d.sort_order, id: d.id, title: d.title, compile_include: d.compile_include }))
		];
		items.sort((a, b) => a.sort_order - b.sort_order);

		for (const item of items) {
			if (item.type === 'document') {
				if (includeIds) {
					if (includeIds.includes(item.id)) {
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
