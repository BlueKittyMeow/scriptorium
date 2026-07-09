import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireArchivist } from '$lib/server/auth.js';
import { logAction } from '$lib/server/audit.js';
import { purgeDocument, purgeFolderRecursive } from '$lib/server/tree-ops.js';
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
			// Purge every document in this novel (FTS rows, snapshot rows, files)
			const docs = locals.db.prepare('SELECT id, novel_id FROM documents WHERE novel_id = ?').all(id) as { id: string; novel_id: string }[];
			for (const doc of docs) {
				purgeDocument(locals.db, dataRoot, doc);
			}
			locals.db.prepare('DELETE FROM folders WHERE novel_id = ?').run(id);
			locals.db.prepare('DELETE FROM compile_configs WHERE novel_id = ?').run(id);
			locals.db.prepare('DELETE FROM novels WHERE id = ?').run(id);
		})();

		// Remove any remaining files on disk (whole novel dir)
		const novelDir = path.join(dataRoot, id);
		if (fs.existsSync(novelDir)) {
			fs.rmSync(novelDir, { recursive: true, force: true });
		}
	} else if (type === 'folder') {
		const row = locals.db.prepare('SELECT id FROM folders WHERE id = ? AND deleted_at IS NOT NULL').get(id);
		if (!row) throw error(404, 'Folder not found in trash');

		// Recursively purge the folder and every descendant folder/document,
		// cleaning up their FTS rows, snapshot rows, content files and snapshot dirs.
		locals.db.transaction(() => {
			purgeFolderRecursive(locals.db, dataRoot, id);
		})();
	} else if (type === 'document') {
		const row = locals.db.prepare('SELECT id, novel_id FROM documents WHERE id = ? AND deleted_at IS NOT NULL').get(id) as { id: string; novel_id: string } | undefined;
		if (!row) throw error(404, 'Document not found in trash');

		locals.db.transaction(() => {
			purgeDocument(locals.db, dataRoot, row);
		})();
	} else {
		throw error(400, 'Invalid type — must be novel, folder, or document');
	}

	logAction(locals.db, locals.user!.id, 'trash.purge', type, id);

	return json({ success: true });
};
