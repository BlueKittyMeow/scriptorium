import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireArchivist } from '$lib/server/auth.js';
import { logAction } from '$lib/server/audit.js';
import { reindexDocFts, hasBrokenAncestorChain } from '$lib/server/tree-ops.js';
import { readContentFile, stripHtml } from '$lib/server/files.js';

// POST /api/admin/trash/:type/:id/restore — restore a soft-deleted item
export const POST: RequestHandler = async ({ params, locals }) => {
	requireArchivist(locals);

	const { type, id } = params;
	const now = new Date().toISOString();

	if (type === 'novel') {
		const row = locals.db
			.prepare('SELECT id, deleted_at FROM novels WHERE id = ? AND deleted_at IS NOT NULL')
			.get(id) as { id: string; deleted_at: string } | undefined;
		if (!row) throw error(404, 'Novel not found in trash');

		const novelDeletedAt = row.deleted_at;
		// Timestamp-matched cascade restore: only folders/documents that were
		// trashed *by* the novel deletion (same deleted_at) come back. Items
		// individually trashed earlier keep their own earlier deleted_at.
		locals.db.transaction(() => {
			locals.db.prepare('UPDATE novels SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(now, id);
			locals.db
				.prepare('UPDATE folders SET deleted_at = NULL, updated_at = ? WHERE novel_id = ? AND deleted_at = ?')
				.run(now, id, novelDeletedAt);
			const restoredDocs = locals.db
				.prepare('SELECT id, title, novel_id FROM documents WHERE novel_id = ? AND deleted_at = ?')
				.all(id, novelDeletedAt) as { id: string; title: string; novel_id: string }[];
			locals.db
				.prepare('UPDATE documents SET deleted_at = NULL, updated_at = ? WHERE novel_id = ? AND deleted_at = ?')
				.run(now, id, novelDeletedAt);
			for (const doc of restoredDocs) {
				reindexDocFts(locals.db, doc, readContentFile, stripHtml);
			}
		})();
	} else if (type === 'folder') {
		const row = locals.db
			.prepare('SELECT id, parent_id FROM folders WHERE id = ? AND deleted_at IS NOT NULL')
			.get(id) as { id: string; parent_id: string | null } | undefined;
		if (!row) throw error(404, 'Folder not found in trash');
		locals.db.prepare('UPDATE folders SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(now, id);
		// Re-root if an ancestor is still trashed/missing, so it doesn't vanish.
		if (hasBrokenAncestorChain(locals.db, row.parent_id)) {
			locals.db.prepare('UPDATE folders SET parent_id = NULL, updated_at = ? WHERE id = ?').run(now, id);
		}
	} else if (type === 'document') {
		const row = locals.db
			.prepare('SELECT id, novel_id, title, parent_id FROM documents WHERE id = ? AND deleted_at IS NOT NULL')
			.get(id) as { id: string; novel_id: string; title: string; parent_id: string | null } | undefined;
		if (!row) throw error(404, 'Document not found in trash');
		locals.db.prepare('UPDATE documents SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(now, id);

		// Re-index in FTS5 via the shared helper (DATA_ROOT-aware, strips HTML,
		// delete-then-insert so repeated restores don't duplicate rows).
		reindexDocFts(locals.db, { id: row.id, title: row.title, novel_id: row.novel_id }, readContentFile, stripHtml);

		// Re-root if an ancestor folder is still trashed/missing.
		if (hasBrokenAncestorChain(locals.db, row.parent_id)) {
			locals.db.prepare('UPDATE documents SET parent_id = NULL, updated_at = ? WHERE id = ?').run(now, id);
		}
	} else {
		throw error(400, 'Invalid type — must be novel, folder, or document');
	}

	logAction(locals.db, locals.user!.id, 'trash.restore', type, id);

	return json({ success: true });
};
