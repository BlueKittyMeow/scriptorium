import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/auth.js';
import { readContentFile } from '$lib/server/files.js';
import { collectCompareDocuments } from '$lib/server/compare/collect.js';
import { matchDocuments } from '$lib/server/compare/match.js';

export const POST: RequestHandler = async ({ request, locals }) => {
	requireUser(locals);

	const { novelIdA, novelIdB } = await request.json();
	if (!novelIdA || !novelIdB) throw error(400, 'Both novelIdA and novelIdB are required');

	const novelA = locals.db.prepare('SELECT id, title FROM novels WHERE id = ? AND deleted_at IS NULL').get(novelIdA) as { id: string; title: string } | undefined;
	const novelB = locals.db.prepare('SELECT id, title FROM novels WHERE id = ? AND deleted_at IS NULL').get(novelIdB) as { id: string; title: string } | undefined;

	if (!novelA) throw error(404, 'Novel A not found');
	if (!novelB) throw error(404, 'Novel B not found');

	const docsA = collectCompareDocuments(locals.db, novelIdA, readContentFile);
	const docsB = collectCompareDocuments(locals.db, novelIdB, readContentFile);
	const pairs = matchDocuments(docsA, docsB);

	return json({ pairs, novelA, novelB });
};
