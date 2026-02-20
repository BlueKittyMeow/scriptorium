import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// GET /api/search?q=...&novel=...
export const GET: RequestHandler = async ({ url, locals }) => {
	const query = url.searchParams.get('q');
	if (!query || !query.trim()) return json([]);

	const novelId = url.searchParams.get('novel');

	// FTS5 query with snippet generation
	let sql: string;
	let sqlParams: any[];

	if (novelId) {
		sql = `
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
				AND d.novel_id = ?
				AND d.deleted_at IS NULL
			ORDER BY rank
			LIMIT 50
		`;
		sqlParams = [query, novelId];
	} else {
		sql = `
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
				AND d.deleted_at IS NULL
			ORDER BY rank
			LIMIT 50
		`;
		sqlParams = [query];
	}

	try {
		const results = locals.db.prepare(sql).all(...sqlParams);
		return json(results);
	} catch {
		// FTS5 syntax error — try as simple prefix search
		try {
			const prefixQuery = query.split(/\s+/).map(t => `"${t}"*`).join(' ');
			const results = locals.db.prepare(sql).all(...(novelId ? [prefixQuery, novelId] : [prefixQuery]));
			return json(results);
		} catch {
			return json([]);
		}
	}
};
