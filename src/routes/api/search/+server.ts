import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// GET /api/search?q=...&novel=...
export const GET: RequestHandler = async ({ url, locals }) => {
	const query = url.searchParams.get('q');
	if (!query || !query.trim()) return json([]);

	const novelId = url.searchParams.get('novel');

	// Build a prefix-aware FTS5 query: each word gets a trailing * for partial matching
	// e.g. "hel wor" → "hel"* "wor"* (matches "hello world")
	const tokens = query.trim().split(/\s+/).filter(Boolean);
	const ftsQuery = tokens.map(t => `"${t.replace(/"/g, '""')}"*`).join(' ');

	// FTS5 query with snippet generation
	const sql = `
		SELECT
			fts.doc_id as id,
			d.title,
			d.novel_id,
			d.parent_id,
			d.word_count,
			n.title as novel_title,
			snippet(documents_fts, 2, '<mark>', '</mark>', '...', 32) as snippet
		FROM documents_fts fts
		JOIN documents d ON d.id = fts.doc_id
		JOIN novels n ON n.id = d.novel_id
		WHERE documents_fts MATCH ?
			${novelId ? 'AND d.novel_id = ?' : ''}
			AND d.deleted_at IS NULL
		ORDER BY rank
		LIMIT 50
	`;
	const sqlParams = novelId ? [ftsQuery, novelId] : [ftsQuery];

	try {
		const results = locals.db.prepare(sql).all(...sqlParams);
		return json(results);
	} catch {
		return json([]);
	}
};
