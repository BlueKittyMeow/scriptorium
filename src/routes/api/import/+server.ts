import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { existsSync } from 'fs';
import { importScriv } from '$lib/server/import/scriv.js';
import { requireUser } from '$lib/server/auth.js';

// POST /api/import — import a .scriv directory
export const POST: RequestHandler = async ({ request, locals }) => {
	requireUser(locals);
	const body = await request.json();
	const scrivPath = body.path;

	if (!scrivPath || typeof scrivPath !== 'string') {
		throw error(400, 'Missing or invalid path');
	}

	if (!existsSync(scrivPath)) {
		throw error(400, `Path does not exist: ${scrivPath}`);
	}

	const report = await importScriv(locals.db, scrivPath);

	if (report.errors.length > 0 && report.docs_imported === 0) {
		throw error(500, `Import failed: ${report.errors.join(', ')}`);
	}

	return json(report, { status: 201 });
};
