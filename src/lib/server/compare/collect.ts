import type Database from 'better-sqlite3';
import type { CompareDocument } from '$lib/types.js';
import { stripHtml, countWords } from '../files.js';

/**
 * Content reader function type — abstracts file I/O for testability.
 * Returns HTML content for a given novel/document ID pair, or null if missing.
 */
export type ContentReader = (novelId: string, docId: string) => string | null;

/**
 * Collect all non-deleted documents from a novel in sort order,
 * with plaintext extracted from HTML content.
 *
 * Walks the tree (folders + documents) in sort_order, same pattern
 * as collectCompileDocuments but returns CompareDocument with plaintext.
 */
export function collectCompareDocuments(
	db: Database.Database,
	novelId: string,
	contentReader: ContentReader
): CompareDocument[] {
	const folders = db.prepare(
		'SELECT id, parent_id, sort_order FROM folders WHERE novel_id = ? AND deleted_at IS NULL ORDER BY sort_order'
	).all(novelId) as { id: string; parent_id: string | null; sort_order: number }[];

	const documents = db.prepare(
		'SELECT id, parent_id, title, sort_order FROM documents WHERE novel_id = ? AND deleted_at IS NULL ORDER BY sort_order'
	).all(novelId) as { id: string; parent_id: string | null; title: string; sort_order: number }[];

	// Pre-index children by parent_id for O(1) lookup
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

	const result: CompareDocument[] = [];

	function walkSorted(parentId: string | null): void {
		const childFolders = foldersByParent.get(parentId) || [];
		const childDocs = docsByParent.get(parentId) || [];

		const items: { type: 'folder' | 'document'; sort_order: number; id: string; title?: string }[] = [
			...childFolders.map(f => ({ type: 'folder' as const, sort_order: f.sort_order, id: f.id })),
			...childDocs.map(d => ({ type: 'document' as const, sort_order: d.sort_order, id: d.id, title: d.title }))
		];
		items.sort((a, b) => a.sort_order - b.sort_order);

		for (const item of items) {
			if (item.type === 'document') {
				const html = contentReader(novelId, item.id) || '';
				const plaintext = stripHtml(html);
				const wordCount = countWords(plaintext);
				result.push({
					id: item.id,
					title: item.title!,
					novelId,
					wordCount,
					plaintext,
					html
				});
			} else {
				walkSorted(item.id);
			}
		}
	}

	walkSorted(null);
	return result;
}
