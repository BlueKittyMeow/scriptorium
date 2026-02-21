import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireArchivist } from '$lib/server/auth.js';
import fs from 'fs';
import path from 'path';
import { getDataRoot } from '$lib/server/db.js';

function getDirSize(dirPath: string): number {
	let size = 0;
	try {
		const entries = fs.readdirSync(dirPath, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(dirPath, entry.name);
			if (entry.isDirectory()) {
				size += getDirSize(fullPath);
			} else {
				try {
					size += fs.statSync(fullPath).size;
				} catch { /* skip inaccessible files */ }
			}
		}
	} catch { /* directory doesn't exist */ }
	return size;
}

// GET /api/admin/storage — storage metrics
export const GET: RequestHandler = async ({ locals }) => {
	requireArchivist(locals);

	const dataRoot = getDataRoot();

	const novelCount = (locals.db.prepare('SELECT COUNT(*) as c FROM novels WHERE deleted_at IS NULL').get() as { c: number }).c;
	const documentCount = (locals.db.prepare('SELECT COUNT(*) as c FROM documents WHERE deleted_at IS NULL').get() as { c: number }).c;
	const snapshotCount = (locals.db.prepare('SELECT COUNT(*) as c FROM snapshots').get() as { c: number }).c;

	const totalDiskUsage = getDirSize(dataRoot);

	// Per-novel snapshot counts
	const novelSnapshots = locals.db.prepare(
		`SELECT n.id, n.title, COUNT(s.id) as snapshot_count
		 FROM novels n
		 LEFT JOIN documents d ON d.novel_id = n.id
		 LEFT JOIN snapshots s ON s.document_id = d.id
		 WHERE n.deleted_at IS NULL
		 GROUP BY n.id
		 ORDER BY n.title`
	).all();

	return json({
		novelCount,
		documentCount,
		snapshotCount,
		totalDiskUsage,
		novelSnapshots
	});
};
