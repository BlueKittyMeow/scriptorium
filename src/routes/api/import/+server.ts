import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { importScriv } from '$lib/server/import/scriv.js';
import { requireUser } from '$lib/server/auth.js';
import { logAction } from '$lib/server/audit.js';
import { resolveImportPath } from '$lib/server/import/resolve-path.js';

// POST /api/import — import a .scriv directory
export const POST: RequestHandler = async ({ request, locals }) => {
	requireUser(locals);
	const body = await request.json();
	const scrivPath = body.path;

	if (!scrivPath || typeof scrivPath !== 'string' || !scrivPath.trim()) {
		throw error(400, 'Missing or invalid path');
	}

	// Same home-directory boundary as /api/import/scan and /api/import/batch (P1-6)
	const resolved = resolveImportPath(scrivPath.trim());
	if ('error' in resolved) {
		throw error(400, resolved.error);
	}

	const report = await importScriv(locals.db, resolved.resolved);

	if (report.errors.length > 0 && report.docs_imported === 0) {
		throw error(500, `Import failed: ${report.errors.join(', ')}`);
	}

	logAction(locals.db, locals.user!.id, 'import.single', 'novel', report.novel_id, `Imported "${report.novel_title}"`);

	return json(report, { status: 201 });
};
