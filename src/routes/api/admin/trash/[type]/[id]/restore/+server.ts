import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireArchivist } from '$lib/server/auth.js';
import { logAction } from '$lib/server/audit.js';

// POST /api/admin/trash/:type/:id/restore — restore a soft-deleted item
export const POST: RequestHandler = async ({ params, locals }) => {
	requireArchivist(locals);

	const { type, id } = params;
	const now = new Date().toISOString();

	if (type === 'novel') {
		const row = locals.db.prepare('SELECT id FROM novels WHERE id = ? AND deleted_at IS NOT NULL').get(id);
		if (!row) throw error(404, 'Novel not found in trash');
		locals.db.prepare('UPDATE novels SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(now, id);
	} else if (type === 'folder') {
		const row = locals.db.prepare('SELECT id FROM folders WHERE id = ? AND deleted_at IS NOT NULL').get(id);
		if (!row) throw error(404, 'Folder not found in trash');
		locals.db.prepare('UPDATE folders SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(now, id);
	} else if (type === 'document') {
		const row = locals.db.prepare('SELECT id, novel_id, title FROM documents WHERE id = ? AND deleted_at IS NOT NULL').get(id) as { id: string; novel_id: string; title: string } | undefined;
		if (!row) throw error(404, 'Document not found in trash');
		locals.db.prepare('UPDATE documents SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(now, id);

		// Re-index in FTS5
		const contentPath = `data/${row.novel_id}/docs/${id}.html`;
		let content = '';
		try {
			const fs = await import('fs');
			content = fs.readFileSync(contentPath, 'utf-8');
		} catch { /* no content file — index with empty content */ }
		locals.db.prepare('INSERT INTO documents_fts (doc_id, title, content) VALUES (?, ?, ?)').run(id, row.title, content);
	} else {
		throw error(400, 'Invalid type — must be novel, folder, or document');
	}

	logAction(locals.db, locals.user!.id, 'trash.restore', type, id);

	return json({ success: true });
};
