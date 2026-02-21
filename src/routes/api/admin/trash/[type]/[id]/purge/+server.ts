import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireArchivist } from '$lib/server/auth.js';
import { logAction } from '$lib/server/audit.js';
import fs from 'fs';
import path from 'path';
import { getDataRoot } from '$lib/server/db.js';

// DELETE /api/admin/trash/:type/:id/purge — permanently delete
export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireArchivist(locals);

	const { type, id } = params;
	const dataRoot = getDataRoot();

	if (type === 'novel') {
		const row = locals.db.prepare('SELECT id FROM novels WHERE id = ? AND deleted_at IS NOT NULL').get(id);
		if (!row) throw error(404, 'Novel not found in trash');

		locals.db.transaction(() => {
			// Delete FTS entries for all documents in this novel
			const docs = locals.db.prepare('SELECT id FROM documents WHERE novel_id = ?').all() as { id: string }[];
			for (const doc of docs) {
				locals.db.prepare('DELETE FROM documents_fts WHERE doc_id = ?').run(doc.id);
				locals.db.prepare('DELETE FROM snapshots WHERE document_id = ?').run(doc.id);
			}
			locals.db.prepare('DELETE FROM documents WHERE novel_id = ?').run(id);
			locals.db.prepare('DELETE FROM folders WHERE novel_id = ?').run(id);
			locals.db.prepare('DELETE FROM compile_configs WHERE novel_id = ?').run(id);
			locals.db.prepare('DELETE FROM novels WHERE id = ?').run(id);
		})();

		// Remove files on disk
		const novelDir = path.join(dataRoot, id);
		if (fs.existsSync(novelDir)) {
			fs.rmSync(novelDir, { recursive: true, force: true });
		}
	} else if (type === 'folder') {
		const row = locals.db.prepare('SELECT id FROM folders WHERE id = ? AND deleted_at IS NOT NULL').get(id);
		if (!row) throw error(404, 'Folder not found in trash');
		locals.db.prepare('DELETE FROM folders WHERE id = ?').run(id);
	} else if (type === 'document') {
		const row = locals.db.prepare('SELECT id, novel_id FROM documents WHERE id = ? AND deleted_at IS NOT NULL').get(id) as { id: string; novel_id: string } | undefined;
		if (!row) throw error(404, 'Document not found in trash');

		locals.db.transaction(() => {
			locals.db.prepare('DELETE FROM documents_fts WHERE doc_id = ?').run(id);
			locals.db.prepare('DELETE FROM snapshots WHERE document_id = ?').run(id);
			locals.db.prepare('DELETE FROM documents WHERE id = ?').run(id);
		})();

		// Remove content file and snapshots
		const docFile = path.join(dataRoot, row.novel_id, 'docs', `${id}.html`);
		if (fs.existsSync(docFile)) fs.unlinkSync(docFile);
		const snapDir = path.join(dataRoot, row.novel_id, 'snapshots', id);
		if (fs.existsSync(snapDir)) fs.rmSync(snapDir, { recursive: true, force: true });
	} else {
		throw error(400, 'Invalid type — must be novel, folder, or document');
	}

	logAction(locals.db, locals.user!.id, 'trash.purge', type, id);

	return json({ success: true });
};
