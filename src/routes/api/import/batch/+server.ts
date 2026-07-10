import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { realpathSync, statSync } from 'fs';
import os from 'os';
import { importScriv } from '$lib/server/import/scriv.js';
import type { ImportReport } from '$lib/types.js';
import { requireUser } from '$lib/server/auth.js';

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

// POST /api/import/batch — import multiple .scriv projects
export const POST: RequestHandler = async ({ request, locals }) => {
	requireUser(locals);
	const body = await request.json();
	const paths = body.paths;

	if (!Array.isArray(paths) || paths.length === 0) {
		throw error(400, 'Missing or empty paths array');
	}

	// Ownership tagging (§C.1 first slice): one owner applies to every novel
	// created in this batch. Archivist-only assignment; writers own their
	// imports. NOTE: no permission enforcement rides on owner_id yet.
	const ownerId = resolveOwnerId(locals, body.owner_id);

	const homeDir = os.homedir();
	const results: (ImportReport & { path: string })[] = [];

	for (const scrivPath of paths) {
		if (typeof scrivPath !== 'string' || !scrivPath.trim()) {
			results.push({
				path: scrivPath || '',
				novel_id: '',
				novel_title: '',
				docs_imported: 0,
				folders_created: 0,
				files_skipped: 0,
				total_word_count: 0,
				errors: ['Invalid path'],
				warnings: []
			});
			continue;
		}

		// Expand tilde — Node.js doesn't do shell-style ~ expansion
		const expanded = scrivPath.replace(/^~(?=$|\/)/, homeDir);

		// Safe root boundary: must be under user's home directory
		let resolved: string;
		try {
			resolved = realpathSync(expanded);
		} catch {
			results.push({
				path: scrivPath,
				novel_id: '',
				novel_title: '',
				docs_imported: 0,
				folders_created: 0,
				files_skipped: 0,
				total_word_count: 0,
				errors: ['Path does not exist'],
				warnings: []
			});
			continue;
		}

		// Use homeDir + '/' to prevent prefix bypass (/home/user matching /home/user2)
		if (resolved !== homeDir && !resolved.startsWith(homeDir + '/')) {
			results.push({
				path: scrivPath,
				novel_id: '',
				novel_title: '',
				docs_imported: 0,
				folders_created: 0,
				files_skipped: 0,
				total_word_count: 0,
				errors: ['Path must be within your home directory'],
				warnings: []
			});
			continue;
		}

		// Per-path validation: must be a directory
		// (realpathSync above already confirmed the path exists)
		try {
			const stat = statSync(resolved);
			if (!stat.isDirectory()) {
				results.push({
					path: scrivPath,
					novel_id: '',
					novel_title: '',
					docs_imported: 0,
					folders_created: 0,
					files_skipped: 0,
					total_word_count: 0,
					errors: ['Path is not a directory'],
					warnings: []
				});
				continue;
			}
		} catch {
			results.push({
				path: scrivPath,
				novel_id: '',
				novel_title: '',
				docs_imported: 0,
				folders_created: 0,
				files_skipped: 0,
				total_word_count: 0,
				errors: ['Cannot access path'],
				warnings: []
			});
			continue;
		}

		// Import with error isolation — one failure never aborts the batch
		try {
			const report = await importScriv(locals.db, resolved);
			// Apply ownership on the created novel (importScriv doesn't set it).
			if (report.novel_id) {
				locals.db.prepare('UPDATE novels SET owner_id = ? WHERE id = ?').run(ownerId, report.novel_id);
			}
			results.push({ ...report, path: scrivPath });
		} catch (err: any) {
			results.push({
				path: scrivPath,
				novel_id: '',
				novel_title: '',
				docs_imported: 0,
				folders_created: 0,
				files_skipped: 0,
				total_word_count: 0,
				errors: [err.message || 'Import failed'],
				warnings: []
			});
		}
	}

	// Build summary — count by novel_id presence, not errors.length,
	// so partial successes (docs imported but some RTF errors) count as succeeded
	const succeeded = results.filter(r => r.novel_id !== '');
	const summary = {
		total: results.length,
		succeeded: succeeded.length,
		failed: results.length - succeeded.length,
		total_docs: results.reduce((sum, r) => sum + r.docs_imported, 0),
		total_folders: results.reduce((sum, r) => sum + r.folders_created, 0),
		total_words: results.reduce((sum, r) => sum + r.total_word_count, 0)
	};

	return json({ results, summary });
};
