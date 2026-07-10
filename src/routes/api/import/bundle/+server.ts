import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/auth.js';
import { resolveOwnerId } from '$lib/server/import/owner.js';
import { resolveImportPath } from '$lib/server/import/resolve-path.js';
import { importBundle } from '$lib/server/import/bundle.js';

// POST /api/import/bundle — import a curated bundle (W5b Unit B)
export const POST: RequestHandler = async ({ request, locals }) => {
	requireUser(locals);
	const body = await request.json();

	const inputPath = body?.path;
	if (typeof inputPath !== 'string' || !inputPath.trim()) {
		throw error(400, 'Missing bundle path');
	}

	// Ownership tagging (§C.1 first slice): archivist-only assignment, writers
	// own their imports. Shared with the .scriv batch import.
	const ownerId = resolveOwnerId(locals, body?.owner_id);

	// Same realpath + home-directory boundary as the .scriv import endpoints.
	const resolved = resolveImportPath(inputPath.trim());
	if ('error' in resolved) {
		throw error(400, resolved.error);
	}

	const dryRun = body?.dry_run === true;

	// validateBundleManifest (inside importBundle) throws 400 for a malformed
	// bundle; per-work failures surface as errors in the returned reports.
	const results = importBundle(locals.db, resolved.resolved, ownerId, { dryRun });

	return json(results);
};
