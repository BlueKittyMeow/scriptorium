import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/auth.js';
import { readContentFile, stripHtml, countWords } from '$lib/server/files.js';
import { computePairDiff } from '$lib/server/compare/diff.js';

export const POST: RequestHandler = async ({ request, locals }) => {
	requireUser(locals);

	const { novelIdA, docIdA, novelIdB, docIdB } = await request.json();
	if (!novelIdA || !docIdA || !novelIdB || !docIdB) {
		throw error(400, 'novelIdA, docIdA, novelIdB, and docIdB are all required');
	}

	// Verify documents exist in DB, belong to their novels, and are not soft-deleted
	const docA = locals.db.prepare(
		'SELECT id FROM documents WHERE id = ? AND novel_id = ? AND deleted_at IS NULL'
	).get(docIdA, novelIdA);
	const docB = locals.db.prepare(
		'SELECT id FROM documents WHERE id = ? AND novel_id = ? AND deleted_at IS NULL'
	).get(docIdB, novelIdB);
	if (!docA) throw error(404, 'Document A not found');
	if (!docB) throw error(404, 'Document B not found');

	const htmlA = readContentFile(novelIdA, docIdA);
	const htmlB = readContentFile(novelIdB, docIdB);
	if (htmlA === null) throw error(404, 'Document A content not found');
	if (htmlB === null) throw error(404, 'Document B content not found');

	const plaintextA = stripHtml(htmlA);
	const plaintextB = stripHtml(htmlB);

	const pair = {
		docA: { id: docIdA, title: '', novelId: novelIdA, wordCount: countWords(plaintextA), plaintext: plaintextA, html: htmlA },
		docB: { id: docIdB, title: '', novelId: novelIdB, wordCount: countWords(plaintextB), plaintext: plaintextB, html: htmlB },
		method: 'exact_title' as const,
		similarity: 0,
		titleSimilarity: 0
	};

	const result = computePairDiff(pair, 0);

	return json({
		changes: result.changes,
		wordCountA: result.wordCountA,
		wordCountB: result.wordCountB
	});
};
