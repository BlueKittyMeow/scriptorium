import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { cascadeDeleteChildren, restoreChildFts, reindexDocFts, hasBrokenAncestorChain } from '$lib/server/tree-ops.js';
import { requireUser } from '$lib/server/auth.js';

// DELETE /api/novels/:id/tree/nodes/:nodeId — soft-delete
export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals);
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
	requireUser(locals);
	const body = await request.json();
	const now = new Date().toISOString();
	const nodeType = body.type || 'document';

	// Restore from trash
	if (body.restore) {
		const { readContentFile, stripHtml } = await import('$lib/server/files.js');

		if (nodeType === 'folder') {
			const folder = locals.db
				.prepare('SELECT id, parent_id FROM folders WHERE id = ? AND novel_id = ?')
				.get(params.nodeId, params.id) as { id: string; parent_id: string | null } | undefined;
			locals.db.prepare('UPDATE folders SET deleted_at = NULL, updated_at = ? WHERE id = ? AND novel_id = ?')
				.run(now, params.nodeId, params.id);
			restoreChildFts(locals.db, params.nodeId, now, readContentFile, stripHtml);
			// Re-root if an ancestor folder is still trashed/missing, so the
			// restored node doesn't become unreachable in the binder.
			if (folder && hasBrokenAncestorChain(locals.db, folder.parent_id)) {
				locals.db.prepare('UPDATE folders SET parent_id = NULL, updated_at = ? WHERE id = ?').run(now, params.nodeId);
			}
		} else {
			const doc = locals.db.prepare('SELECT * FROM documents WHERE id = ?').get(params.nodeId) as any;
			locals.db.prepare('UPDATE documents SET deleted_at = NULL, updated_at = ? WHERE id = ? AND novel_id = ?')
				.run(now, params.nodeId, params.id);
			if (doc) {
				reindexDocFts(locals.db, doc, readContentFile, stripHtml);
				// Re-root if an ancestor folder is still trashed/missing.
				if (hasBrokenAncestorChain(locals.db, doc.parent_id)) {
					locals.db.prepare('UPDATE documents SET parent_id = NULL, updated_at = ? WHERE id = ?').run(now, params.nodeId);
				}
			}
		}
		return json({ success: true });
	}

	// Toggle compile_include
	if (body.compile_include !== undefined && nodeType === 'document') {
		locals.db.prepare('UPDATE documents SET compile_include = ?, updated_at = ? WHERE id = ? AND novel_id = ?')
			.run(body.compile_include ? 1 : 0, now, params.nodeId, params.id);
	}

	// Rename
	if (body.title !== undefined) {
		const trimmedTitle = typeof body.title === 'string' ? body.title.trim() : '';
		if (!trimmedTitle) throw error(400, 'Title cannot be empty');

		if (nodeType === 'folder') {
			const folder = locals.db.prepare('SELECT * FROM folders WHERE id = ? AND novel_id = ? AND deleted_at IS NULL').get(params.nodeId, params.id);
			if (!folder) throw error(404, 'Folder not found');

			locals.db.prepare('UPDATE folders SET title = ?, updated_at = ? WHERE id = ? AND novel_id = ?')
				.run(trimmedTitle, now, params.nodeId, params.id);
		} else {
			const doc = locals.db.prepare('SELECT * FROM documents WHERE id = ? AND novel_id = ? AND deleted_at IS NULL').get(params.nodeId, params.id);
			if (!doc) throw error(404, 'Document not found');

			locals.db.prepare('UPDATE documents SET title = ?, updated_at = ? WHERE id = ? AND novel_id = ?')
				.run(trimmedTitle, now, params.nodeId, params.id);
			locals.db.prepare('UPDATE documents_fts SET title = ? WHERE doc_id = ?')
				.run(trimmedTitle, params.nodeId);
		}
	}

	return json({ success: true });
};
