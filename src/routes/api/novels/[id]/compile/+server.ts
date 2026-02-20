import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { collectCompileDocuments } from '$lib/server/compile/tree-walk.js';
import { assembleCompileHtml } from '$lib/server/compile/assemble.js';
import { convertHtmlToFormat, checkPandocAvailable } from '$lib/server/compile/pandoc.js';
import { readContentFile } from '$lib/server/files.js';
import { VALID_FORMATS, FORMAT_CONFIG } from '$lib/server/compile/types.js';
import type { CompileFormat } from '$lib/server/compile/types.js';

// POST /api/novels/:id/compile — compile and download
export const POST: RequestHandler = async ({ params, request, locals }) => {
	const novel = locals.db.prepare('SELECT * FROM novels WHERE id = ? AND deleted_at IS NULL').get(params.id) as any;
	if (!novel) throw error(404, 'Novel not found');

	const body = await request.json();
	const format = body.format as CompileFormat;

	if (!format || !VALID_FORMATS.includes(format)) {
		throw error(400, `Invalid format. Must be one of: ${VALID_FORMATS.join(', ')}`);
	}

	// Load include_ids from config if provided
	let includeIds: string[] | undefined;
	if (body.configId) {
		const config = locals.db.prepare('SELECT * FROM compile_configs WHERE id = ? AND novel_id = ?').get(body.configId, params.id) as any;
		if (!config) throw error(404, 'Compile config not found');
		if (config.include_ids) {
			includeIds = JSON.parse(config.include_ids);
		}
	}

	// Collect documents in tree order
	const documents = collectCompileDocuments(locals.db, params.id, includeIds);

	// Assemble HTML
	const metadata = { title: novel.title, subtitle: novel.subtitle };
	const html = assembleCompileHtml(documents, metadata, readContentFile);

	// Check Pandoc availability
	const pandocOk = await checkPandocAvailable();
	if (!pandocOk) {
		throw error(500, 'Pandoc is not installed or not available on the system PATH');
	}

	// Convert
	const result = await convertHtmlToFormat(html, format, metadata);
	const config = FORMAT_CONFIG[format];

	// Sanitize filename
	const safeTitle = novel.title.replace(/[^a-zA-Z0-9_-]/g, '_');

	return new Response(result.buffer, {
		headers: {
			'Content-Type': result.mimeType,
			'Content-Disposition': `attachment; filename="${safeTitle}.${config.extension}"`
		}
	});
};
