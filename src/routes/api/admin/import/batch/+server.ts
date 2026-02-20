import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { existsSync, statSync } from 'fs';
import { importScriv } from '$lib/server/import/scriv.js';
import type { ImportReport } from '$lib/types.js';

// POST /api/admin/import/batch — import multiple .scriv projects
export const POST: RequestHandler = async ({ request, locals }) => {
	const body = await request.json();
	const paths = body.paths;

	if (!Array.isArray(paths) || paths.length === 0) {
		throw error(400, 'Missing or empty paths array');
	}

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

		// Per-path validation: exists and is a directory
		if (!existsSync(scrivPath)) {
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

		try {
			const stat = statSync(scrivPath);
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
			const report = await importScriv(locals.db, scrivPath);
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

	// Build summary
	const succeeded = results.filter(r => r.errors.length === 0);
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
