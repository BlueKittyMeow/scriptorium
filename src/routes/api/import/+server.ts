import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { importScriv } from '$lib/server/import/scriv.js';
import { requireUser } from '$lib/server/auth.js';
import { logAction } from '$lib/server/audit.js';
import { resolveImportPath } from '$lib/server/import/resolve-path.js';

/**
 * Resolve owner_id for an import. Archivist-only assignment; the requested
 * owner must exist, otherwise the acting user owns the import.
 */
function resolveOwnerId(locals: App.Locals, requested: unknown): string {
	const self = locals.user!.id;
	if (locals.user!.role !== 'archivist') return self;
	if (typeof requested !== 'string' || !requested) return self;
	const exists = locals.db.prepare('SELECT id FROM users WHERE id = ?').get(requested);
	return exists ? requested : self;
}

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

	// Ownership tagging (§C.1 first slice): archivists may assign the imported
	// novel to another user; everyone else owns what they import. importScriv
	// doesn't set an owner, so we apply it here on the created novel row.
	// NOTE: no permission enforcement rides on owner_id yet.
	if (report.novel_id) {
		const ownerId = resolveOwnerId(locals, body.owner_id);
		locals.db.prepare('UPDATE novels SET owner_id = ? WHERE id = ?').run(ownerId, report.novel_id);
	}

	logAction(locals.db, locals.user!.id, 'import.single', 'novel', report.novel_id, `Imported "${report.novel_title}"`);

	return json(report, { status: 201 });
};
