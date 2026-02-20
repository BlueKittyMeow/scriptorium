import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { collectCompileDocuments } from '$lib/server/compile/tree-walk.js';
import { assembleCompileHtml } from '$lib/server/compile/assemble.js';
import { readContentFile } from '$lib/server/files.js';

// GET /api/novels/:id/compile/preview — HTML preview (no Pandoc needed)
export const GET: RequestHandler = async ({ params, url, locals }) => {
	const novel = locals.db.prepare('SELECT * FROM novels WHERE id = ? AND deleted_at IS NULL').get(params.id) as any;
	if (!novel) throw error(404, 'Novel not found');

	// Optional: load include_ids from config
	let includeIds: string[] | undefined;
	const configId = url.searchParams.get('configId');
	if (configId) {
		const config = locals.db.prepare('SELECT * FROM compile_configs WHERE id = ? AND novel_id = ?').get(configId, params.id) as any;
		if (config?.include_ids) {
			includeIds = JSON.parse(config.include_ids);
		}
	}

	const documents = collectCompileDocuments(locals.db, params.id, includeIds);
	const metadata = { title: novel.title, subtitle: novel.subtitle };
	const html = assembleCompileHtml(documents, metadata, readContentFile);

	return new Response(html, {
		headers: {
			'Content-Type': 'text/html; charset=utf-8'
		}
	});
};
