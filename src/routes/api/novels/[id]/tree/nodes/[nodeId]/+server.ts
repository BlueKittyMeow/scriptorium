import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// DELETE /api/novels/:id/tree/nodes/:nodeId — soft-delete
export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	const now = new Date().toISOString();
	const url = new URL(request.url);
	const nodeType = url.searchParams.get('type') || 'document';

	if (nodeType === 'folder') {
		const folder = locals.db.prepare('SELECT * FROM folders WHERE id = ? AND novel_id = ? AND deleted_at IS NULL').get(params.nodeId, params.id);
		if (!folder) throw error(404, 'Folder not found');

		const cascadeDelete = locals.db.transaction(() => {
			// Soft-delete the folder
			locals.db.prepare('UPDATE folders SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, params.nodeId);

			// Cascade to children (recursive via all descendants)
			cascadeDeleteChildren(locals.db, params.nodeId, now);
		});
		cascadeDelete();
	} else {
		const doc = locals.db.prepare('SELECT * FROM documents WHERE id = ? AND novel_id = ? AND deleted_at IS NULL').get(params.nodeId, params.id);
		if (!doc) throw error(404, 'Document not found');

		locals.db.prepare('UPDATE documents SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, params.nodeId);
		// Remove from FTS
		locals.db.prepare('DELETE FROM documents_fts WHERE doc_id = ?').run(params.nodeId);
	}

	return json({ success: true });
};

// PATCH — rename or restore a node
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	const body = await request.json();
	const now = new Date().toISOString();
	const nodeType = body.type || 'document';

	// Restore from trash
	if (body.restore) {
		if (nodeType === 'folder') {
			locals.db.prepare('UPDATE folders SET deleted_at = NULL, updated_at = ? WHERE id = ? AND novel_id = ?')
				.run(now, params.nodeId, params.id);
			// Restore child documents' FTS entries
			restoreChildFts(locals.db, params.nodeId);
		} else {
			const doc = locals.db.prepare('SELECT * FROM documents WHERE id = ?').get(params.nodeId) as any;
			locals.db.prepare('UPDATE documents SET deleted_at = NULL, updated_at = ? WHERE id = ? AND novel_id = ?')
				.run(now, params.nodeId, params.id);
			// Re-index in FTS
			if (doc) {
				const { readContentFile, stripHtml } = await import('$lib/server/files.js');
				const content = readContentFile(doc.novel_id, doc.id) || '';
				const plainText = stripHtml(content);
				locals.db.prepare('DELETE FROM documents_fts WHERE doc_id = ?').run(doc.id);
				locals.db.prepare('INSERT INTO documents_fts (doc_id, title, content) VALUES (?, ?, ?)').run(doc.id, doc.title, plainText);
			}
		}
		return json({ success: true });
	}

	// Rename
	if (body.title) {
		if (nodeType === 'folder') {
			locals.db.prepare('UPDATE folders SET title = ?, updated_at = ? WHERE id = ? AND novel_id = ?')
				.run(body.title, now, params.nodeId, params.id);
		} else {
			locals.db.prepare('UPDATE documents SET title = ?, updated_at = ? WHERE id = ? AND novel_id = ?')
				.run(body.title, now, params.nodeId, params.id);
			locals.db.prepare('UPDATE documents_fts SET title = ? WHERE doc_id = ?')
				.run(body.title, params.nodeId);
		}
	}

	return json({ success: true });
};

function restoreChildFts(db: any, folderId: string) {
	// This is a simplified restore — full restore would re-read files and re-index
	const childDocs = db.prepare('SELECT id, title, novel_id FROM documents WHERE parent_id = ? AND deleted_at IS NOT NULL').all(folderId) as any[];
	for (const doc of childDocs) {
		db.prepare('UPDATE documents SET deleted_at = NULL WHERE id = ?').run(doc.id);
	}
	const childFolders = db.prepare('SELECT id FROM folders WHERE parent_id = ? AND deleted_at IS NOT NULL').all(folderId) as any[];
	for (const folder of childFolders) {
		db.prepare('UPDATE folders SET deleted_at = NULL WHERE id = ?').run(folder.id);
		restoreChildFts(db, folder.id);
	}
}

function cascadeDeleteChildren(db: any, folderId: string, now: string) {
	// Delete child documents
	const childDocs = db.prepare('SELECT id FROM documents WHERE parent_id = ? AND deleted_at IS NULL').all(folderId) as { id: string }[];
	for (const doc of childDocs) {
		db.prepare('UPDATE documents SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, doc.id);
		db.prepare('DELETE FROM documents_fts WHERE doc_id = ?').run(doc.id);
	}

	// Delete child folders and recurse
	const childFolders = db.prepare('SELECT id FROM folders WHERE parent_id = ? AND deleted_at IS NULL').all(folderId) as { id: string }[];
	for (const folder of childFolders) {
		db.prepare('UPDATE folders SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, folder.id);
		cascadeDeleteChildren(db, folder.id, now);
	}
}
