import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { cascadeDeleteChildren, restoreChildFts, reindexDocFts } from '$lib/server/tree-ops.js';

// DELETE /api/novels/:id/tree/nodes/:nodeId — soft-delete
export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	const now = new Date().toISOString();
	const url = new URL(request.url);
	const nodeType = url.searchParams.get('type') || 'document';

	if (nodeType === 'folder') {
		const folder = locals.db.prepare('SELECT * FROM folders WHERE id = ? AND novel_id = ? AND deleted_at IS NULL').get(params.nodeId, params.id);
		if (!folder) throw error(404, 'Folder not found');

		const doCascade = locals.db.transaction(() => {
			locals.db.prepare('UPDATE folders SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, params.nodeId);
			cascadeDeleteChildren(locals.db, params.nodeId, now);
		});
		doCascade();
	} else {
		const doc = locals.db.prepare('SELECT * FROM documents WHERE id = ? AND novel_id = ? AND deleted_at IS NULL').get(params.nodeId, params.id);
		if (!doc) throw error(404, 'Document not found');

		locals.db.prepare('UPDATE documents SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, params.nodeId);
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
		const { readContentFile, stripHtml } = await import('$lib/server/files.js');

		if (nodeType === 'folder') {
			locals.db.prepare('UPDATE folders SET deleted_at = NULL, updated_at = ? WHERE id = ? AND novel_id = ?')
				.run(now, params.nodeId, params.id);
			restoreChildFts(locals.db, params.nodeId, now, readContentFile, stripHtml);
		} else {
			const doc = locals.db.prepare('SELECT * FROM documents WHERE id = ?').get(params.nodeId) as any;
			locals.db.prepare('UPDATE documents SET deleted_at = NULL, updated_at = ? WHERE id = ? AND novel_id = ?')
				.run(now, params.nodeId, params.id);
			if (doc) {
				reindexDocFts(locals.db, doc, readContentFile, stripHtml);
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
