import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { realpathSync, statSync } from 'fs';
import os from 'os';
import { scanForScrivProjects } from '$lib/server/import/scan.js';

// POST /api/admin/import/scan — scan a directory for .scriv bundles
export const POST: RequestHandler = async ({ request, locals }) => {
	const body = await request.json();
	const inputPath = typeof body.path === 'string' ? body.path.trim() : body.path;

	if (!inputPath || typeof inputPath !== 'string') {
		throw error(400, 'Missing or invalid path');
	}

	// Expand tilde — Node.js doesn't do shell-style ~ expansion
	const homeDir = os.homedir();
	const expandedPath = inputPath.replace(/^~(?=$|\/)/, homeDir);

	// Resolve symlinks and normalize the path
	let resolvedPath: string;
	try {
		resolvedPath = realpathSync(expandedPath);
	} catch {
		throw error(400, `Path does not exist: ${expandedPath}`);
	}

	// Safe root boundary: must be under user's home directory
	// Use homeDir + '/' to prevent prefix bypass (/home/user matching /home/user2)
	if (resolvedPath !== homeDir && !resolvedPath.startsWith(homeDir + '/')) {
		throw error(400, 'Scan path must be within your home directory');
	}

	// Must be a directory
	try {
		const stat = statSync(resolvedPath);
		if (!stat.isDirectory()) {
			throw error(400, 'Path is not a directory');
		}
	} catch (err: any) {
		if (err.status) throw err; // re-throw SvelteKit errors
		throw error(400, `Cannot access path: ${inputPath}`);
	}

	// Scan for .scriv projects
	const found = await scanForScrivProjects(resolvedPath);

	if (found.length === 0) {
		throw error(400, 'No .scriv projects found in this directory');
	}

	// Cross-reference with existing novels for duplicate detection
	const existingNovels = locals.db.prepare(
		'SELECT title FROM novels WHERE deleted_at IS NULL'
	).all() as { title: string }[];
	const existingTitles = new Set(existingNovels.map(n => n.title));

	const projects = found.map(p => ({
		path: p.path,
		name: p.name,
		existingNovelTitle: existingTitles.has(p.name) ? p.name : null
	}));

	return json({
		directory: resolvedPath,
		projects
	});
};
